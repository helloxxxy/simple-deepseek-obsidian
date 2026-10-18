const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises'); const path = require('node:path');
const { ConversationStore, resolveConversationDirectory, createConversationStore } = require('./src/conversations');
function recyclableStore(root) {
  return new ConversationStore(path.join(root, 'conversations'), { trashFile: async file => {
    const trash = path.join(root, 'simulated-system-trash'); await fs.mkdir(trash, { recursive: true });
    await fs.rename(file, path.join(trash, path.basename(file))); return true;
  } });
}
async function fixture(run) { const root = await fs.mkdtemp(path.join(__dirname, 'conversations-test-')); try { await run(root); } finally { const real = await fs.realpath(root); if (path.dirname(real) !== await fs.realpath(__dirname) || !path.basename(real).startsWith('conversations-test-')) throw Error('unsafe cleanup'); await fs.rm(real, { recursive: true }); } }
const item = (id, text, createdAt = 1) => ({ id, createdAt, session: { messages: [{ role: 'user', content: text }], entries: [{ label: '你', raw: text }], meter: null, compactions: 0, cache: null } });

test('conversation files preserve exact reasoning and paired tool messages in the ordinary archive',async()=>fixture(async root=>{
  const store=recyclableStore(root),record=item('conversation-tooltest','Look up a page');
  const exchange=[{role:'assistant',content:'Reading.',reasoning_content:'Need a reference.',tool_calls:[{id:'call-1',type:'function',function:{name:'fetch_page',arguments:'{"url":"https://example.com"}'}}]},{role:'tool',tool_call_id:'call-1',content:'{"kind":"web_fetch","content":"text"}'},{role:'assistant',content:'The result.',reasoning_content:'Verified.'}];
  record.session.messages.push(...exchange);record.session.entries.push({label:'deepseek-flash',raw:'Reading.The result.',modelMessages:exchange});await store.save(record);
  const loaded=await store.load();assert.deepEqual(loaded.errors,[]);assert.deepEqual(loaded.items[0].session,record.session);assert.deepEqual((await fs.readdir(store.directory)).filter(name=>name.endsWith('.json')),['conversation-tooltest.json']);
}));
test('conversation files: one JSON per conversation, ordered load and independent delete', async () => fixture(async root => {
  const store = recyclableStore(root), a = item('conversation-aaaaaaaa', 'A', 20), b = item('conversation-bbbbbbbb', 'B', 10); await store.save(a); await store.save(b);
  assert.deepEqual((await fs.readdir(store.directory)).sort(), ['conversation-aaaaaaaa.json', 'conversation-bbbbbbbb.json']); const loaded = await store.load(); assert.deepEqual(loaded.items.map(x => x.id), [b.id, a.id]); assert.equal(loaded.items[0].session.messages[0].content, 'B'); assert.deepEqual(loaded.errors, []);
  await store.remove(b.id); assert.deepEqual(await fs.readdir(store.directory), ['conversation-aaaaaaaa.json']); assert.equal((await store.load()).items[0].id, a.id);
  const recycled = JSON.parse(await fs.readFile(path.join(root, 'simulated-system-trash', b.id + '.json'), 'utf8'));
  assert.equal(recycled.session.messages[0].content, 'B');
}));
test('conversation files: overwrite is atomic and malformed files do not hide valid histories', async () => fixture(async root => {
  const store = recyclableStore(root), id = 'conversation-cccccccc'; await store.save(item(id, 'old')); await store.save(item(id, 'new'));
  await fs.writeFile(path.join(store.directory, 'conversation-dddddddd.json'), '{broken'); const loaded = await store.load(); assert.equal(loaded.items.length, 1); assert.equal(loaded.items[0].session.messages[0].content, 'new'); assert.deepEqual(loaded.errors, ['conversation-dddddddd.json']); assert.ok((await fs.readdir(store.directory)).every(name => !/\.(?:tmp|bak)$/.test(name)));
}));
test('conversation files: interrupted replacement restores the newest complete record', async () => fixture(async root => {
  const store = recyclableStore(root); await store.ensure();
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
  const store = recyclableStore(root), id = 'conversation-gggggggg';
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
test('conversation recycling uses the vault adapter system trash and preserves the record for restoration', async () => fixture(async root => {
  const id = 'conversation-hhhhhhhh', record = { ...item(id, 'Recover me'), name: 'My conversation' }, requests = [];
  const app = { vault: { adapter: {
    getBasePath: () => root,
    trashSystem: async relative => {
      requests.push(relative);
      await fs.rename(path.join(root, relative), path.join(root, 'recycled.json')); return true;
    }
  } } };
  const store = createConversationStore(app, { id: 'simple-deepseek' }); await store.save(record); await store.remove(id);
  assert.deepEqual(requests, ['.obsidian/plugins/simple-deepseek/conversations/' + id + '.json']);
  assert.deepEqual((await store.load()).items, []);
  await fs.rename(path.join(root, 'recycled.json'), store.file(id));
  const restored = (await store.load()).items[0]; assert.equal(restored.name, record.name); assert.equal(restored.session.messages[0].content, 'Recover me');
}));
test('failed or unavailable system trash preserves the file without falling back to permanent deletion', async () => fixture(async root => {
  const id = 'conversation-iiiiiiii';
  const store = new ConversationStore(path.join(root, 'conversations'), { trashFile: async () => false });
  await store.save(item(id, 'Keep me')); await assert.rejects(store.remove(id), /回收站不可用/);
  assert.equal((await store.load()).items[0].session.messages[0].content, 'Keep me');
  store.trashFile = async () => { throw Error('system error'); };
  await assert.rejects(store.remove(id), /system error/); assert.ok(await fs.stat(store.file(id)));
  store.trashFile = undefined; await assert.rejects(store.remove(id), /回收站不可用/);
  assert.ok(await fs.stat(store.file(id)));
}));
