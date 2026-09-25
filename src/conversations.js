const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const MAX_CONVERSATION_BYTES = 64 * 1024 * 1024;
const validId = id => typeof id === 'string' && /^conversation-[a-z0-9-]{8,120}$/i.test(id);
function inside(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function resolveConversationDirectory(app, manifest = {}) {
  const adapter = app?.vault?.adapter;
  const baseValue = typeof adapter?.getBasePath === 'function' ? adapter.getBasePath() : adapter?.basePath;
  if (typeof baseValue !== 'string' || !baseValue.trim()) throw Error('无法确定笔记库本地路径，不能保存对话文件');
  const vault = path.resolve(baseValue);
  const configDir = typeof app?.vault?.configDir === 'string' && app.vault.configDir ? app.vault.configDir : '.obsidian';
  const relativePlugin = typeof manifest.dir === 'string' && manifest.dir ? manifest.dir : path.join(configDir, 'plugins', manifest.id || 'simple-deepseek');
  if (path.isAbsolute(relativePlugin)) throw Error('插件目录必须位于当前笔记库内');
  const plugin = path.resolve(vault, relativePlugin);
  if (!inside(vault, plugin)) throw Error('插件目录超出当前笔记库');
  return path.join(plugin, 'conversations');
}
class ConversationStore {
  constructor(directory) { this.directory = directory; }
  file(id) { if (!validId(id)) throw Error('对话编号无效'); return path.join(this.directory, id + '.json'); }
  async ensure() { await fs.mkdir(this.directory, { recursive: true }); const stat = await fs.lstat(this.directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('对话记录路径不是安全目录'); }
  async readRecord(file, id) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_CONVERSATION_BYTES) throw Error('invalid');
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed?.version !== 1 || parsed.id !== id || !Number.isFinite(parsed.createdAt) || parsed.createdAt < 0
      || !Array.isArray(parsed.session?.messages) || !Array.isArray(parsed.session?.entries)
      || !parsed.session.messages.every(message => message && ['user', 'assistant', 'system'].includes(message.role) && typeof message.content === 'string')
      || !parsed.session.entries.every(entry => entry && typeof entry.label === 'string' && typeof entry.raw === 'string')) throw Error('invalid');
    return { id, createdAt: parsed.createdAt, session: parsed.session };
  }
  async recoverInterruptedWrites() {
    const groups = new Map();
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = /^\.(conversation-[a-z0-9-]{8,120})-([a-f0-9]{16})\.(tmp|bak)$/i.exec(entry.name);
      if (!match || !validId(match[1])) continue;
      const group = groups.get(match[1]) || [];
      let stat; try { stat = await fs.lstat(path.join(this.directory, entry.name)); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      group.push({ name: entry.name, token: match[2], kind: match[3], mtime: stat.mtimeMs }); groups.set(match[1], group);
    }
    const errors = [];
    for (const [id, candidates] of groups) {
      try {
        await this.readRecord(this.file(id), id);
        for (const candidate of candidates) await fs.unlink(path.join(this.directory, candidate.name)).catch(() => {});
        continue;
      } catch (error) { if (error.code !== 'ENOENT') continue; }
      candidates.sort((a, b) => b.mtime - a.mtime || (a.kind === 'tmp' ? -1 : 1) - (b.kind === 'tmp' ? -1 : 1));
      let recovered = false;
      for (const candidate of candidates) {
        const source = path.join(this.directory, candidate.name);
        try {
          await this.readRecord(source, id);
          await fs.rename(source, this.file(id));
          const counterpart = path.join(this.directory, `.${id}-${candidate.token}.${candidate.kind === 'tmp' ? 'bak' : 'tmp'}`);
          await fs.unlink(counterpart).catch(() => {});
          recovered = true; break;
        } catch { /* Try the previous complete version if this candidate was incomplete. */ }
      }
      if (!recovered) errors.push(id + '.json');
    }
    return errors;
  }
  async load() {
    await this.ensure(); const items = [], errors = await this.recoverInterruptedWrites();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5); if (!validId(id)) { errors.push(entry.name); continue; }
      try {
        items.push(await this.readRecord(this.file(id), id));
      } catch { errors.push(entry.name); }
    }
    items.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)); return { items, errors };
  }
  async save(item) {
    if (!validId(item?.id) || !Number.isFinite(item.createdAt) || item.createdAt < 0 || !item.session) throw Error('待保存的对话记录无效');
    await this.ensure(); const destination = this.file(item.id), stamp = Date.now();
    const body = JSON.stringify({ version: 1, id: item.id, createdAt: item.createdAt, updatedAt: stamp, session: item.session }, null, 2) + '\n';
    if (Buffer.byteLength(body, 'utf8') > MAX_CONVERSATION_BYTES) throw Error('对话记录文件过大，无法保存');
    const token = randomBytes(8).toString('hex'), temp = path.join(this.directory, '.' + item.id + '-' + token + '.tmp'), backup = path.join(this.directory, '.' + item.id + '-' + token + '.bak');
    let moved = false, installed = false;
    try {
      await fs.writeFile(temp, body, { flag: 'wx' });
      try { const stat = await fs.lstat(destination); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('现有对话记录不是普通文件'); await fs.rename(destination, backup); moved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(temp, destination); installed = true;
      if (moved) { await fs.unlink(backup).catch(() => {}); moved = false; }
    } catch (error) {
      if (installed) await fs.unlink(destination).catch(() => {});
      if (moved) await fs.rename(backup, destination).catch(() => {});
      throw error;
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  async remove(id) { await this.ensure(); await fs.unlink(this.file(id)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function createConversationStore(app, manifest) { return new ConversationStore(resolveConversationDirectory(app, manifest)); }

module.exports = { MAX_CONVERSATION_BYTES, validId, resolveConversationDirectory, ConversationStore, createConversationStore };
