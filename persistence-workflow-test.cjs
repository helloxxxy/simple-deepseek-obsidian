const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {ui}=require('./scripts/test-ui.cjs'),api=require('./src/conversations');
const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Workflow checkpoint did not arrive');};
const record=(id,text,createdAt=1)=>({id,createdAt,session:{messages:[{role:'user',content:text}],entries:[{label:'你',raw:text}],meter:null,cache:null,compactions:0}});
async function fixture(t){const root=await fs.mkdtemp(path.join(__dirname,'persistence-workflow-'));t.after(async()=>{const real=await fs.realpath(root);assert.equal(path.dirname(real),await fs.realpath(__dirname));assert.ok(path.basename(real).startsWith('persistence-workflow-'));await fs.rm(real,{recursive:true,force:true});});return root;}
async function open(store,saved={uiLanguage:'en',webEnabled:false}){
 const env=ui(async(k,m,s,d)=>{d('Local answer');return{prompt_tokens:20,completion_tokens:5};},async()=>'',{saved,conversationApi:{...api,createConversationStore:()=>store}});
 await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();
 env.plugin.app={workspace:{getLeavesOfType:()=>[{view}],detachLeavesOfType(){}}};return{...env,view};
}

test('a warm conversation index restores only the selected body and loads another on selection',async t=>{
 const root=await fixture(t),seed=new api.ConversationStore(root),a=record('conversation-lazyfirst','First title'),b=record('conversation-lazysecond','Second title',2);await seed.save(a);await seed.save(b);const index=(await seed.list()).index;
 const store=new api.ConversationStore(root),reads=[],read=store.rawRecord.bind(store);store.rawRecord=async file=>{reads.push(path.basename(file));return read(file);};
 const env=await open(store,{uiLanguage:'en',webEnabled:false,activeConversationId:a.id,conversationIndex:index});
 assert.deepEqual(reads,[a.id+'.json']);assert.equal(env.plugin.conversations.find(item=>item.id===b.id).session,null);assert.match(env.view.conversationSelect.textContent,/Second title/);
 await env.view.switchConversation(b.id);assert.equal(env.view.session.messages[0].content,'Second title');assert.ok(reads.includes(b.id+'.json'));await env.view.onClose();
});

test('external changes fork the local conversation while keeping the live session and both files',async t=>{
 const root=await fixture(t),seed=new api.ConversationStore(root),a=record('conversation-externalwrite','Original');await seed.save(a);
 const local=new api.ConversationStore(root),env=await open(local),session=env.view.session;
 const external=new api.ConversationStore(root),changed=await external.loadOne(a.id);changed.session.messages.push({role:'assistant',content:'External answer'});changed.session.entries.push({label:'assistant',raw:'External answer'});await external.save(changed);
 env.view.input.value='Local follow-up';await env.view.send();const forkId=env.plugin.activeConversationId;
 assert.notEqual(forkId,a.id);assert.equal(env.view.session,session);assert.equal(env.plugin.session,session);assert.equal(env.view.conversationSelect.value,forkId);
 assert.equal((await external.loadOne(a.id)).session.messages.at(-1).content,'External answer');
 const fork=await new api.ConversationStore(root).loadOne(forkId);assert.equal(fork.session.messages.at(-1).content,'Local answer');assert.match(fork.name,/Local copy/);
 assert.ok(env.notices.some(value=>/external version was kept/.test(value)));
 await env.view.switchConversation(a.id);assert.equal(env.view.session.messages.at(-1).content,'External answer');await env.view.onClose();
});

test('ordinary pending saves coalesce and a strict checkpoint freezes earlier snapshots',async()=>{
 let release,started=false;const writes=[];
 const store={load:async()=>({items:[],errors:[]}),save:async prepared=>{writes.push(JSON.parse(prepared.body));if(!started){started=true;await new Promise(resolve=>release=resolve);}}};
 const env=await open(store),session=env.view.session;session.entries.push({label:'你',raw:'one'});
 const first=env.plugin.saveSession(session);await until(()=>release);
 session.entries[0].raw='two';const second=env.plugin.saveSession(session);session.entries[0].raw='three';const coalesced=env.plugin.saveSession(session),strict=env.plugin.saveSession(session,true);
 session.entries[0].raw='four';const last=env.plugin.saveSession(session);release();await Promise.all([first,second,coalesced,strict,last]);
 assert.deepEqual(writes.map(item=>item.session.entries[0].raw),['one','three','three','four']);await env.view.onClose();
});

test('an inactive failed save is retried at unload without losing its owner',async()=>{
 let fail=true;const writes=[];
 const store={load:async()=>({items:[],errors:[]}),save:async prepared=>{const item=JSON.parse(prepared.body);writes.push(item);if(fail){fail=false;throw Error('Temporary disk failure');}}};
 const env=await open(store),a=env.plugin.conversations[0];a.session.entries.push({label:'你',raw:'Pending first'});await env.plugin.saveSession(a.session);assert.ok(env.plugin.failedSessionSaves.has(a.session));
 const b=env.plugin.addConversation();b.session.entries.push({label:'你',raw:'Current second'});env.plugin.activateConversation(b.id);
 env.plugin.app={workspace:{getLeavesOfType:()=>[],detachLeavesOfType(){}}};env.plugin.onunload();await env.plugin.saveQueue;
 assert.equal(writes.filter(item=>item.id===a.id).length,2);assert.equal(writes.at(-1).id,b.id);assert.equal(env.plugin.failedSessionSaves.size,0);await env.view.onClose();
});

test('an explicit cleared name wins over stale settings while legacy settings names survive',async t=>{
 const root=await fixture(t),seed=new api.ConversationStore(root),cleared=record('conversation-clearedname','Automatic title');await seed.save(cleared);
 const legacy=record('conversation-legacyname','Older title',2);await fs.writeFile(path.join(root,legacy.id+'.json'),JSON.stringify({version:1,...legacy}));
 const env=await open(new api.ConversationStore(root),{uiLanguage:'en',activeConversationId:cleared.id,conversationNames:{[cleared.id]:'Stale name',[legacy.id]:'Preserved legacy name'}});
 assert.equal(env.plugin.conversationNames[cleared.id],undefined);assert.equal(env.plugin.conversationNames[legacy.id],'Preserved legacy name');await env.plugin.saveSession();
 assert.equal((await new api.ConversationStore(root).loadOne(cleared.id)).name,null);await env.view.switchConversation(legacy.id);assert.equal(env.plugin.conversationNames[legacy.id],'Preserved legacy name');await env.view.onClose();
});

test('clear recycles the displayed local branch and preserves a newly changed external version',async t=>{
 const root=await fixture(t),seed=new api.ConversationStore(root),a=record('conversation-clearconflict','Original');await seed.save(a);const recycled=[];
 const local=new api.ConversationStore(root,{trashFile:async file=>{recycled.push(JSON.parse(await fs.readFile(file,'utf8')));await fs.unlink(file);return true;}}),env=await open(local);
 const external=new api.ConversationStore(root),changed=await external.loadOne(a.id);changed.session.entries.push({label:'assistant',raw:'External latest'});changed.session.messages.push({role:'assistant',content:'External latest'});await external.save(changed);
 env.view.session.entries.push({label:'你',raw:'Local unsaved'});await env.view.clear();
 assert.equal(recycled.length,1);assert.notEqual(recycled[0].id,a.id);assert.equal(recycled[0].session.entries.at(-1).raw,'Local unsaved');assert.equal(env.view.session.entries.at(-1).raw,'External latest');assert.equal((await external.loadOne(a.id)).session.messages.at(-1).content,'External latest');await env.view.onClose();
});

test('closing during an unloaded conversation read does not activate the late result',async()=>{
 const a=record('conversation-readyentry','Ready'),b=record('conversation-slowentry','Slow',2);let release;
 const store={list:async()=>({items:[a,{id:b.id,createdAt:2,title:'Slow'}],index:{},errors:[]}),loadOne:async()=>new Promise(resolve=>release=()=>resolve(b)),save:async()=>{}};
 const env=await open(store),switching=env.view.switchConversation(b.id);await until(()=>release);const closing=env.view.onClose();release();await Promise.all([switching,closing]);assert.equal(env.plugin.activeConversationId,a.id);assert.equal(env.view.closed,true);
});

test('an externally deleted file is not recreated under its old ID when local edits are preserved',async t=>{
 const root=await fixture(t),seed=new api.ConversationStore(root),a=record('conversation-deletedexternal','Original');await seed.save(a);
 const store=new api.ConversationStore(root),env=await open(store);await fs.unlink(store.file(a.id));env.view.row('你','Unsaved local text');await env.plugin.saveSession();
 const id=env.plugin.activeConversationId;assert.notEqual(id,a.id);assert.equal(env.plugin.conversations.length,1);assert.equal(env.plugin.conversations[0].id,id);assert.equal(env.plugin.conversationIndex[a.id],undefined);
 await assert.rejects(fs.stat(store.file(a.id)),{code:'ENOENT'});assert.equal((await new api.ConversationStore(root).loadOne(id)).session.entries.at(-1).raw,'Unsaved local text');assert.ok(env.notices.some(value=>/deleted externally/.test(value)));await env.view.onClose();
});
