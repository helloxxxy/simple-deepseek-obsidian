const test = require('node:test');
const assert = require('node:assert/strict');
const { chat, sseParser } = require('./src/core');

const tools = ['search', 'fetch'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }));
const usage = { prompt_tokens: 50, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 20, completion_tokens: 12 };
const event = (delta = {}, finish_reason = null, used) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }], ...(used ? { usage: used } : {}) })}\n\n`;
const finish = reason => event({}, reason, usage) + 'data: [DONE]\n\n';
const call = (index, id, name, arguments_) => ({ index, id, type: 'function', function: { name, arguments: arguments_ } });
const signal = () => new AbortController().signal;

test('chat preserves plain requests and existing reasoning/tool messages without adding tools or JSON mode', async () => {
  const messages = [
    { role: 'assistant', content: null, reasoning_content: 'original reasoning', tool_calls: [{ id: 'prior', type: 'function', function: { name: 'fetch', arguments: '{"url":"https://example.com"}' } }] },
    { role: 'tool', tool_call_id: 'prior', content: 'page text' },
    { role: 'user', content: 'Explain.' }
  ];
  let text = '';
  const result = await chat('key', messages, signal(), part => { text += part; }, async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.messages, messages);
    assert.ok(!Object.hasOwn(body, 'tools'));
    assert.ok(!Object.hasOwn(body, 'response_format'));
    options.onChunk(Buffer.from(event({ content: 'Answer' }) + finish('stop')));
  });
  assert.equal(text, 'Answer');
  assert.deepEqual(result, usage);
});

test('tool stream joins interleaved names and arguments across individual UTF-8 bytes and retains usage', async () => {
  let text = '', thinking = '', received, httpEnded = false;
  const input = event({ reasoning_content: '先查资料🌱', content: 'Searching.\n' })
    + event({ tool_calls: [call(1, 'fetch-1', 'fe', '{"url":"https://example.com/'), call(0, 'search-1', 'se', '{"query":"中文')] })
    + event({ tool_calls: [{ index: 0, function: { name: 'arch', arguments: '🌱"}' } }, { index: 1, function: { name: 'tch', arguments: '文档"}' } }] })
    + finish('tool_calls');
  const result = await chat('key', [], signal(), part => { text += part; }, async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).tools, tools);
    for (const byte of Buffer.from(input)) options.onChunk(Buffer.from([byte]));
    assert.equal(received, undefined);
    httpEnded = true;
  }, { tools, onThinking: part => { thinking += part; }, onToolCalls: async calls => { assert.ok(httpEnded); received = calls; } });
  assert.equal(text, 'Searching.\n');
  assert.equal(thinking, '先查资料🌱');
  assert.deepEqual(result, usage);
  assert.deepEqual(received, [
    { id: 'search-1', type: 'function', function: { name: 'search', arguments: '{"query":"中文🌱"}' } },
    { id: 'fetch-1', type: 'function', function: { name: 'fetch', arguments: '{"url":"https://example.com/文档"}' } }
  ]);
});

test('tool parser exposes a detached snapshot before and after completion', () => {
  const parser = sseParser(() => {}, undefined, { tools });
  parser.push(Buffer.from(event({ tool_calls: [call(0, 'id', 'search', '{"query":')] })));
  const partial = parser.toolCalls;
  partial[0].id = 'changed'; partial[0].function.arguments = 'changed'; partial.push({});
  assert.equal(parser.toolCalls.length, 1);
  assert.equal(parser.toolCalls[0].id, 'id');
  assert.equal(parser.toolCalls[0].function.arguments, '{"query":');
  parser.push(Buffer.from(event({ tool_calls: [{ index: 0, function: { arguments: '"test"}' } }] }) + finish('tool_calls')));
  assert.deepEqual(parser.end(), usage);
  assert.equal(parser.finishReason, 'tool_calls');
  assert.equal(parser.toolCalls[0].function.arguments, '{"query":"test"}');
});

test('registered tools may still produce a normal streamed answer without a tool callback', async () => {
  let text = '', called = false;
  const result = await chat('key', [], signal(), part => { text += part; }, async (_url, options) => {
    options.onChunk(Buffer.from(event({ content: 'No lookup needed.' }) + finish('stop')));
  }, { tools, onToolCalls: () => { called = true; } });
  assert.equal(text, 'No lookup needed.');
  assert.equal(called, false);
  assert.deepEqual(result, usage);
});

test('truncated tool arguments preserve raw snapshot, visible text, thinking, usage, and length reason without invoking callback', async () => {
  let called = false, text = '', thinking = '';
  await assert.rejects(chat('key', [], signal(), part => { text += part; }, async (_url, options) => {
    options.onChunk(Buffer.from(event({ content: 'Plan', reasoning_content: 'Reason', tool_calls: [call(0, 'id', 'search', '{"query":"unfinished')] }) + finish('length')));
  }, { tools, onThinking: part => { thinking += part; }, onToolCalls: () => { called = true; } }), error => {
    assert.equal(error.finishReason, 'length');
    assert.equal(error.incomplete, true);
    assert.deepEqual(error.usage, usage);
    assert.equal(error.toolCalls[0].function.arguments, '{"query":"unfinished');
    return true;
  });
  assert.equal(called, false); assert.equal(text, 'Plan'); assert.equal(thinking, 'Reason');
});

test('DONE without finish reason is an interruption for both normal and tool streams', async () => {
  for (const toolMode of [false, true]) {
    let called = false;
    await assert.rejects(chat('key', [], signal(), () => {}, async (_url, options) => {
      options.onChunk(Buffer.from(event(toolMode ? { tool_calls: [call(0, 'id', 'search', '{}')] } : { content: 'partial' }) + 'data: [DONE]\n\n'));
    }, { ...(toolMode ? { tools } : {}), onToolCalls: () => { called = true; } }), /中断/);
    assert.equal(called, false);
  }
});

test('complete unregistered tool calls remain rejected with precise availability metadata', async () => {
  let called = false;
  await assert.rejects(chat('key', [], signal(), () => {}, async (_url, options) => {
    options.onChunk(Buffer.from(event({ tool_calls: [call(0, 'id', 'search', '{}')] }) + finish('tool_calls')));
  }, { onToolCalls: () => { called = true; } }), error => {
    assert.equal(error.finishReason, 'tool_calls');
    assert.equal(error.category, 'unavailable_tool');
    assert.equal(error.incomplete, false);
    assert.deepEqual(error.unavailableTools, ['search']);
    assert.equal(error.toolCalls[0].id, 'id');
    assert.deepEqual(error.usage, usage);
    return true;
  });
  assert.equal(called, false);
});

test('tool structure rejects incomplete fields, duplicate ids, invalid names, sparse indices and stop after calls', async () => {
  const samples = [
    [[], 'tool_calls'],
    [[{ index: 0, type: 'function', function: { name: 'search', arguments: '{}' } }], 'tool_calls'],
    [[call(0, 'id', 'search', '')], 'tool_calls'],
    [[call(0, 'id', 'invalid name', '{}')], 'tool_calls'],
    [[call(1, 'id', 'search', '{}')], 'tool_calls'],
    [[call(0, 'id', 'search', '{}'), call(1, 'id', 'fetch', '{}')], 'tool_calls'],
    [[call(0, 'id', 'search', '{}')], 'stop']
  ];
  for (const [calls, reason] of samples) {
    let called = false;
    await assert.rejects(chat('key', [], signal(), () => {}, async (_url, options) => {
      options.onChunk(Buffer.from(event({ tool_calls: calls }) + finish(reason)));
    }, { tools, onToolCalls: () => { called = true; } }), error => error.category === 'tool_calls' && error.incomplete === true && error.finishReason === reason);
    assert.equal(called, false);
  }
});

test('a mixed registered and unavailable batch is rejected atomically and retains every complete call', async () => {
  let invoked = false;
  const calls = [call(0, 'known', 'search', '{"query":"same original JSON"}'), call(1, 'unknown', 'read_notebook', '{}')];
  await assert.rejects(chat('key', [], signal(), () => {}, async (_url, options) => {
    options.onChunk(Buffer.from(event({ reasoning_content: 'Original reasoning', tool_calls: calls }) + finish('tool_calls')));
  }, { tools, onToolCalls: () => { invoked = true; } }), error => {
    assert.equal(error.category, 'unavailable_tool'); assert.equal(error.incomplete, false);
    assert.deepEqual(error.unavailableTools, ['read_notebook']);
    assert.deepEqual(error.toolCalls, calls.map(({ index, ...rest }) => rest));
    return true;
  });
  assert.equal(invoked, false);
});

test('malformed fields in a batch with an unavailable name remain structural errors', async () => {
  await assert.rejects(chat('key', [], signal(), () => {}, async (_url, options) => {
    options.onChunk(Buffer.from(event({ tool_calls: [{ index: 0, type: 'function', function: { name: 'read_notebook', arguments: '{}' } }] }) + finish('tool_calls')));
  }, { tools }), error => error.category === 'tool_calls' && error.incomplete === true && error.unavailableTools === undefined);
});

test('tool delta rejects nonnumeric indices and conflicting ids while retaining already accumulated calls', async () => {
  for (const badDelta of [{ index: '0', function: { arguments: '}' } }, { index: 0, id: 'replacement' }]) {
    await assert.rejects(chat('key', [], signal(), () => {}, async (_url, options) => {
      options.onChunk(Buffer.from(event({ tool_calls: [call(0, 'id', 'search', '{')] })));
      options.onChunk(Buffer.from(event({ tool_calls: [badDelta] })));
    }, { tools }), error => error.category === 'tool_calls' && error.toolCalls[0].id === 'id' && error.toolCalls[0].function.arguments === '{');
  }
});

test('completed tool arguments remain raw strings for the orchestration layer to validate', async () => {
  let received;
  await chat('key', [], signal(), () => {}, async (_url, options) => {
    options.onChunk(Buffer.from(event({ tool_calls: [call(0, 'id', 'search', '{malformed JSON')] }) + finish('tool_calls')));
  }, { tools, onToolCalls: calls => { received = calls; } });
  assert.equal(received[0].function.arguments, '{malformed JSON');
});

test('cancellation before HTTP or after its final chunk never invokes the tool callback', async () => {
  const before = new AbortController(); before.abort(); let sent = false, called = false;
  await assert.rejects(chat('key', [], before.signal, () => {}, async () => { sent = true; }, { tools, onToolCalls: () => { called = true; } }), { name: 'AbortError' });
  assert.equal(sent, false); assert.equal(called, false);
  const during = new AbortController();
  await assert.rejects(chat('key', [], during.signal, () => {}, async (_url, options) => {
    options.onChunk(Buffer.from(event({ tool_calls: [call(0, 'id', 'search', '{}')] }) + finish('tool_calls')));
    during.abort();
  }, { tools, onToolCalls: () => { called = true; } }), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.finishReason, 'tool_calls');
    assert.equal(error.toolCalls[0].id, 'id');
    assert.deepEqual(error.usage, usage);
    return true;
  });
  assert.equal(called, false);
});

test('JSON mode is opt-in, passes only the supported format and leaves token budget unchanged', async () => {
  await chat('key', [{ role: 'user', content: 'Return JSON.' }], signal(), () => {}, async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.max_tokens, 512);
    options.onChunk(Buffer.from(event({ content: '{"done":true}' }) + finish('stop')));
  }, { responseFormat: { type: 'json_object', ignored: true }, maxOutputTokens: 512 });
  for (const responseFormat of ['json_object', {}, { type: 'text' }]) {
    let sent = false;
    await assert.rejects(chat('key', [], signal(), () => {}, async () => { sent = true; }, { responseFormat }), /JSON/);
    assert.equal(sent, false);
  }
});

test('invalid tool definitions fail before the request', async () => {
  for (const invalid of [{}, [{ type: 'web_search', function: { name: 'search' } }], [...tools, tools[0]], [{ type: 'function', function: { name: 'invalid name' } }]]) {
    let sent = false;
    await assert.rejects(chat('key', [], signal(), () => {}, async () => { sent = true; }, { tools: invalid }), /工具定义/);
    assert.equal(sent, false);
  }
});

test('a tool callback failure retains the completed tool response and usage', async () => {
  await assert.rejects(chat('key', [], signal(), () => {}, async (_url, options) => {
    options.onChunk(Buffer.from(event({ tool_calls: [call(0, 'id', 'fetch', '{}')] }) + finish('tool_calls')));
  }, { tools, onToolCalls: async () => { throw new Error('callback failed'); } }), error => error.message === 'callback failed' && error.finishReason === 'tool_calls' && error.usage?.completion_tokens === 12 && error.toolCalls[0].function.name === 'fetch');
});

test('mutating a delivered tool snapshot cannot alter the parser snapshot retained after callback failure',async()=>{
  await assert.rejects(chat('key',[],signal(),()=>{},async(_url,options)=>{
    options.onChunk(Buffer.from(event({tool_calls:[call(0,'original-id','fetch','{"url":"https://example.com"}')]})+finish('tool_calls')));
  },{tools,onToolCalls:calls=>{
    calls[0].id='modified-id';calls[0].function.name='modified-name';calls[0].function.arguments='modified arguments';calls.push({id:'added'});
    throw Error('callback rejected');
  }}),error=>{
    assert.equal(error.message,'callback rejected');
    assert.deepEqual(error.toolCalls,[{id:'original-id',type:'function',function:{name:'fetch',arguments:'{"url":"https://example.com"}'}}]);
    assert.deepEqual(error.usage,usage);return true;
  });
});

test('a transport failure retains received tool arguments without invoking the callback', async () => {
  let called = false;
  await assert.rejects(chat('key', [], signal(), () => {}, async (_url, options) => {
    options.onChunk(Buffer.from(event({ tool_calls: [call(0, 'id', 'fetch', '{"url":')] })));
    throw new Error('connection interrupted');
  }, { tools, onToolCalls: () => { called = true; } }), error => error.message === 'connection interrupted' && error.toolCalls[0].function.arguments === '{"url":');
  assert.equal(called, false);
});

test('real tool parameter deltas report cumulative metadata before completion without exposing argument text',async()=>{
  const progress=[];let completed=false;
  const secret='private code 🌱 '.repeat(2000),first='{"query":"',last='"}';
  const result=await chat('key',[],signal(),()=>{},async(_url,options)=>{
    options.onChunk(Buffer.from(event({tool_calls:[call(0,'large','search',first)]})));
    assert.equal(progress.length,1);assert.equal(progress[0].argumentCharacters,first.length);assert.equal(completed,false);
    options.onChunk(Buffer.from(event({tool_calls:[{index:0,function:{arguments:secret}}]})));
    assert.equal(progress.length,2);assert.equal(progress[1].addedArgumentCharacters,secret.length);
    assert.equal(progress[1].argumentCharacters,first.length+secret.length);assert.equal(completed,false);
    options.onChunk(Buffer.from(event({tool_calls:[{index:0,function:{arguments:last}}]})+finish('tool_calls')));
  },{tools,onToolProgress:value=>progress.push(value),onToolCalls:calls=>{completed=true;assert.equal(calls[0].function.arguments,first+secret+last);}});
  assert.deepEqual(result,usage);assert.equal(completed,true);
  assert.equal(progress.length,3);assert.equal(progress.at(-1).totalArgumentCharacters,(first+secret+last).length);
  assert.deepEqual(Object.keys(progress[0]),['index','name','argumentCharacters','totalArgumentCharacters','addedArgumentCharacters','callCount']);
  assert.ok(!JSON.stringify(progress).includes('private code'));
});

test('interleaved tool progress counts exact decoded characters and ignores heartbeats or empty deltas',()=>{
  const progress=[];const parser=sseParser(()=>{},undefined,{tools,onToolProgress:value=>progress.push(value)});
  const first='{"query":"中文🌱"}',second='{"url":"https://example.com"}';
  const data=event({tool_calls:[call(1,'fetch-id','fetch',second.slice(0,5)),call(0,'search-id','se',first)]})
    +': heartbeat\n\n'+event({tool_calls:[{index:0,function:{name:'',arguments:''}}]})
    +event({tool_calls:[{index:0,function:{name:'arch'}},{index:1,function:{arguments:second.slice(5)}}]})+finish('tool_calls');
  for(const byte of Buffer.from(data))parser.push(Buffer.from([byte]));
  parser.end();assert.equal(progress.length,4);
  assert.equal(progress[0].callCount,1);assert.equal(progress[1].callCount,2);
  assert.equal(progress[2].name,'search');assert.equal(progress[2].addedArgumentCharacters,0);
  assert.equal(progress.at(-1).argumentCharacters,second.length);
  assert.equal(progress.at(-1).totalArgumentCharacters,first.length+second.length);
});

test('ordinary text and thinking do not create synthetic tool progress',async()=>{
  const progress=[];
  await chat('key',[],signal(),()=>{},async(_url,options)=>{
    options.onChunk(Buffer.from(': heartbeat\n\n'+event({reasoning_content:'Still reasoning.',content:'Answer.'})+event({})+finish('stop')));
  },{tools,onToolProgress:value=>progress.push(value)});
  assert.deepEqual(progress,[]);
});

test('tool progress stops on cancellation and no partial call is delivered for execution',async()=>{
  const controller=new AbortController(),progress=[];let executed=false;
  await assert.rejects(chat('key',[],controller.signal,()=>{},async(_url,options)=>{
    options.onChunk(Buffer.from(event({tool_calls:[call(0,'id','search','{"query":')]})));
    options.onChunk(Buffer.from(event({tool_calls:[{index:0,function:{arguments:'"late"}'}}]})+finish('tool_calls')));
  },{tools,onToolProgress:value=>{progress.push(value);controller.abort();},onToolCalls:()=>{executed=true;}}),{name:'AbortError'});
  assert.equal(progress.length,1);assert.equal(executed,false);
});

test('tool progress and parsing ignore chunks delivered after the request has completed',async()=>{
  let chunk;const progress=[];
  await chat('key',[],signal(),()=>{},async(_url,options)=>{chunk=options.onChunk;chunk(Buffer.from(finish('stop')));},{tools,onToolProgress:value=>progress.push(value)});
  assert.doesNotThrow(()=>chunk(Buffer.from(event({tool_calls:[call(0,'late','search','{}')]}))));
  assert.deepEqual(progress,[]);
});

test('malformed tool names are not exposed in progress metadata',()=>{
  const progress=[],parser=sseParser(()=>{},undefined,{tools,onToolProgress:value=>progress.push(value)});
  parser.push(Buffer.from(event({tool_calls:[call(0,'id','bad name\n{"secret":"value"}','{}')]})+finish('tool_calls')));
  assert.equal(progress[0].name,'');assert.ok(!JSON.stringify(progress).includes('secret'));
  assert.throws(()=>parser.end(),error=>error.category==='tool_calls'&&error.incomplete===true);
});

test('abortableTask releases the caller immediately while safely consuming a late task failure',async()=>{
  const {abortableTask}=require('./src/core');
  const controller=new AbortController();let rejectTask;
  const task=new Promise((_resolve,reject)=>{rejectTask=reject;});
  const pending=abortableTask(task,controller.signal);controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  rejectTask(Error('Late renderer failure'));await new Promise(setImmediate);
});

test('abortableTask preserves task results and removes its abort listener after settlement',async()=>{
  const {abortableTask}=require('./src/core');
  const controller=new AbortController();let added=0,removed=0;
  const add=controller.signal.addEventListener.bind(controller.signal),remove=controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener=(...args)=>{added++;return add(...args);};controller.signal.removeEventListener=(...args)=>{removed++;return remove(...args);};
  assert.equal(await abortableTask(Promise.resolve('complete'),controller.signal),'complete');await Promise.resolve();
  assert.equal(added,1);assert.equal(removed,1);
  const promise=Promise.resolve('same promise');assert.equal(abortableTask(promise),promise);
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(abortableTask(Promise.resolve('late value'),cancelled.signal),{name:'AbortError'});
});
