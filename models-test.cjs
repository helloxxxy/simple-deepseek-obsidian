const test = require('node:test');
const assert = require('node:assert/strict');
const { ModelCatalog, modelCapabilities } = require('./src/models');

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
