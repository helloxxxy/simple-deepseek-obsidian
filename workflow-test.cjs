const test = require('node:test');
const assert = require('node:assert/strict');
const {ui} = require('./scripts/test-ui.cjs');

const until = async predicate => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for the workflow checkpoint');
};

async function delayedHistory() {
  let hold = false, held = false, release, finish, requests = 0;
  const trashed = [];
  const env = ui(async (_key, _messages, _signal, onText) => {
    requests++; onText('First reply');
    await new Promise(resolve => { finish = resolve; });
    onText(' last reply');
    return {prompt_tokens:100,completion_tokens:5};
  }, async () => '', {
    saved:{uiLanguage:'en'},
    save:async () => {
      if (hold && !held) { held = true; await new Promise(resolve => { release = resolve; }); }
    },
    trashConversation:async id => { trashed.push(id); return env.conversationState.delete(id); }
  });
  await env.plugin.onload(); env.plugin.keys.deepseek = 'fake';
  const view = env.plugin.factory({}); await view.onOpen();
  view.row('你','Seed question'); view.row('deepseek-flash','Seed answer');
  const originalId = env.plugin.activeConversationId, original = view.session;
  const other = env.plugin.addConversation();
  hold = true;
  return {env,view,originalId,original,other,trashed,
    get waiting() { return !!release; },
    release:() => release(),
    get requests() { return requests; },
    finish:() => finish?.()
  };
}

test('history save and a new generation cannot change sessions beneath one another', async () => {
  for (const action of ['switch','new']) {
    const f = await delayedHistory();
    const changing = action === 'switch' ? f.view.switchConversation(f.other.id) : f.view.newConversation();
    await until(() => f.waiting);
    f.view.input.value = 'Question during history save';
    const sending = f.view.send();
    await new Promise(resolve => setTimeout(resolve, 25));
    const controller = f.view.controller;
    f.release(); await changing;
    if (controller) {
      assert.equal(f.view.session, f.original, action + ' must not cross a live request');
      assert.equal(f.other.session.entries.length, 0);
      assert.equal(f.other.session.meter, null);
    } else assert.equal(f.requests, 0, action + ' must prevent send during its transition');
    f.finish(); await sending; await f.view.onClose();
  }
});

test('closing while new-history save waits cannot create a later invisible conversation', async () => {
  const f = await delayedHistory(), count = f.env.plugin.conversations.length;
  const changing = f.view.newConversation(); await until(() => f.waiting);
  const closing = f.view.onClose(); f.release(); await Promise.all([changing,closing]);
  assert.equal(f.env.plugin.conversations.length,count);
  assert.equal(f.env.plugin.activeConversationId,f.originalId);
});

test('history transitions and clear recycle the same captured conversation and cannot remove a different one', async () => {
  for (const action of ['switch','new']) {
    const f = await delayedHistory(), originalIds = f.env.plugin.conversations.map(item => item.id);
    const changing = action === 'switch' ? f.view.switchConversation(f.other.id) : f.view.newConversation();
    await until(() => f.waiting);
    const clearing = f.view.clear(); f.release(); await Promise.all([changing,clearing]);
    const retained = new Set(f.env.plugin.conversations.map(item => item.id));
    for (const id of f.trashed) assert.equal(retained.has(id),false,'a recycled conversation must be removed from the live list');
    for (const id of originalIds) if (!retained.has(id)) assert.ok(f.trashed.includes(id),'a removed conversation must be the one recycled');
    assert.equal(f.env.plugin.retiredConversationIds.has(f.env.plugin.activeConversationId),false);
    await f.view.onClose();
  }
});

test('a Notebook operation finishing after a history switch records only in its initiating conversation', async () => {
  let finish;
  const env = ui(async () => {},async () => '',{saved:{uiLanguage:'en'}});
  await env.plugin.onload(); const view = env.plugin.factory({}); await view.onOpen();
  const original = view.session, other = env.plugin.addConversation();
  const notebook = {nbformat:4,nbformat_minor:5,cells:[{id:'calc',cell_type:'code',source:'print(42)',metadata:{},outputs:[],execution_count:1}],metadata:{}};
  view.notebookClient = {runAll:async () => {await new Promise(resolve => {finish = resolve;}); return notebook;},read:() => notebook,close(){}};
  const running = view.runNotebookAll(); await until(() => finish);
  await view.switchConversation(other.id); finish(); await running;
  assert.equal(original.entries.filter(entry => entry.notebookEvent).length,1);
  assert.equal(other.session.entries.filter(entry => entry.notebookEvent).length,0);
  await view.onClose();
});

test('thinking display failure recovers before Stop and later thoughts keep updating across collapse and retry',async()=>{
  const {TextPacer}=require('./src/pacing');
  for(const rate of [0,50]){
    let reason,requests=0;
    class FailingThinkingPacer extends TextPacer {
      constructor(options){
        const frame=options.onFrame;let frames=0;
        super({...options,onFrame:chunk=>{if(options.frameMs===48&&++frames===2)throw Error('Injected thinking frame failure');return frame(chunk);}});
      }
    }
    const env=ui(async(k,m,signal,onText,http,options)=>{
      if(requests++){onText('Next answer.');return{completion_tokens:3};}
      reason=options.onThinking;
      await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('stopped'),{name:'AbortError'})),{once:true}));
    },async()=>'',{saved:{uiLanguage:'en',webEnabled:false,displayTokensPerSecond:rate},TextPacer:FailingThinkingPacer});
    await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='Think';const pending=view.send();await until(()=>reason);
    const row=[...view.rows].at(-1);reason('First line.\n'.repeat(10));await new Promise(resolve=>setTimeout(resolve,160));row.thinkingBox.open=true;row.thinkingBox.dispatchEvent(new env.dom.window.Event('toggle'));
    reason('Subsequent reasoning.\n'.repeat(200));await until(()=>row.thinkingPlaybackFailed);await new Promise(resolve=>setTimeout(resolve,140));
    assert.ok(view.controller);assert.equal(row.thinkingBody.textContent,row.entry.thinking,'recovery must happen before generation ends');
    row.thinkingBox.open=false;row.thinkingBox.dispatchEvent(new env.dom.window.Event('toggle'));reason('Received while collapsed.\n');await new Promise(setImmediate);row.thinkingBox.open=true;row.thinkingBox.dispatchEvent(new env.dom.window.Event('toggle'));reason('Received after reopening.\n');await new Promise(resolve=>setTimeout(resolve,140));assert.equal(row.thinkingBody.textContent,row.entry.thinking);
    const raw=row.entry.thinking;view.sendButton.click();await pending;assert.equal(row.thinkingBody.textContent,raw);assert.equal(row.entry.thinking,raw);assert.ok(!JSON.stringify(view.session).includes('Injected thinking frame failure'));
    view.input.value='Continue';await view.send();assert.equal(view.session.entries.at(-1).raw,'Next answer.');assert.equal(view.sendButton.disabled,false);await view.onClose();
  }
});

test('selecting live thinking defers automatic collapse until the selection is released',async()=>{
  let stream,finish;const env=ui(async(k,m,s,d,h,o)=>{stream={reason:o.onThinking,text:d};await new Promise(resolve=>finish=resolve);return{completion_tokens:10};},async()=>'',{saved:{uiLanguage:'en',webEnabled:false}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='Explain';const pending=view.send();await until(()=>stream);const row=[...view.rows].at(-1);
  stream.reason('Select this thought.\nLater evidence.');row.thinkingBox.open=true;row.thinkingBox.dispatchEvent(new env.dom.window.Event('toggle'));await new Promise(resolve=>setTimeout(resolve,140));
  const range=env.doc.createRange(),selection=env.doc.getSelection();range.setStart(row.thinkingBody.firstChild.firstChild,0);range.setEnd(row.thinkingBody.firstChild.firstChild,6);selection.addRange(range);env.doc.dispatchEvent(new env.dom.window.Event('selectionchange'));stream.text('The formal answer.');await until(()=>row.raw==='The formal answer.');
  assert.equal(row.thinkingBox.open,true);assert.equal(selection.toString(),'Select');assert.equal(view.thinkingCollapseDeferredRows.has(row),true);
  selection.removeAllRanges();env.doc.dispatchEvent(new env.dom.window.Event('selectionchange'));assert.equal(row.thinkingBox.open,false);assert.equal(view.thinkingCollapseDeferredRows.size,0);finish();await pending;await view.onClose();
});

test('Notebook completion during a history save unlocks current controls and retains the initiating record',async()=>{
  let hold=false,releaseSave,finish;const env=ui(async()=>{},async()=>'',{save:async()=>{if(hold){hold=false;await new Promise(resolve=>releaseSave=resolve);}}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  const original=view.session,other=env.plugin.addConversation(),notebook={cells:[]};view.notebookClient={read:()=>notebook,runAll:async()=>{await new Promise(resolve=>finish=resolve);return notebook;},close(){}};
  const running=view.runNotebookAll();await until(()=>finish);hold=true;const changing=view.switchConversation(other.id);await until(()=>releaseSave);finish();await running;assert.equal(view.runAllButton.disabled,true);releaseSave();await changing;
  assert.equal(view.runAllButton.disabled,false);assert.equal(original.entries.filter(entry=>entry.notebookEvent).length,1);assert.equal(other.session.entries.filter(entry=>entry.notebookEvent).length,0);await view.onClose();
});

test('a disconnected old Notebook run cannot enable a replacement run or update its status',async()=>{
  let finishOld,finishNew;const notebook={cells:[]},env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  view.notebookClient={read:()=>notebook,runAll:async()=>{await new Promise(resolve=>finishOld=resolve);return notebook;},close(){}};const oldRun=view.runNotebookAll();await until(()=>finishOld);await view.disconnectNotebook();
  view.notebookClient={read:()=>notebook,runAll:async()=>{await new Promise(resolve=>finishNew=resolve);return notebook;},close(){}};const newRun=view.runNotebookAll();await until(()=>finishNew);view.setNotebookStatus('executing','Replacement run');const status=view.notebookStatus.textContent;
  finishOld();await oldRun;assert.equal(view.runAllButton.disabled,true);assert.equal(view.notebookStatus.textContent,status);assert.ok(view.notebookOperationToken);finishNew();await newRun;assert.equal(view.runAllButton.disabled,false);await view.onClose();
});

test('returning to a saved Notebook review restores only unapplied actions after the history transition',async()=>{
  const api=require('./src/notebook');
  for(const applied of [false,true]){
    const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();const original=env.plugin.activeConversationId,other=env.plugin.addConversation();
    other.session.entries.push({label:'你',raw:'Prepare code'},{label:'deepseek-flash',raw:'Ready for review.',notebookPatch:{baseHash:api.notebookHash({cells:[]}),operations:[{type:'insert_cell',index:0,cellId:'new-code',cellType:'code',source:'print(42)'}]},...(applied?{notebookApplied:true}:{})});
    await view.switchConversation(other.id);assert.equal(env.doc.querySelector('.sd-notebook-apply').disabled,applied);await view.switchConversation(original);await view.switchConversation(other.id);assert.equal(env.doc.querySelector('.sd-notebook-apply').disabled,applied);assert.equal(!!view.conversationTransition,false);await view.onClose();
  }
});

test('closing and reopening the same view invalidates a pending history transition',async()=>{
  const f=await delayedHistory(),count=f.env.plugin.conversations.length;const changing=f.view.newConversation();await until(()=>f.waiting);const closing=f.view.onClose();await new Promise(setImmediate);await f.view.onOpen();f.release();await Promise.all([changing,closing]);
  assert.equal(f.env.plugin.conversations.length,count);assert.equal(f.env.plugin.activeConversationId,f.originalId);assert.equal(f.view.closed,false);assert.equal(f.view.sendButton.disabled,false);await f.view.onClose();
});

test('a saved deletion review refuses an attachment replaced during confirmation without transmitting the image',async()=>{
  const api=require('./src/notebook'),originalImage='ORIGINAL_ATTACHMENT_IMAGE_BYTES',replacement='REPLACED_ATTACHMENT_IMAGE_BYTES';
  let notebook={nbformat:4,nbformat_minor:5,metadata:{},cells:[{id:'figure',cell_type:'markdown',metadata:{},source:'![figure](attachment:figure.png)',attachments:{'figure.png':{'image/png':originalImage}}}]},applied=0;
  const buffer=new api.NotebookEditBuffer(notebook);buffer.stage({baseHash:buffer.currentHash,operations:[{type:'delete_cell',cellId:'figure'}],done:true});
  const env=ui(async()=>assert.fail('Review cannot request a model'),async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();view.notebookClient={read:()=>structuredClone(notebook),applyPatch:async()=>{applied++;assert.fail('Conflicting deletion cannot reach RTC');},close(){}};
  view.session.notebookTasks={[buffer.taskId]:{state:JSON.parse(JSON.stringify(buffer.exportState())),identity:view.notebookIdentity()}};
  view.row('你','Delete the old figure');const entry={label:'deepseek-flash',raw:'Awaiting review.',notebookTaskId:buffer.taskId,notebookTaskRevision:buffer.revision,notebookTaskIdentity:view.notebookIdentity(),notebookPatch:buffer.result()};view.session.entries.push(entry);view.row(entry.label,entry.raw,entry);
  env.doc.querySelector('.sd-notebook-apply').click();await until(()=>env.doc.querySelector('.sd-confirm'));notebook.cells[0].attachments['figure.png']['image/png']=replacement;env.doc.querySelector('.sd-confirm .mod-cta').click();await until(()=>!view.notebookOperationToken);
  assert.equal(applied,0);assert.equal(notebook.cells.length,1);assert.equal(notebook.cells[0].attachments['figure.png']['image/png'],replacement);assert.ok(env.doc.querySelector('.sd-notebook-regenerate'));const archived=JSON.stringify(view.session);assert.ok(!archived.includes(originalImage));assert.ok(!archived.includes(replacement));await view.onClose();
});
