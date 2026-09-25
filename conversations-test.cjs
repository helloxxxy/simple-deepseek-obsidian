const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises'); const path = require('node:path');
const { ConversationStore, resolveConversationDirectory } = require('./src/conversations');
async function fixture(run) { const root = await fs.mkdtemp(path.join(__dirname, 'conversations-test-')); try { await run(root); } finally { const real = await fs.realpath(root); if (path.dirname(real) !== await fs.realpath(__dirname) || !path.basename(real).startsWith('conversations-test-')) throw Error('unsafe cleanup'); await fs.rm(real, { recursive: true }); } }
const item = (id, text, createdAt = 1) => ({ id, createdAt, session: { messages: [{ role: 'user', content: text }], entries: [{ label: '你', raw: text }], meter: null, compactions: 0, cache: null } });
test('conversation files: one JSON per conversation, ordered load and independent delete', async () => fixture(async root => {
  const store = new ConversationStore(path.join(root, 'conversations')), a = item('conversation-aaaaaaaa', 'A', 20), b = item('conversation-bbbbbbbb', 'B', 10); await store.save(a); await store.save(b);
  assert.deepEqual((await fs.readdir(store.directory)).sort(), ['conversation-aaaaaaaa.json', 'conversation-bbbbbbbb.json']); const loaded = await store.load(); assert.deepEqual(loaded.items.map(x => x.id), [b.id, a.id]); assert.equal(loaded.items[0].session.messages[0].content, 'B'); assert.deepEqual(loaded.errors, []);
  await store.remove(b.id); assert.deepEqual(await fs.readdir(store.directory), ['conversation-aaaaaaaa.json']); assert.equal((await store.load()).items[0].id, a.id);
}));
test('conversation files: overwrite is atomic and malformed files do not hide valid histories', async () => fixture(async root => {
  const store = new ConversationStore(path.join(root, 'conversations')), id = 'conversation-cccccccc'; await store.save(item(id, 'old')); await store.save(item(id, 'new'));
  await fs.writeFile(path.join(store.directory, 'conversation-dddddddd.json'), '{broken'); const loaded = await store.load(); assert.equal(loaded.items.length, 1); assert.equal(loaded.items[0].session.messages[0].content, 'new'); assert.deepEqual(loaded.errors, ['conversation-dddddddd.json']); assert.ok((await fs.readdir(store.directory)).every(name => !/\.(?:tmp|bak)$/.test(name)));
}));
test('conversation files: interrupted replacement restores the newest complete record', async () => fixture(async root => {
  const store = new ConversationStore(path.join(root, 'conversations')); await store.ensure();
  const write = async (file, record) => fs.writeFile(path.join(store.directory, file), JSON.stringify({ version: 1, ...record }));
  const first = 'conversation-eeeeeeee', token = 'a'.repeat(16);
  await write(`.${first}-${token}.bak`, item(first, 'previous'));
  await write(`.${first}-${token}.tmp`, item(first, 'latest'));
  const second = 'conversation-ffffffff', secondToken = 'b'.repeat(16);
  await write(`.${second}-${secondToken}.bak`, item(second, 'fallback'));
  await fs.writeFile(path.join(store.directory, `.${second}-${secondToken}.tmp`), '{incomplete');
  const loaded = await store.load();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.items.find(record => record.id === first).session.messages[0].content, 'latest');
  assert.equal(loaded.items.find(record => record.id === second).session.messages[0].content, 'fallback');
  assert.ok((await fs.readdir(store.directory)).every(name => name.endsWith('.json')));
}));
test('conversation files: stale backup cannot recreate a conversation after deletion', async () => fixture(async root => {
  const store = new ConversationStore(path.join(root, 'conversations')), id = 'conversation-gggggggg';
  await store.save(item(id, 'current'));
  const backup = path.join(store.directory, `.${id}-${'c'.repeat(16)}.bak`);
  await fs.copyFile(store.file(id), backup);
  assert.equal((await store.load()).items[0].session.messages[0].content, 'current');
  await assert.rejects(fs.lstat(backup), error => error.code === 'ENOENT');
  await store.remove(id);
  assert.deepEqual((await store.load()).items, []);
}));
test('conversation files: plugin directory resolves inside the vault only', async () => fixture(async root => {
  const app = { vault: { adapter: { getBasePath: () => root }, configDir: '.obsidian' } }; assert.equal(resolveConversationDirectory(app, { id: 'simple-deepseek' }), path.join(root, '.obsidian', 'plugins', 'simple-deepseek', 'conversations')); assert.throws(() => resolveConversationDirectory(app, { id: 'simple-deepseek', dir: '..\\outside' }));
}));
