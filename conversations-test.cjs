const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises'); const path = require('node:path');
const { ConversationStore, prepareConversationRecord, resolveConversationDirectory, createConversationStore } = require('./src/conversations');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
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

test('prepared conversations serialize once and stay immutable while the live session keeps changing',async()=>fixture(async root=>{
 const store=recyclableStore(root),record={...item('conversation-prepared','Original question'),name:'Chosen title'};let serializations=0;
 record.session.toJSON=function(){serializations++;return{messages:this.messages,entries:this.entries,meter:null,compactions:0,cache:null};};
 const prepared=prepareConversationRecord(record);assert.equal(serializations,1);assert.equal(Object.isFrozen(prepared),true);assert.equal(prepared.title,'Original question');assert.equal(prepared.name,'Chosen title');assert.equal(prepared.session,undefined);assert.equal(prepareConversationRecord(prepared),prepared);
 record.session.messages[0].content='Changed later';record.session.entries[0].raw='Changed later';record.name='Changed title';
 await store.save(prepared);assert.equal(serializations,1);const loaded=await store.loadOne(record.id);assert.equal(loaded.name,'Chosen title');assert.equal(loaded.session.messages[0].content,'Original question');assert.equal(await fs.readFile(store.file(record.id),'utf8'),prepared.body);
 await assert.rejects(store.save({...prepared,body:'forged'}),/无效/);
}));
test('new archives preserve an explicit cleared name through preparation, reading and cached metadata',async()=>fixture(async root=>{
 const store=recyclableStore(root),id='conversation-nullname';await store.save({...item(id,'Question'),name:'Previous name'});
 const prepared=prepareConversationRecord(item(id,'Question'));assert.equal(prepared.name,null);assert.equal(JSON.parse(prepared.body).name,null);await store.save(prepared);
 assert.equal((await store.loadOne(id)).name,null);assert.equal(store.metadata(id).name,null);const listed=await store.list();assert.equal(listed.items[0].name,null);assert.equal(listed.index[id].name,null);
 const other=recyclableStore(root);other.snapshot=()=>assert.fail('unchanged cached metadata must not parse a conversation body');const cached=await other.list(JSON.parse(JSON.stringify(listed.index)));assert.equal(cached.items[0].name,null);assert.equal(cached.index[id].name,null);assert.equal(cached.items[0].session,undefined);
}));
test('legacy archives with no name field keep it absent so shared-setting titles remain distinguishable',async()=>fixture(async root=>{
 const store=recyclableStore(root),id='conversation-oldtitle';await store.ensure();await fs.writeFile(store.file(id),JSON.stringify({version:1,...item(id,'Legacy question')}));
 const loaded=await store.loadOne(id);assert.equal(Object.hasOwn(loaded,'name'),false);assert.equal(Object.hasOwn(store.metadata(id),'name'),false);
 const listed=await store.list();assert.equal(Object.hasOwn(listed.items[0],'name'),false);assert.equal(Object.hasOwn(listed.index[id],'name'),false);
 const other=recyclableStore(root);other.snapshot=()=>assert.fail('cached legacy metadata must stay lazy');const cached=await other.list(listed.index);assert.equal(Object.hasOwn(cached.items[0],'name'),false);assert.equal(Object.hasOwn(cached.index[id],'name'),false);
}));
test('two independently loaded stores reject stale save and delete without changing the external record',async()=>fixture(async root=>{
 const first=recyclableStore(root),second=recyclableStore(root),id='conversation-conflict';await first.save(item(id,'Base'));await second.loadOne(id);
 await first.save(item(id,'External change'));const external=await fs.readFile(first.file(id),'utf8');
 await assert.rejects(second.save(item(id,'Stale local edit')),error=>error.code==='CONVERSATION_CONFLICT'&&error.reason==='changed');await assert.rejects(second.remove(id),error=>error.code==='CONVERSATION_CONFLICT');assert.equal(await fs.readFile(first.file(id),'utf8'),external);
 await second.loadOne(id);await second.save(item(id,'Explicitly refreshed'));assert.equal((await second.loadOne(id)).session.messages[0].content,'Explicitly refreshed');
}));
test('an unread existing conversation cannot be overwritten or recycled by a new store',async()=>fixture(async root=>{
 const first=recyclableStore(root),second=recyclableStore(root),id='conversation-unreadxx';await first.save(item(id,'Keep external'));const external=await fs.readFile(first.file(id),'utf8');
 await assert.rejects(second.save(item(id,'Blind overwrite')),error=>error.code==='CONVERSATION_CONFLICT'&&error.reason==='unread');await assert.rejects(second.remove(id),error=>error.code==='CONVERSATION_CONFLICT'&&error.reason==='unread');assert.equal(await fs.readFile(first.file(id),'utf8'),external);
}));
test('exclusive per-conversation writes let only one stale simultaneous owner commit',async()=>fixture(async root=>{
 const first=recyclableStore(root),second=recyclableStore(root),id='conversation-raceboth';await first.save(item(id,'Base'));await second.loadOne(id);
 const result=await Promise.allSettled([first.save(item(id,'First candidate')),second.save(item(id,'Second candidate'))]);assert.equal(result.filter(value=>value.status==='fulfilled').length,1);const rejected=result.find(value=>value.status==='rejected');assert.equal(rejected.reason.code,'CONVERSATION_CONFLICT');
 const text=(await first.loadOne(id)).session.messages[0].content;assert.ok(['First candidate','Second candidate'].includes(text));assert.deepEqual(await fs.readdir(first.directory),[id+'.json']);
}));
test('revision checks detect equal-size external edits even when the timestamp is restored',async()=>fixture(async root=>{
 const store=recyclableStore(root),id='conversation-samestat';await store.save(item(id,'old'));const file=store.file(id),stat=await fs.stat(file),before=await fs.readFile(file,'utf8');await fs.writeFile(file,before.replaceAll('old','new'));await fs.utimes(file,stat.atime,stat.mtime);
 await assert.rejects(store.save(item(id,'local')),error=>error.code==='CONVERSATION_CONFLICT');assert.ok((await fs.readFile(file,'utf8')).includes('new'));
}));
test('an external deletion cannot be silently undone by an older owner',async()=>fixture(async root=>{
 const store=recyclableStore(root),id='conversation-deletedx';await store.save(item(id,'Base'));await fs.unlink(store.file(id));await assert.rejects(store.save(item(id,'Resurrection')),error=>error.code==='CONVERSATION_CONFLICT'&&error.reason==='deleted');assert.deepEqual(await fs.readdir(store.directory),[]);
}));
test('cached listing returns only metadata and keeps unchanged conversation bodies unread',async()=>fixture(async root=>{
 const first=recyclableStore(root),a={...item('conversation-listaaaa','First question',2),name:'My history'},b=item('conversation-listbbbb','Second question',1);await first.save(a);await first.save(b);const initial=await first.list();assert.equal(initial.items.length,2);assert.ok(initial.items.every(record=>record.session));
 const second=recyclableStore(root),snapshot=second.snapshot.bind(second);let reads=0;second.snapshot=async(...args)=>{reads++;return snapshot(...args);};
 const cached=await second.list(initial.index);assert.equal(reads,0);assert.equal(cached.items.every(record=>!record.session),true);assert.deepEqual(cached.items.map(record=>record.id),[b.id,a.id]);assert.equal(cached.index[a.id].title,'First question');assert.equal(cached.index[a.id].name,'My history');
 await assert.rejects(second.save(item(a.id,'Unread overwrite')),error=>error.code==='CONVERSATION_CONFLICT');const loaded=await second.loadOne(a.id);assert.equal(reads,1);assert.equal(loaded.session.messages[0].content,'First question');await second.save(item(a.id,'After load'));
 assert.equal(second.metadata(a.id).title,'After load');const metadata=second.metadata(a.id);metadata.stamp.size=0;assert.ok(second.metadata(a.id).stamp.size>0);
}));
test('metadata listings reread changed files and never refresh an already loaded owner revision',async()=>fixture(async root=>{
 const first=recyclableStore(root),second=recyclableStore(root),id='conversation-listdiff';await first.save(item(id,'Base'));const initial=await second.list();assert.equal(initial.errors.length,0);assert.equal(initial.items[0].session.messages[0].content,'Base');
 await first.save(item(id,'A longer external question'));const changed=await second.list(initial.index);assert.equal(changed.items[0].session.messages[0].content,'A longer external question');assert.equal(changed.index[id].title,'A longer external question');await assert.rejects(second.save(item(id,'Stale local')),error=>error.code==='CONVERSATION_CONFLICT');
 await fs.writeFile(path.join(first.directory,'conversation-invalidxx.json'),'{broken');const partial=await second.list(changed.index);assert.equal(partial.items.length,1);assert.deepEqual(partial.errors,['conversation-invalidxx.json']);
}));
test('recovery preserves live write artifacts and never advances a loaded revision',async()=>fixture(async root=>{
 const first=recyclableStore(root),second=recyclableStore(root),id='conversation-recovlive';await first.save(item(id,'Base'));await second.loadOne(id);const token='d'.repeat(16),temporary=path.join(first.directory,`.${id}-${token}.tmp`),backup=path.join(first.directory,`.${id}-${token}.bak`);
 await first.save(item(id,'External new version'));await fs.writeFile(temporary,prepareConversationRecord(item(id,'Still being written')).body);await fs.copyFile(first.file(id),backup);const release=await first.acquireLock(id);
 try{assert.deepEqual(await second.recoverInterruptedWrites(),[]);assert.ok(await fs.stat(temporary));assert.ok(await fs.stat(backup));}finally{await release();}
 await second.recoverInterruptedWrites();await assert.rejects(fs.stat(temporary),error=>error.code==='ENOENT');await assert.rejects(second.save(item(id,'Stale owner')),error=>error.code==='CONVERSATION_CONFLICT');assert.equal((await first.loadOne(id)).session.messages[0].content,'External new version');
}));
test('abandoned locks recover explicitly while an old live same-process lock stays protected',async()=>fixture(async root=>{
 const store=recyclableStore(root),id='conversation-locktest';await store.ensure();const lock=store.lockFile(id),old=new Date(Date.now()-10*60*1000);await fs.writeFile(lock,'interrupted lock initialization');await fs.utimes(lock,old,old);await store.save(item(id,'Recovered'));
 const release=await store.acquireLock(id);await fs.utimes(lock,old,old);const other=new ConversationStore(store.directory,{lockWaitMs:5});
 try{await assert.rejects(other.save(item(id,'Must wait')),error=>error.code==='CONVERSATION_CONFLICT'&&error.reason==='locked');assert.ok(await fs.stat(lock));}finally{await release();}
 assert.deepEqual(await fs.readdir(store.directory),[id+'.json']);
}));
test('a separate Node instance cannot overwrite a record changed after its own load',async()=>fixture(async root=>{
 const store=recyclableStore(root),id='conversation-processx';await store.save(item(id,'Base'));
 const child=spawn(process.execPath,['-e',`const {ConversationStore}=require(process.argv[1]);const store=new ConversationStore(process.argv[2]);const id=process.argv[3];(async()=>{const record=await store.loadOne(id);process.on('message',async()=>{try{record.session.messages[0].content='Child local edit';await store.save(record);process.send({code:'saved'});}catch(error){process.send({code:error.code});}finally{process.disconnect();}});process.send({ready:true});})().catch(error=>{process.send({error:error.message});process.disconnect();});`,require.resolve('./src/conversations'),store.directory,id],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
 try{const [ready]=await once(child,'message');assert.equal(ready.ready,true);await store.save(item(id,'Parent external edit'));const receipt=once(child,'message');child.send('save');const [result]=await receipt;assert.equal(result.code,'CONVERSATION_CONFLICT');assert.equal((await store.loadOne(id)).session.messages[0].content,'Parent external edit');}finally{if(child.exitCode===null)child.kill();await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));}
}));
test('a dead same-host process lock is reclaimed without waiting for the foreign-lock age limit',async()=>fixture(async root=>{
 const store=recyclableStore(root),id='conversation-deadlock';await store.save(item(id,'Base'));
 const child=spawn(process.execPath,['-e',`const {ConversationStore}=require(process.argv[1]);const store=new ConversationStore(process.argv[2]);(async()=>{await store.acquireLock(process.argv[3]);process.send({locked:true});setInterval(()=>{},1000);})().catch(error=>{process.send({error:error.message});process.disconnect();});`,require.resolve('./src/conversations'),store.directory,id],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
 try{const [ready]=await once(child,'message');assert.equal(ready.locked,true);const exited=once(child,'exit');child.kill();await exited;const other=recyclableStore(root);assert.equal((await other.loadOne(id)).session.messages[0].content,'Base');assert.deepEqual(await fs.readdir(store.directory),[id+'.json']);}finally{if(child.exitCode===null&&child.signalCode===null)child.kill();}
}));
test('a target created externally during replacement is preserved by exclusive installation and rollback',async()=>fixture(async root=>{
 const store=recyclableStore(root),id='conversation-duringxx';await store.save(item(id,'Base'));const rename=fs.rename,external=prepareConversationRecord(item(id,'External replacement')).body;
 fs.rename=async(source,destination)=>{await rename(source,destination);if(source===store.file(id)&&destination.endsWith('.bak'))await fs.writeFile(source,external,{flag:'wx'});};
 try{await assert.rejects(store.save(item(id,'Local candidate')),error=>error.code==='CONVERSATION_CONFLICT');assert.equal(await fs.readFile(store.file(id),'utf8'),external);const backups=(await fs.readdir(store.directory)).filter(name=>name.endsWith('.bak'));assert.equal(backups.length,1);assert.equal(JSON.parse(await fs.readFile(path.join(store.directory,backups[0]),'utf8')).session.messages[0].content,'Base');}finally{fs.rename=rename;}
}));
test('a file changed immediately before the backup move is restored rather than overwritten',async()=>fixture(async root=>{
 const store=recyclableStore(root),id='conversation-lastgapx';await store.save(item(id,'Base'));const rename=fs.rename,external=prepareConversationRecord(item(id,'Last-moment external edit')).body;
 fs.rename=async(source,destination)=>{if(source===store.file(id)&&destination.endsWith('.bak'))await fs.writeFile(source,external);return rename(source,destination);};
 try{await assert.rejects(store.save(item(id,'Local candidate')),error=>error.code==='CONVERSATION_CONFLICT');assert.equal(await fs.readFile(store.file(id),'utf8'),external);assert.deepEqual(await fs.readdir(store.directory),[id+'.json']);}finally{fs.rename=rename;}
}));
test('the archive size limit reports a specific code before creating any conversation file',async()=>fixture(async root=>{
 const {MAX_CONVERSATION_BYTES}=require('./src/conversations'),store=recyclableStore(root),record=item('conversation-toolarge','');record.session.messages[0].content='é'.repeat(MAX_CONVERSATION_BYTES/2);
 await assert.rejects(store.save(record),error=>error.code==='CONVERSATION_TOO_LARGE'&&error.maxBytes===MAX_CONVERSATION_BYTES);await assert.rejects(fs.stat(store.directory),error=>error.code==='ENOENT');
}));
