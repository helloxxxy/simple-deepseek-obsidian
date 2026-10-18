const test=require('node:test');
const assert=require('node:assert/strict');
const {ui}=require('./scripts/test-ui.cjs');
const library=require('./src/library');
const usage={prompt_tokens:100,completion_tokens:10,prompt_cache_hit_tokens:60,prompt_cache_miss_tokens:40};
const until=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Workflow checkpoint did not arrive');};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
async function open(chat=async(k,m,s,d)=>{d('Answer');return usage;},parse=async()=>'',options={}) {
  const env=ui(chat,parse,{saved:{uiLanguage:'en',webEnabled:false},...options});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';
  const view=env.plugin.factory({});await view.onOpen();return{...env,view};
}

test('Stop releases a completed answer waiting for Markdown and a late render cannot follow a later reply',async()=>{
  const held=deferred();let rendering=false,requests=0;
  const env=await open(async(k,m,s,d)=>{d(++requests===1?'First answer':'Second answer');return usage;},undefined,{render:async text=>{if(text==='First answer'){rendering=true;await held.promise;}}});
  const {view}=env;view.input.value='First question';const first=view.send();await until(()=>rendering);
  view.sendButton.click();await first;
  assert.equal(view.controller,null);assert.equal(view.sendButton.disabled,false);
  const old=[...view.rows].at(-1);assert.equal(old.entry.raw,'First answer');
  view.input.value='Second question';await view.send();assert.equal(view.session.entries.at(-1).raw,'Second answer');
  let scrolls=0;view.scroll=()=>{scrolls++;};held.resolve();await until(()=>!old.running);
  assert.equal(scrolls,0);assert.equal(view.followingReply,null);
  assert.deepEqual(Array.from(view.messages,message=>message.content),['First question','First answer','Second question','Second answer']);
  await view.onClose();
});

test('Stop during a parsed PDF render never appends its context after the next conversation starts',async()=>{
  const held=deferred();let rendering=false;
  const env=await open(undefined,async()=>'Parsed PDF text',{render:async text=>{if(text==='Parsed PDF text'){rendering=true;await held.promise;}}});
  const {view,plugin}=env;plugin.keys.mineru='fake-mineru';const uploading=view.upload({name:'paper.pdf'});await until(()=>rendering);
  const old=[...view.rows].at(-1),session=view.session;view.sendButton.click();await uploading;
  assert.equal(view.controller,null);assert.equal(session.messages.length,0);assert.equal(old.entry.contextText,undefined);
  await view.newConversation();view.input.value='New question';await view.send();held.resolve();await until(()=>!old.running);
  assert.equal(old.disposed,true);assert.equal(session.messages.length,0);assert.equal(old.entry.contextText,undefined);
  assert.deepEqual(Array.from(view.messages,message=>message.content),['New question','Answer']);await view.onClose();
});

test('a cancelled PDF stays outside context when deleting an earlier turn and reopening the conversation',async()=>{
  const held=deferred();let rendering=false,requests=0;
  const env=await open(async(k,m,s,d)=>{requests++;assert.ok(!JSON.stringify(m).includes('Cancelled PDF content'));d('Answer '+requests);return usage;},async()=>'Cancelled PDF content',{render:async text=>{if(text==='Cancelled PDF content'){rendering=true;await held.promise;}}});
  const {view,plugin}=env;view.input.value='First question';await view.send();const firstReply=view.session.entries.at(-1);
  plugin.keys.mineru='fake-mineru';const uploading=view.upload({name:'cancelled.pdf'});await until(()=>rendering);
  const pdf=[...view.rows].at(-1);view.sendButton.click();await uploading;held.resolve();await until(()=>!pdf.running);
  view.input.value='Second question';await view.send();await view.deleteTurn(firstReply);
  assert.deepEqual(Array.from(view.messages,message=>message.content),['Second question','Answer 2']);
  assert.equal(pdf.entry.raw,'Cancelled PDF content');assert.deepEqual(Array.from(pdf.entry.modelMessages),[]);await view.onClose();
  const restored=await open(async(k,m,s,d)=>{assert.ok(!JSON.stringify(m).includes('Cancelled PDF content'));d('Third answer');return usage;},undefined,{saved:env.saved.at(-1),conversationState:env.conversationState});
  restored.view.input.value='Third question';await restored.view.send();assert.equal(restored.view.session.entries.at(-1).raw,'Third answer');await restored.view.onClose();
});

test('saving an origin conversation does not cancel a different conversation pending save',async()=>{
  const env=await open();const {plugin,view}=env;
  const a=plugin.conversations.find(item=>item.session===view.session),b=plugin.addConversation();
  a.session.entries.push({label:'你',raw:'Origin edit'});b.session.entries.push({label:'你',raw:'Background edit'});
  plugin.scheduleSessionSave(a.session);plugin.scheduleSessionSave(b.session);
  await plugin.saveSession(a.session);
  assert.equal(plugin.sessionTimers.has(a.session),false);assert.equal(plugin.sessionTimers.has(b.session),true);
  await plugin.saveSession(b.session);
  assert.equal(env.conversationState.get(a.id).session.entries.at(-1).raw,'Origin edit');
  assert.equal(env.conversationState.get(b.id).session.entries.at(-1).raw,'Background edit');
  await view.onClose();
});

test('unloading flushes pending conversations as well as the current conversation',async()=>{
  const env=await open();const {plugin,view}=env;
  const a=plugin.conversations.find(item=>item.session===view.session),b=plugin.addConversation();
  a.session.entries.push({label:'你',raw:'First pending edit'});b.session.entries.push({label:'你',raw:'Second pending edit'});
  plugin.scheduleSessionSave(b.session);plugin.app={workspace:{getLeavesOfType:()=>[],detachLeavesOfType(){}}};
  plugin.onunload();await plugin.saveQueue;
  assert.equal(plugin.sessionTimers.size,0);
  assert.equal(env.conversationState.get(a.id).session.entries.at(-1).raw,'First pending edit');
  assert.equal(env.conversationState.get(b.id).session.entries.at(-1).raw,'Second pending edit');await view.onClose();
});

test('a submitted mention retains its library and parser credentials across model discovery',async()=>{
  const discovery=deferred(),seen=[];let discovering=false;
  const env=await open(undefined,undefined,{keyState:{libraryPath:'first-library',deepseek:'fake',mineru:'first-parser'},listModels:async()=>{discovering=true;return discovery.promise;},libraryApi:{...library,expandMentions:async(text,root,key)=>{seen.push({text,root,key});return text;}}});
  const {view,plugin}=env;view.input.value='Read @[2601.12345]';const first=view.send();await until(()=>discovering);
  plugin.libraryPath='second-library';plugin.keys.mineru='second-parser';discovery.resolve({data:[]});await first;
  view.input.value='Read @[2601.12346]';await view.send();
  assert.deepEqual(seen,[{text:'Read @[2601.12345]',root:'first-library',key:'first-parser'},{text:'Read @[2601.12346]',root:'second-library',key:'second-parser'}]);await view.onClose();
});

test('mention searches share a scan but never reuse a result from an earlier library path',async()=>{
  const scans=[];
  const env=await open(undefined,undefined,{keyState:{libraryPath:'first-library'},libraryApi:{...library,scanLibrary:root=>{const result=deferred();scans.push({root,...result});return result.promise;},searchRecords:records=>records}});
  const {view,plugin,doc,dom}=env;view.input.value='@candidate';view.input.setSelectionRange(10,10);
  const first=view.updateMentions(),second=view.updateMentions();assert.equal(scans.length,1);
  const pathInput=doc.querySelector('.sd-library-path');pathInput.value='second-library';pathInput.dispatchEvent(new dom.window.Event('change'));
  assert.equal(plugin.libraryPath,'second-library');const third=view.updateMentions();assert.equal(scans.length,2);
  scans[1].resolve([{id:'2601.12346',title:'New library'}]);await third;
  scans[0].resolve([{id:'2601.12345',title:'Old library'}]);await Promise.all([first,second]);
  assert.equal(view.libraryRecordsPath,'second-library');assert.equal(view.mentionPopup.textContent,'2601.12346New library');
  assert.equal(view.mentionItems.length,1);await view.onClose();
});

test('a PDF upload batch retains its parser key and a later batch uses the changed key',async()=>{
  const parsed=deferred(),keys=[];
  const env=await open(undefined,async(file,key)=>{keys.push(key);if(file.name==='first.pdf')await parsed.promise;return 'Extracted '+file.name;});
  const {view,plugin}=env;plugin.keys.mineru='first-key';const batch=view.uploadFiles([{name:'first.pdf'},{name:'second.pdf'}]);await until(()=>keys.length===1);
  plugin.keys.mineru='second-key';parsed.resolve();await batch;await view.upload({name:'third.pdf'});
  assert.deepEqual(keys,['first-key','first-key','second-key']);assert.equal(view.messages.filter(message=>message.role==='user').length,3);await view.onClose();
});

test('a moved caret invalidates both pending mention candidates and an already displayed candidate',async()=>{
  const scan=deferred();
  const env=await open(undefined,undefined,{libraryApi:{...library,scanLibrary:()=>scan.promise,searchRecords:records=>records}});
  const {view}=env;view.input.value='Before @candidate';view.input.setSelectionRange(17,17);
  const pending=view.updateMentions();view.input.setSelectionRange(0,0);scan.resolve([{id:'2601.12345',title:'Reference'}]);await pending;
  assert.equal(view.mentionPopup.hidden,true);
  view.input.setSelectionRange(17,17);await view.updateMentions();assert.equal(view.mentionPopup.hidden,false);
  view.input.setSelectionRange(0,0);view.mentionPopup.querySelector('button').click();
  assert.equal(view.input.value,'Before @candidate');assert.equal(view.input.selectionStart,0);assert.equal(view.mentionPopup.hidden,true);await view.onClose();
});

test('an obsolete authentication failure does not open key management after the key was replaced',async()=>{
  const response=deferred();let requests=0;
  const env=await open(async(k,m,s,d)=>{if(requests++===0)return response.promise;assert.equal(k,'replacement-key');d('Retry answer');return usage;});
  const {view,plugin}=env;view.input.value='Question';const sending=view.send();await until(()=>requests===1);
  plugin.keys.deepseek='replacement-key';response.reject(Object.assign(Error('Expired key'),{authExpired:true,authService:'deepseek'}));await sending;
  assert.deepEqual(env.opened,[]);assert.equal(view.controller,null);view.input.value='Retry';await view.send();assert.equal(view.session.entries.at(-1).raw,'Retry answer');await view.onClose();
});

test('the reply copy icon handles a Notebook script with many backtick runs',async()=>{
  const env=await open();const {view,doc}=env;view.row('你','Prepare code');
  const source='`x` '.repeat(150000)+'end';
  const state=view.row('deepseek-flash','Ready for review.');
  state.entry.notebookPatch={baseHash:'0'.repeat(64),operations:[{type:'insert_cell',index:0,cellType:'code',source}]};
  state.element.querySelector('.sd-message-footer .sd-icon-button').click();await until(()=>env.copies.length===1);
  const markdown=env.copies[0],marker='\n```notebook-patch\n',start=markdown.indexOf(marker),end=markdown.lastIndexOf('\n```');
  assert.ok(start>=0&&end>start);assert.equal(JSON.parse(markdown.slice(start+marker.length,end)).operations[0].source,source);
  assert.equal(doc.querySelectorAll('.sd-message').length,2);await view.onClose();
});
