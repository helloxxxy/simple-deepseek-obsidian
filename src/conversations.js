const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { hostname } = require('node:os');
const { validMessage } = require('./history');

const MAX_CONVERSATION_BYTES = 64 * 1024 * 1024;
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_HOST = createHash('sha256').update(hostname()).digest('hex');
const preparedRecords = new WeakSet();
const digest = value => createHash('sha256').update(value).digest('hex');
const validId = id => typeof id === 'string' && /^conversation-[a-z0-9-]{8,120}$/i.test(id);
function conversationTitle(session) {
  const entries = Array.isArray(session?.entries) ? session.entries : [];
  const entry = entries.find(item => item.label === '你' && typeof item.raw === 'string' && item.raw.trim()) || entries.find(item => typeof item.raw === 'string' && item.raw.trim());
  const text = entry?.raw.trim().replace(/\s+/g, ' ') || '';
  return text ? (text.length > 36 ? text.slice(0, 36) + '…' : text) : '新对话';
}
function prepareConversationRecord(item) {
  if (preparedRecords.has(item)) return item;
  if (!validId(item?.id) || !Number.isFinite(item.createdAt) || item.createdAt < 0 || !item.session) throw Error('待保存的对话记录无效');
  const name = typeof item.name === 'string' && item.name.trim() ? item.name : null;
  const body = JSON.stringify({ version: 1, id: item.id, createdAt: item.createdAt, updatedAt: Date.now(), session: item.session, name }, null, 2) + '\n';
  if (Buffer.byteLength(body, 'utf8') > MAX_CONVERSATION_BYTES) throw Object.assign(Error('对话记录文件过大，无法保存'), { code: 'CONVERSATION_TOO_LARGE', maxBytes: MAX_CONVERSATION_BYTES });
  const prepared = Object.freeze({ id: item.id, createdAt: item.createdAt, body, title: conversationTitle(item.session), name });
  preparedRecords.add(prepared); return prepared;
}
function conflict(reason = 'changed') { return Object.assign(Error(reason === 'locked' ? '对话文件正在被其他实例保存，请稍后重试' : '对话文件已被其他实例修改，原文件已保留'), { code: 'CONVERSATION_CONFLICT', reason }); }
const stampFor = stat => ({ mtimeMs: stat.mtimeMs, size: stat.size });
function nameField(value) { return value?.name === null || (typeof value?.name === 'string' && value.name.trim()) ? { name: value.name } : {}; }
function metadataFor(record, stat) { return { createdAt: record.createdAt, title: record.title || conversationTitle(record.session), ...nameField(record), stamp: stampFor(stat) }; }
function cachedMetadata(value, stat) {
  if (!value || !Number.isFinite(value.createdAt) || value.createdAt < 0 || typeof value.title !== 'string' || value.stamp?.mtimeMs !== stat.mtimeMs || value.stamp?.size !== stat.size) return null;
  return { createdAt: value.createdAt, title: value.title, ...nameField(value), stamp: stampFor(stat) };
}
async function installExclusive(source, destination) {
  try { await fs.link(source, destination); }
  catch (error) {
    if (!['ENOTSUP','EOPNOTSUPP','EPERM','EXDEV','ENOSYS'].includes(error.code)) throw error;
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
  }
}
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
  constructor(directory, { trashFile, lockWaitMs = 2000 } = {}) { this.directory = directory; this.trashFile = trashFile; this.lockWaitMs = Number.isFinite(lockWaitMs) ? Math.max(0, lockWaitMs) : 2000; this.revisions = new Map(); this.metadataRecords = new Map(); }
  file(id) { if (!validId(id)) throw Error('对话编号无效'); return path.join(this.directory, id + '.json'); }
  async ensure() { await fs.mkdir(this.directory, { recursive: true }); const stat = await fs.lstat(this.directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('对话记录路径不是安全目录'); }
  async rawRecord(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_CONVERSATION_BYTES) throw Error('invalid');
    const handle = await fs.open(file, 'r');
    try {
      const opened = await handle.stat(); if (!opened.isFile() || opened.size !== stat.size || opened.ino !== stat.ino) throw Error('invalid');
      const bytes = Buffer.alloc(opened.size + 1); let read = 0;
      while (read < bytes.length) { const chunk = await handle.read(bytes, read, bytes.length - read, read); if (!chunk.bytesRead) break; read += chunk.bytesRead; }
      const after = await handle.stat();
      if (read !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw conflict();
      const body = bytes.subarray(0, read); return { body, revision: digest(body), stat: after };
    } finally { await handle.close(); }
  }
  async snapshot(file, id) {
    const raw = await this.rawRecord(file), parsed = JSON.parse(raw.body.toString('utf8'));
    if (parsed?.version !== 1 || parsed.id !== id || !Number.isFinite(parsed.createdAt) || parsed.createdAt < 0
      || !Array.isArray(parsed.session?.messages) || !Array.isArray(parsed.session?.entries)
      || !parsed.session.messages.every(validMessage)
      || !parsed.session.entries.every(entry => entry && typeof entry.label === 'string' && typeof entry.raw === 'string')) throw Error('invalid');
    return { ...raw, record: { id, createdAt: parsed.createdAt, session: parsed.session, ...nameField(parsed) } };
  }
  remember(id, snapshot) { this.revisions.set(id, snapshot.revision); this.metadataRecords.set(id, metadataFor(snapshot.record, snapshot.stat)); }
  metadata(id) { const value = this.metadataRecords.get(id); return value ? { ...value, stamp: { ...value.stamp } } : null; }
  async readRecord(file, id) {
    const snapshot = await this.snapshot(file, id);
    if (path.resolve(file) === path.resolve(this.file(id))) this.remember(id, snapshot);
    return snapshot.record;
  }
  lockFile(id) { this.file(id); return path.join(this.directory, '.' + id + '.lock'); }
  async clearStaleLock(file) {
    let stat, body;
    try { stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return false; body = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    let owner; try { owner = JSON.parse(body); } catch {}
    let stale = false;
    if (owner?.host === LOCK_HOST && Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.pid <= 0x7fffffff) {
      try { process.kill(owner.pid, 0); } catch (error) { stale = error.code === 'ESRCH'; }
    } else stale = Date.now() - stat.mtimeMs > LOCK_STALE_MS;
    if (!stale) return false;
    // A live same-host process never loses its lock to an age-based timeout.
    try { if (await fs.readFile(file, 'utf8') !== body) return false; await fs.unlink(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
  async acquireLock(id, wait = true) {
    const file = this.lockFile(id), token = randomBytes(16).toString('hex'), body = JSON.stringify({ pid: process.pid, host: LOCK_HOST, token }), deadline = Date.now() + (wait ? this.lockWaitMs : 0);
    for (;;) {
      let handle;
      try {
        handle = await fs.open(file, 'wx'); await handle.writeFile(body); await handle.close();
        return async () => { try { if (await fs.readFile(file, 'utf8') === body) await fs.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
      } catch (error) {
        if (handle) { await handle.close().catch(() => {}); await fs.unlink(file).catch(() => {}); throw error; }
        if (error.code !== 'EEXIST') throw error;
        if (await this.clearStaleLock(file)) continue;
        if (Date.now() >= deadline) throw conflict('locked');
        await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      }
    }
  }
  async assertRevision(id) {
    let current;
    try { current = await this.rawRecord(this.file(id)); }
    catch (error) { if (error.code === 'ENOENT') current = null; else throw error.code === 'CONVERSATION_CONFLICT' ? error : conflict('invalid_external_file'); }
    const expected = this.revisions.get(id);
    if (current && (!this.revisions.has(id) || current.revision !== expected)) throw conflict(this.revisions.has(id) ? 'changed' : 'unread');
    if (!current && expected) throw conflict('deleted');
    return current;
  }
  async recoverInterruptedWrites() {
    const groups = new Map(); this.pendingRecoveryIds = new Set();
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
      let release;
      try { release = await this.acquireLock(id, false); }
      catch (error) { if (error.code === 'CONVERSATION_CONFLICT') { this.pendingRecoveryIds.add(id); continue; } throw error; }
      try {
      try {
        await this.snapshot(this.file(id), id);
        for (const candidate of candidates) await fs.unlink(path.join(this.directory, candidate.name)).catch(() => {});
        continue;
      } catch (error) { if (error.code !== 'ENOENT') continue; }
      candidates.sort((a, b) => b.mtime - a.mtime || (a.kind === 'tmp' ? -1 : 1) - (b.kind === 'tmp' ? -1 : 1));
      let recovered = false;
      for (const candidate of candidates) {
        const source = path.join(this.directory, candidate.name);
        try {
          await this.snapshot(source, id);
          await installExclusive(source, this.file(id)); await fs.unlink(source);
          const counterpart = path.join(this.directory, `.${id}-${candidate.token}.${candidate.kind === 'tmp' ? 'bak' : 'tmp'}`);
          await fs.unlink(counterpart).catch(() => {});
          recovered = true; break;
        } catch { /* Try the previous complete version if this candidate was incomplete. */ }
      }
      if (!recovered) errors.push(id + '.json');
      } finally { await release(); }
    }
    return errors;
  }
  async load() {
    await this.ensure(); const items = [], errors = await this.recoverInterruptedWrites();
    const entries = await this.entriesAfterRecovery();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5); if (!validId(id)) { errors.push(entry.name); continue; }
      try {
        items.push(await this.loadOne(id));
      } catch { errors.push(entry.name); }
    }
    items.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)); return { items, errors };
  }
  async loadOne(id) {
    await this.ensure(); const release = await this.acquireLock(id);
    try { return await this.readRecord(this.file(id), id); }
    finally { await release(); }
  }
  async entriesAfterRecovery() {
    const entries = await fs.readdir(this.directory, { withFileTypes: true }), names = new Set(entries.map(entry => entry.name));
    for (const id of this.pendingRecoveryIds || []) if (!names.has(id + '.json')) entries.push({ name: id + '.json', isFile: () => true });
    return entries;
  }
  async list(cachedIndex = {}) {
    await this.ensure(); const items = [], errors = await this.recoverInterruptedWrites(), index = {};
    const entries = await this.entriesAfterRecovery();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5); if (!validId(id)) { errors.push(entry.name); continue; }
      try {
        let stat;
        try { stat = await fs.lstat(this.file(id)); }
        catch (error) {
          if (error.code !== 'ENOENT' || !this.pendingRecoveryIds.has(id)) throw error;
          const release = await this.acquireLock(id); try { stat = await fs.lstat(this.file(id)); } finally { await release(); }
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_CONVERSATION_BYTES) throw Error('invalid');
        const cached = cachedMetadata(cachedIndex?.[id], stat);
        if (cached) { items.push({ id, ...cached }); index[id] = cached; continue; }
        const release = await this.acquireLock(id);
        try {
          const snapshot = await this.snapshot(this.file(id), id), metadata = metadataFor(snapshot.record, snapshot.stat);
          if (!this.revisions.has(id)) this.remember(id, snapshot);
          items.push({ ...snapshot.record, ...metadata }); index[id] = metadata;
        } finally { await release(); }
      } catch { errors.push(entry.name); }
    }
    items.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return { items, errors, index };
  }
  async save(item) {
    const prepared = prepareConversationRecord(item); item = prepared;
    await this.ensure(); const release = await this.acquireLock(item.id), destination = this.file(item.id), body = prepared.body;
    const token = randomBytes(8).toString('hex'), temp = path.join(this.directory, '.' + item.id + '-' + token + '.tmp'), backup = path.join(this.directory, '.' + item.id + '-' + token + '.bak');
    let moved = false, installed = false;
    try {
      await this.assertRevision(item.id);
      await fs.writeFile(temp, body, { flag: 'wx' });
      const current = await this.assertRevision(item.id);
      try { const stat = await fs.lstat(destination); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('现有对话记录不是普通文件'); await fs.rename(destination, backup); moved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (moved && (!current || (await this.rawRecord(backup)).revision !== current.revision)) throw conflict();
      try { await installExclusive(temp, destination); installed = true; } catch (error) { if (error.code === 'EEXIST') throw conflict(); throw error; }
      const metadata = metadataFor(prepared, await fs.stat(destination));
      if (moved && (await this.rawRecord(backup)).revision !== current.revision) throw conflict();
      if (moved) { await fs.unlink(backup).catch(() => {}); moved = false; }
      this.revisions.set(item.id, digest(body)); this.metadataRecords.set(item.id, metadata);
    } catch (error) {
      let restore = !installed;
      if (installed) {
        try { if ((await this.rawRecord(destination)).revision === digest(body)) { await fs.unlink(destination); restore = true; } } catch {}
      }
      if (moved && restore) { try { await installExclusive(backup, destination); await fs.unlink(backup); } catch {} }
      throw error;
    } finally { await fs.unlink(temp).catch(() => {}); await release(); }
  }
  async remove(id) {
    const file = this.file(id);
    await this.ensure(); await this.recoverInterruptedWrites();
    const release = await this.acquireLock(id);
    try {
      const current = await this.assertRevision(id); if (!current) return false;
      if (typeof this.trashFile !== 'function' || await this.trashFile(file) !== true) throw Error('系统回收站不可用，原会话已保留');
      this.revisions.set(id, null); this.metadataRecords.delete(id); return true;
    } finally { await release(); }
  }
}
function createConversationStore(app, manifest) {
  const directory = resolveConversationDirectory(app, manifest), adapter = app.vault.adapter;
  const vault = path.resolve(typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : adapter.basePath);
  return new ConversationStore(directory, { trashFile: async file => {
    if (!inside(vault, file)) throw Error('对话记录路径超出当前笔记库');
    if (typeof adapter.trashSystem !== 'function') return false;
    return adapter.trashSystem(path.relative(vault, file).split(path.sep).join('/'));
  } });
}

module.exports = { MAX_CONVERSATION_BYTES, validId, prepareConversationRecord, resolveConversationDirectory, ConversationStore, createConversationStore };
