const test=require('node:test');
const assert=require('node:assert/strict');
const {ui}=require('./scripts/test-ui.cjs');
const api=require('./src/notebook');
const usage={prompt_tokens:100,completion_tokens:10,prompt_cache_hit_tokens:60,prompt_cache_miss_tokens:40};
const until=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Workflow checkpoint did not arrive');};
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const notebook=source=>({nbformat:4,nbformat_minor:5,metadata:{},cells:[{id:'base',cell_type:'code',source,metadata:{},execution_count:null,outputs:[]}]});
function client(value){return {connected:true,closed:false,read:()=>structuredClone(value),close(){this.closed=true;this.connected=false;}};}
const names=options=>options.tools.map(tool=>tool.function?.name || tool.type);

const firstPlot='R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const secondPlot='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2XkAAAAASUVORK5CYII=';
const plot=(mime,base64)=>({output_type:'display_data',data:{[mime]:base64,'text/plain':'<Figure>'}});

test('Notebook figures use native file blocks and a changed figure alone counts as a pending delta',async()=>{
  const values=[],book=notebook('display(plot)');
  book.cells[0].outputs=[plot('image/gif',firstPlot),plot('image/gif',firstPlot)];
  const env=ui(async(_k,m,_s,d)=>{values.push(m.at(-1).content);d('answer');return usage;},async()=>'');
  await env.plugin.onload();env.plugin.keys.deepseek='fake';
  const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient=client(book);
  const send=async mode=>{view.notebookAttach.value=mode;view.input.value='figure';await view.send();};
  await send('none');assert.equal(env.fileUploads.length,0);
  await send('delta');assert.equal(env.fileUploads.length,1);
  assert.equal(values[1].filter(p=>p.type==='file').length,1);
  assert.ok(values[1][0].text.includes(env.fileUploads[0].hash));
  assert.equal(view.session.entries[2].files[0].notebookFigure,true);
  await send('delta');assert.equal(typeof values[2],'string');assert.equal(env.fileUploads.length,1);
  book.cells[0].outputs[1]=plot('image/png',secondPlot);
  assert.equal(api.notebookDelta(book,view.notebookSnapshot).changed.length,1);
  await send('delta');assert.equal(env.fileUploads.length,2);assert.equal(values[3].filter(p=>p.type==='file').length,1);
  await send('all');assert.equal(typeof values[4],'string');assert.equal(env.fileUploads.length,2);
  const previous=view.session.entries.at(-1);await view.deleteTurn(previous);
  assert.equal(view.pendingFiles.length,0);
  assert.ok(!JSON.stringify(view.session).includes(firstPlot));assert.ok(!JSON.stringify(view.session).includes(secondPlot));
  assert.ok(!JSON.stringify(api.resultJson(book)).includes('figures'));
  await view.onClose();
});

test('a Notebook disconnected during output image upload cannot attach that image to the pending request',async()=>{
  const book=notebook('display(plot)');book.cells[0].outputs=[plot('image/gif',firstPlot)];
  let finish,request;
  const env=ui(async(_k,m,_s,d)=>{request=m;d('answer');return usage;},async()=>'',{deepseekFiles:{uploadFile:async(file)=>new Promise(resolve=>{finish=()=>resolve({id:'file-api-stale',name:file.name,bytes:file.size,purpose:'user_data',expiresAt:Date.now()/1000+1000});})}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient=client(book);
  view.input.value='figure';const sending=view.send();await until(()=>finish);
  await view.disconnectNotebook();finish();await sending;
  assert.ok(request);assert.ok(!JSON.stringify(request).includes('file-api-stale'));assert.ok(!JSON.stringify(request).includes('display(plot)'));
  assert.equal(view.session.entries[0].files.length,0);await view.onClose();
});

test('a changed plot arrives as native vision on the next Notebook tool step and survives history reload',async()=>{
  const book=notebook('display(plot)');book.cells[0].outputs=[plot('image/gif',firstPlot)];
  let calls=0,second;
  const env=ui(async(_k,m,_s,d,_h,options)=>{
    if (++calls===1) {
      options.onToolCalls([call('read','read_notebook',{})]);
      book.cells[0].outputs=[plot('image/png',secondPlot)];
    } else { second=m;d('answer'); }
    return usage;
  },async()=>'');
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient=client(book);
  view.input.value='Read the figure';await view.send();
  assert.equal(calls,2);assert.equal(env.fileUploads.length,2);
  const changed=second.at(-1);assert.equal(changed.role,'user');assert.ok(changed.content[0].text.includes('Notebook changed during generation'));
  assert.equal(changed.content.at(-1).file_id,env.fileUploads[1].id);assert.ok(!JSON.stringify(second).includes(secondPlot));
  const expected=JSON.stringify(view.messages);await view.onClose();
  const reopened=ui(async()=>{},async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState});
  await reopened.plugin.onload();assert.deepEqual(JSON.parse(JSON.stringify(reopened.plugin.session.messages)),JSON.parse(expected));
});

test('after context compression a Notebook plot can be sent again by file ID without reuploading bytes',async()=>{
  const book=notebook('display(plot)');book.cells[0].outputs=[plot('image/gif',firstPlot)];
  const env=ui(async(_k,_m,_s,d)=>{d('short answer');return {...usage,prompt_tokens:10000};},async()=>'');
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient=client(book);
  view.input.value='figure';await view.send();await view.manualCompress();
  assert.equal(view.notebookSnapshot,null);assert.equal(view.session.compactions,1);
  view.input.value='review it';await view.send();
  const again=view.messages.findLast(m=>m.role==='user'&&Array.isArray(m.content));assert.ok(again);
  assert.equal(again.content.at(-1).file_id,env.fileUploads[0].id);assert.equal(env.fileUploads.length,1);
  await view.onClose();
});

test('a connection replaced during model discovery cannot supply either Notebook to that turn',async()=>{
  let discover,requests=0;const a=client(notebook('NOTEBOOK_A')),b=client(notebook('NOTEBOOK_B'));
  const env=ui(async(k,m,s,d,h,o)=>{if(requests++===0){assert.deepEqual(names(o),['deepseek_web_search','deepseek_read_url']);assert.ok(!m.at(-1).content.includes('NOTEBOOK_A'));assert.ok(!m.at(-1).content.includes('NOTEBOOK_B'));}else{assert.ok(names(o).includes('stage_notebook_edits'));assert.ok(m.at(-1).content.includes('NOTEBOOK_B'));}d('Answer');return usage;},async()=>'',{saved:{uiLanguage:'en'},listModels:async()=>new Promise(resolve=>discover=()=>resolve({data:[]}))});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient=a;view.input.value='Discuss the notebook';const sending=view.send();await until(()=>discover);await view.disconnectNotebook();view.notebookClient=b;discover();await sending;
  assert.equal(view.session.entries[0].notebookAttached,undefined);view.input.value='Now read the notebook';await view.send();assert.equal(requests,2);await view.onClose();
});

test('Notebook mode permits ordinary chat while connecting and grants access only to a later ready turn',async()=>{
  const c=client(notebook('READY_NOTEBOOK'));c.connected=false;let requests=0;
  const env=ui(async(k,m,s,d,h,o)=>{if(!requests++){assert.deepEqual(names(o),[]);assert.match(m[0].content,/Notebook access is unavailable/);}else{assert.ok(names(o).includes('read_notebook'));assert.ok(m.at(-1).content.includes('READY_NOTEBOOK'));}d('Ordinary answer');return usage;},async()=>'',{saved:{uiLanguage:'en',webEnabled:false}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient=c;view.input.value='Explain a loop';await view.send();assert.equal(view.session.meter.includeReasoning,false);assert.equal(view.session.meter.systemPrompt,view.requestPrompt());assert.ok(!view.metrics.textContent.includes('~'));
  c.connected=true;view.input.value='Read this Notebook';await view.send();assert.equal(requests,2);await view.onClose();
});

test('accepted edits survive disconnect while a web tool finishes and a replacement cannot join the old turn',async()=>{
  let step=0,releaseWeb,firstContext,webCalls=0;
  const a=client(notebook('ORIGINAL_NOTEBOOK')),b=client(notebook('REPLACEMENT_NOTEBOOK'));
  const env=ui(async(k,m,s,d,h,o)=>{
    if(step===0){firstContext=m.at(-1).content;const task=JSON.parse(firstContext.split('[Notebook edit task]\n')[1].split('\n')[0]);o.onToolCalls([call('chunk','stage_notebook_edits',{baseHash:task.currentHash,operations:[{type:'source_chunk',chunkId:'source',part:0,operation:{type:'insert_cell',index:1,cellType:'code'},source:'print("part one")\n'}],done:false})]);}
    else if(step===1)o.onToolCalls([call('search','search_web',{query:'reference'})]);
    else if(step===2){assert.deepEqual(names(o),['search_web','fetch_page']);assert.ok(m.some(message=>message.content?.includes('[Notebook unavailable]')));assert.ok(!JSON.stringify(m).includes('REPLACEMENT_NOTEBOOK'));d('The connection was closed; staged edits were kept.');}
    else{assert.ok(names(o).includes('stage_notebook_edits'));assert.ok(m.at(-1).content.includes('REPLACEMENT_NOTEBOOK'));d('New turn uses the replacement.');}
    step++;return usage;
  },async()=>'',{saved:{uiLanguage:'en',webEnabled:true},webHttp:async()=>{webCalls++;await new Promise(resolve=>releaseWeb=resolve);return Buffer.from(JSON.stringify({results:[]}));}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient=a;view.input.value='Prepare code and read a reference';const sending=view.send();await until(()=>releaseWeb);await view.disconnectNotebook();view.notebookClient=b;releaseWeb();await sending;
  const entry=view.session.entries.at(-1),task=view.session.notebookTasks[entry.notebookTaskId];assert.equal(task.state.revision,1);assert.equal(api.NotebookEditBuffer.restore(task.state).status().pendingChunks,1);assert.equal(entry.notebookPatch,undefined);assert.ok(view.session.entries[0].contextText.includes('[Notebook edit task]'));assert.ok(view.session.messages[0].content.includes('[Notebook edit task]'));assert.equal(view.session.entries[0].contextText,firstContext);assert.equal(webCalls,1);
  const toolResults=entry.modelMessages.filter(message=>message.role==='tool').map(message=>message.tool_call_id);assert.deepEqual(Array.from(toolResults),['chunk','search']);view.input.value='Use the new Notebook';await view.send();assert.equal(step,4);await view.onClose();
});

test('web failure and a checkbox change preserve current scope and affect only the next turn',async()=>{
  let step=0;
  const env=ui(async(k,m,s,d,h,o)=>{
    const current=step++;
    if(current===0){
      assert.ok(names(o).includes('deepseek_web_search'));
      view.searchFetchToggle.checked=false;view.searchFetchToggle.dispatchEvent(new env.dom.window.Event('change'));
      assert.ok(names(o).includes('deepseek_web_search'));
      o.onServerToolEvent({type:'call_started',step:0,call:{type:'deepseek_web_search',action:{type:'search',queries:['current information']}}});
      throw Error('Network lost');
    }
    if(current===1){assert.deepEqual(names(o),[]);d('Answer without web access.');}
    else{assert.ok(names(o).includes('deepseek_web_search'));d('Web is available again.');}
    return usage;
  },async()=>'',{saved:{uiLanguage:'en',webEnabled:true},webHttp:async()=>assert.fail('Native web must stay on the chat endpoint')});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='Find a source';await view.send();assert.equal(view.sendButton.disabled,false);view.input.value='Continue offline';await view.send();view.searchFetchToggle.checked=true;view.searchFetchToggle.dispatchEvent(new env.dom.window.Event('change'));view.input.value='Try online again';await view.send();assert.equal(step,3);await view.onClose();
});

test('native web sources, signed history and estimated context survive view close and reload',async()=>{
  const steps=[{index:0,reasoning_content:'Search',calls:[{index:0,type:'deepseek_read_url',kind:'read_link',status:'completed',page:{url:'https://example.com',title:'Example'},signature:'opaque'}]}];
  const env=ui(async(k,m,s,d,h,o)=>{
    assert.deepEqual(names(o),['deepseek_web_search','deepseek_read_url']);
    o.onThinking('Search');o.onServerToolEvent({type:'call_completed',step:0,call:steps[0].calls[0]});
    d('Answer');o.onServerToolCalls(steps,{reasoningContent:'Final'});o.onAnnotations([{type:'url_citation',url_citation:{url:'https://example.com',title:'Example',start_index:0,end_index:6}}]);
    return {...usage,prompt_tokens:2000000};
  },async()=>'',{saved:{uiLanguage:'en',webEnabled:true}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='Read a source';await view.send();
  assert.equal(view.session.meter.estimated,true);assert.equal(view.session.meter.upperBound,true);assert.equal(view.session.meter.tokens,2000010);assert.equal(view.session.meter.systemPrompt,view.requestPrompt());
  assert.equal(view.session.entries.at(-1).sources[0].url,'https://example.com');
  assert.equal(view.session.messages.at(-1).server_tool_calls[0].calls[0].signature,'opaque');
  await view.onClose();
  const restored=ui(async()=>assert.fail('Reload cannot request the model'),async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState});
  await restored.plugin.onload();
  assert.equal(restored.plugin.session.messages.at(-1).server_tool_calls[0].calls[0].signature,'opaque');
  assert.equal(restored.plugin.session.meter.estimated,true);
  assert.equal(restored.plugin.session.meter.upperBound,true);
});

test('an AI transport error is archived and does not disconnect the independent Notebook',async()=>{
  let requests=0;const c=client(notebook('print(42)'));c.executeCell=async()=>({index:0,outputs:[{output_type:'stream',name:'stdout',text:'42'}],notebook:c.read()});
  const env=ui(async(k,m,s,d,h,o)=>{if(!requests++){o.onThinking('Received before the local failure.');throw TypeError('Illegal invocation');}d('Retry succeeds.');return usage;},async()=>'',{saved:{uiLanguage:'en',webEnabled:true}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient=c;view.input.value='Explain';await view.send();const entry=view.session.entries.at(-1);assert.equal(entry.failedRequests[0].error,'Illegal invocation');assert.equal(entry.thinking,'Received before the local failure.');assert.equal(c.closed,false);assert.equal(view.notebookClient,c);assert.equal(view.sendButton.disabled,false);
  await view.runNotebookCell();assert.ok(view.session.entries.at(-1).notebookEvent);view.input.value='Retry';await view.send();assert.equal(view.session.entries.at(-1).raw,'Retry succeeds.');await view.onClose();const restored=ui(async()=>assert.fail('Reload cannot request the model'),async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState});await restored.plugin.onload();assert.ok(restored.plugin.session.entries.some(item=>item.failedRequests?.[0]?.error==='Illegal invocation'));
});

test('review confirmation cannot transfer permission to a replacement Notebook connection',async()=>{
  const value={nbformat:4,nbformat_minor:5,metadata:{},cells:[]};let oldApplied=0,newApplied=0;
  const a=client(value),b=client(value);a.applyPatch=async()=>{oldApplied++;return value;};b.applyPatch=async patch=>{newApplied++;return api.validatePatch(value,patch).notebook;};
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();view.notebookClient=a;view.row('你','Add code');const row=view.row('deepseek-flash','Ready.');row.entry.notebookPatch={baseHash:api.notebookHash(value),operations:[{type:'insert_cell',index:0,cellType:'code',source:'print(42)'}]};view.addPatchAction(row);row.patchButton.click();await until(()=>env.doc.querySelector('.sd-confirm'));await view.disconnectNotebook();view.notebookClient=b;view.setNotebookStatus('connected');env.doc.querySelector('.sd-confirm .mod-cta').click();await new Promise(setImmediate);
  assert.equal(oldApplied,0);assert.equal(newApplied,0);assert.match(view.status.textContent,/connection changed/);assert.equal(view.notebookStatus.textContent,'RTC connected');row.patchButton.click();await until(()=>env.doc.querySelector('.sd-confirm'));env.doc.querySelector('.sd-confirm .mod-cta').click();await until(()=>!view.applyingNotebookPatch&&!view.notebookOperationToken);assert.equal(newApplied,1);assert.equal(oldApplied,0);await view.onClose();
});

test('an applied old transaction retains its receipt after disconnect without replacing new UI state',async()=>{
  const value={nbformat:4,nbformat_minor:5,metadata:{},cells:[]},replacement=notebook('NEW_CONNECTION');let finish,applied=0;
  const a=client(value),b=client(replacement);a.applyPatch=async patch=>{applied++;await new Promise(resolve=>finish=resolve);throw Object.assign(Error('Confirmation lost'),{applied:true,notebook:api.validatePatch(value,patch).notebook});};
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();view.notebookClient=a;view.row('你','Add code');const row=view.row('deepseek-flash','Ready.');row.entry.notebookPatch={baseHash:api.notebookHash(value),operations:[{type:'insert_cell',index:0,cellId:'submitted',cellType:'code',source:'print(42)'}]};view.addPatchAction(row);row.patchButton.click();await until(()=>env.doc.querySelector('.sd-confirm'));env.doc.querySelector('.sd-confirm .mod-cta').click();await until(()=>finish);await view.disconnectNotebook();view.notebookClient=b;view.notebookLatest=replacement;view.setNotebookStatus('connected');finish();await until(()=>!view.applyingNotebookPatch);
  assert.equal(row.entry.notebookApplied,true);assert.equal(row.entry.notebookUnverified,true);assert.equal(row.patchButton.disabled,true);assert.equal(view.notebookLatest,replacement);assert.equal(view.notebookStatus.textContent,'RTC connected');assert.ok(view.session.messages.some(message=>message.content?.includes('"verified":false')));row.patchButton.click();assert.equal(applied,1);await view.onClose();
});

test('late handshake and old status callbacks cannot replace a newer connection',async()=>{
  const instances=[],stopped=[],locations={jupyterExecutablePath:'C:/test/jupyter.exe',notebookFilePath:'C:/test/test.ipynb'};let starts=0;
  class PendingClient{
    constructor(options){this.options=options;this.closed=false;this.connected=false;this.number=instances.length;instances.push(this);}
    async connect(){this.options.onStatus('connecting');await new Promise(resolve=>this.finish=resolve);this.connected=true;this.options.onStatus('connected');return this.read();}
    read(){return notebook('CONNECTION_'+this.number);}
    onChange(fn){this.change=fn;return()=>{};}
    close(){if(this.closed)return;this.closed=true;this.connected=false;this.options.onStatus('disconnected',Error('Closed'));}
  }
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'},keyState:locations,notebookApi:{...api,JupyterRtcClient:PendingClient},jupyterLocalApi:{startLocalJupyter:async()=>{const number=++starts;return{number,child:{pid:number},root:'C:/test',name:'test.ipynb',baseUrl:'http://127.0.0.1:'+number,token:'test',browserUrl:'http://127.0.0.1:'+number+'/lab'};},stopLocalJupyter:async local=>{if(local)stopped.push(local.number);}}});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;const first=view.connectNotebook();await until(()=>instances[0]?.finish);await view.connectNotebook();assert.equal(starts,1);await view.disconnectNotebook();const second=view.connectNotebook();await until(()=>instances[1]?.finish);const newer=instances[1];instances[0].finish();await first;
  assert.equal(view.notebookClient,newer);assert.equal(view.notebookStatus.textContent,'Connecting…');assert.ok(!stopped.includes(2));newer.finish();await second;instances[0].options.onStatus('disconnected',Error('Late old failure'));assert.equal(view.notebookClient,newer);assert.equal(view.notebookStatus.textContent,'RTC connected');assert.equal(view.session.entries.filter(entry=>entry.notebookEvent).length,1);assert.deepEqual(env.opened,['http://127.0.0.1:2/lab']);await view.onClose();
});

test('repeated disconnect keeps the pending owned-server shutdown barrier for the next connection',async()=>{
  let finishShutdown,starts=0,stops=0;
  class ReadyClient{constructor(){this.closed=false;this.connected=true;}async connect(){return notebook('READY');}read(){return notebook('READY');}onChange(){return()=>{};}close(){this.closed=true;this.connected=false;}}
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'},keyState:{jupyterExecutablePath:'C:/test/jupyter.exe',notebookFilePath:'C:/test/test.ipynb'},notebookApi:{...api,JupyterRtcClient:ReadyClient},jupyterLocalApi:{startLocalJupyter:async()=>{starts++;return{root:'C:/test',name:'test.ipynb',baseUrl:'http://127.0.0.1:2',token:'test',browserUrl:'http://127.0.0.1:2/lab'};},stopLocalJupyter:async()=>{stops++;await new Promise(resolve=>finishShutdown=resolve);}}});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient=new ReadyClient();view.localJupyter={child:{pid:1}};const first=view.disconnectNotebook(),second=view.disconnectNotebook();assert.equal(first,second);const connecting=view.connectNotebook();await new Promise(setImmediate);assert.equal(starts,0);assert.equal(stops,1);finishShutdown();await Promise.all([first,connecting]);assert.equal(starts,1);assert.equal(view.notebookStatus.textContent,'RTC connected');await view.onClose();
});
