const test = require('node:test');
const assert = require('node:assert/strict');
const { ModelCatalog, modelCapabilities } = require('./src/models');

test('Flash aliases use native web while Pro retains chat and standalone search', async () => {
  const {ui} = require('./scripts/test-ui.cjs');
  const requests = [];
  const env = ui(async (_key, messages, _signal, onText, _http, options) => {
    requests.push({model:options.model, tools:options.tools.map(tool => tool.function?.name || tool.type), prompt:messages[0].content});
    onText('OK');
    return {prompt_tokens:30,completion_tokens:2};
  }, async () => '', {saved:{webEnabled:true,uiLanguage:'en'}});
  await env.plugin.onload(); env.plugin.keys.deepseek = 'fake';
  const view = env.plugin.factory({}); await view.onOpen();
  for (const model of ['deepseek-v4-pro','deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp']) {
    env.plugin.model = model; view.input.value = 'hello'; await view.send();
    const request = requests.at(-1);
    assert.equal(request.model,model);
    assert.equal(request.prompt,view.requestPrompt());
    assert.deepEqual(Array.from(request.tools),model === 'deepseek-v4-pro' ? ['search_web','fetch_page'] : ['deepseek_web_search','deepseek_read_url']);
  }
  await view.onClose();
});

test('Pro checks pending, library and historical file references before upload, generation and compression', async () => {
  const {ui} = require('./scripts/test-ui.cjs');
  const file = {name:'paper.pdf',size:4,arrayBuffer:async () => Buffer.from('test')};
  const library = require('./src/library');
  let chats = 0;
  const env = ui(async () => { chats++; }, async () => '', {saved:{webEnabled:false,uiLanguage:'en',model:'deepseek-v4-pro'}, libraryApi:{...library,expandMentions:async (text,root,key,signal,notify,parse,options) => {
    if (text.includes('@[paper]')) await options.onFile(file);
    return text;
  }}});
  await env.plugin.onload(); env.plugin.keys.deepseek = 'fake';
  const view = env.plugin.factory({}); await view.onOpen();
  view.input.value = 'Read this'; await view.uploadFiles([file]); await view.send();
  assert.match(view.status.textContent,/deepseek-flash/);
  assert.equal(view.input.value,'Read this'); assert.equal(view.pendingFiles.length,1);
  view.pendingFiles = []; view.input.value = '@[paper]'; await view.send();
  assert.equal(view.input.value,'@[paper]'); assert.equal(env.fileUploads.length,0); assert.equal(view.messages.length,0);
  view.messages.push({role:'user',content:[{type:'text',text:'Earlier attachment'},{type:'file',file_id:'file-api-prior'}]});
  view.input.value = 'Follow up'; await view.send(); assert.equal(view.input.value,'Follow up');
  await view.manualCompress(); assert.match(view.status.textContent,/deepseek-flash/);
  assert.equal(view.messages.length,1); assert.equal(chats,0);
  await view.onClose();
});

test('model metadata is cached in memory per key and expires', async () => {
  let now=0,calls=0;
  const catalog=new ModelCatalog({now:()=>now,ttlMs:100,fetchModels:async()=>{calls++;return{data:[{id:'custom',context_window:32768,max_output_tokens:4096,input_modalities:['text'],effort:{supported_levels:['low','high'],default_level:'low'}}]};}});
  const first=await catalog.get('secret-key-one','custom');assert.equal(first.contextWindow,32768);assert.equal(first.maxOutputTokens,4096);
  assert.deepEqual(first.reasoningEfforts,['low','high']);assert.equal(first.defaultEffort,'low');
  await catalog.get('secret-key-one','custom');assert.equal(calls,1);
  await catalog.get('secret-key-two','custom');assert.equal(calls,2);
  assert.ok(!JSON.stringify([...catalog.cache.keys()]).includes('secret-key'));
  now=101;await catalog.get('secret-key-one','custom');assert.equal(calls,3);
});
test('discovery failure or missing metadata falls back without blocking custom model names',async()=>{
  let now=0,calls=0;
  const catalog=new ModelCatalog({now:()=>now,failureTtlMs:10,fetchModels:async()=>{calls++;throw Error('offline');}});
  const unknown=await catalog.get('key','future-model');assert.equal(unknown.id,'future-model');assert.equal(unknown.contextWindow,1048576);assert.equal(unknown.discovered,false);
  await catalog.get('key','future-model');assert.equal(calls,1);now=11;await catalog.get('key','future-model');assert.equal(calls,2);
  const malformed=new ModelCatalog({fetchModels:async()=>({data:null})});assert.equal((await malformed.get('key','deepseek-flash')).maxOutputTokens,393216);
});
test('model limits reject malformed values and never exceed the context capacity',()=>{
  for(const value of [0,-1,'100',NaN,Infinity,1.5]) assert.equal(modelCapabilities('custom',{context_window:value,max_output_tokens:value}).contextWindow,1048576);
  const small=modelCapabilities('custom',{context_window:8192,max_output_tokens:99999});assert.equal(small.maxOutputTokens,8192);
  assert.equal(modelCapabilities('deepseek-flash').inputModalities.includes('image'),true);
  assert.equal(modelCapabilities('deepseek-v4-pro').inputModalities.includes('image'),false);
});
test('cancelled discovery never becomes a fallback generation',async()=>{
  const controller=new AbortController();let calls=0;
  const catalog=new ModelCatalog({fetchModels:async()=>{calls++;controller.abort();throw Error('network cancelled');}});
  await assert.rejects(catalog.get('key','deepseek-flash',controller.signal),{name:'AbortError'});
  await assert.rejects(catalog.get('key','deepseek-flash',controller.signal),{name:'AbortError'});assert.equal(calls,1);
});

test('a late failed discovery cannot overwrite a successful concurrent model limit or shorten its cache life',async()=>{
  let rejectFirst,calls=0,now=0;
  const catalog=new ModelCatalog({now:()=>now,ttlMs:1000,failureTtlMs:10,fetchModels:async()=>{
    if(++calls===1)return new Promise((_resolve,reject)=>{rejectFirst=reject;});
    return{data:[{id:'custom',context_window:8192,max_output_tokens:512}]};
  }});
  const first=catalog.get('key','custom');await Promise.resolve();
  const second=await catalog.get('key','custom');assert.equal(second.contextWindow,8192);assert.equal(second.maxOutputTokens,512);
  const cached=[...catalog.cache.values()][0];rejectFirst(Error('late network failure'));
  const late=await first;assert.equal(late.contextWindow,8192);assert.equal(late.maxOutputTokens,512);
  assert.equal([...catalog.cache.values()][0],cached);
  now=100;assert.equal((await catalog.get('key','custom')).maxOutputTokens,512);assert.equal(calls,2);
});

test('a cancelled discovery still rejects after another consumer has populated its cache',async()=>{
  let rejectFirst,calls=0;const controller=new AbortController();
  const catalog=new ModelCatalog({fetchModels:async()=>++calls===1?new Promise((_resolve,reject)=>{rejectFirst=reject;}):{data:[{id:'custom',context_window:4096,max_output_tokens:128}]}});
  const first=catalog.get('key','custom',controller.signal);await Promise.resolve();
  await catalog.get('key','custom');controller.abort();rejectFirst(Error('cancelled late request'));
  await assert.rejects(first,{name:'AbortError'});assert.equal((await catalog.get('key','custom')).maxOutputTokens,128);
});
