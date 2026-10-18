const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SYSTEM_PROMPT, estimateText, estimateMessages, contextTokens,
  rememberUsage, sessionStats, outputBudget, compactContext
} = require('./src/context');

const history = () => [
  { role: 'user', content: 'Read the source and explain the result.' },
  { role: 'assistant', content: 'I found the source.', reasoning_content: 'Check the result carefully. '.repeat(100), tool_calls: [{ id: 'fetch-1', type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://example.com/source"}' } }] },
  { role: 'tool', tool_call_id: 'fetch-1', content: '{"url":"https://example.com/source","content":"Original source text."}' },
  { role: 'assistant', content: 'The final explanation.', reasoning_content: 'Review the source once more.' }
];

test('context estimates can exclude reasoning without changing retained tool history', () => {
  const messages = history(), original = JSON.stringify(messages);
  const reasoningTokens = messages.reduce((sum, message) => sum + estimateText(message.reasoning_content || ''), 0);
  const full = estimateMessages(messages);
  assert.equal(estimateMessages(messages, { includeReasoning: false }), full - reasoningTokens);
  assert.equal(estimateMessages(messages), full);
  assert.equal(JSON.stringify(messages), original);
  messages[1].reasoning_content += 'New reasoning.';
  assert.equal(estimateMessages(messages, { includeReasoning: false }), full - reasoningTokens);
  assert.ok(estimateMessages(messages) > full);
});

test('changing reasoning replay mode invalidates only the context meter, not history or cache usage', () => {
  const session = { messages: history(), meter: { tokens: 9000, count: 4, model: 'deepseek-flash', systemPrompt: SYSTEM_PROMPT }, cache: { hit: 800, miss: 200, measured: 1, unknown: 0 } };
  const original = JSON.stringify(session.messages), metadata = { model: 'deepseek-flash', systemPrompt: SYSTEM_PROMPT };
  assert.equal(contextTokens(session, metadata), 9000);
  const noReasoning = { ...metadata, includeReasoning: false };
  assert.equal(contextTokens(session, noReasoning), estimateMessages([{ role: 'system', content: SYSTEM_PROMPT }, ...session.messages], { includeReasoning: false }));
  assert.match(sessionStats(session, 'en', noReasoning).text, /Context ~/);
  session.meter = { ...session.meter, tokens: 300, includeReasoning: false };
  assert.equal(contextTokens(session, noReasoning), 300);
  assert.notEqual(contextTokens(session, metadata), 300);
  assert.match(sessionStats(session, 'en', metadata).text, /Context ~/);
  assert.match(sessionStats(session, 'en', noReasoning).text, /Total cache hit 80\.0%/);
  session.messages.push({ role: 'assistant', content: 'More text.', reasoning_content: 'More hidden reasoning.' });
  assert.equal(contextTokens(session, noReasoning), 300 + estimateMessages(session.messages.slice(4), { includeReasoning: false }));
  assert.equal(JSON.stringify(session.messages.slice(0, 4)), original);
  assert.deepEqual(session.cache, { hit: 800, miss: 200, measured: 1, unknown: 0 });
});

test('output budget follows the reasoning replay mode', () => {
  const session = { messages: history() }, capabilities = { contextWindow: 4096, maxOutputTokens: 4096 };
  const withReasoning = outputBudget(session, 100, capabilities, { includeReasoning: true });
  const withoutReasoning = outputBudget(session, 100, capabilities, { includeReasoning: false });
  assert.equal(withoutReasoning - withReasoning, session.messages.reduce((sum, message) => sum + estimateText(message.reasoning_content || ''), 0));
});

test('measured context subtracts omitted generated reasoning while preserving raw usage', () => {
  const session = { messages: history() }, usage = { prompt_tokens: 1000, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 150 }, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 };
  const original = JSON.stringify(usage);
  rememberUsage(session, usage, { includeReasoning: false });
  assert.deepEqual(session.meter, { tokens: 1050, count: 4, estimated: false, includeReasoning: false });
  assert.equal(contextTokens(session, { includeReasoning: false }), 1050);
  rememberUsage(session, usage, { includeReasoning: true });
  assert.equal(session.meter.tokens, 1200);
  rememberUsage(session, { prompt_tokens: 1000, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 999 } }, { includeReasoning: false });
  assert.equal(session.meter.tokens, 1000);
  rememberUsage(session, { prompt_tokens: 1000, completion_tokens: 20 }, { includeReasoning: false });
  assert.equal(session.meter.tokens, 1020);
  assert.equal(JSON.stringify(usage), original);
});

test('compression excludes reasoning only on the wire and stores the resulting meter mode', async () => {
  const messages = history(); messages[0].content += ' Detail.'.repeat(2000);
  const original = JSON.stringify(messages), session = { messages, compactions: 0 };
  let sent;
  const result = await compactContext(session, 'fake', new AbortController().signal, () => {}, async (key, input, signal, delta) => {
    sent = input;
    assert.equal(JSON.stringify(session.messages), original);
    assert.ok(input.slice(1, -1).every(message => message.reasoning_content === undefined));
    assert.deepEqual(input[2].tool_calls, messages[1].tool_calls);
    assert.equal(input[3].content, messages[2].content);
    delta('The source has been read; continue the explanation.');
    return { prompt_tokens: 3000, completion_tokens: 20, prompt_cache_hit_tokens: 2500, prompt_cache_miss_tokens: 500 };
  }, 0, true, SYSTEM_PROMPT, {}, 'deepseek-flash', false);
  assert.equal(result.before, estimateMessages([{ role: 'system', content: SYSTEM_PROMPT }, ...JSON.parse(original)], { includeReasoning: false }));
  assert.equal(sent.length, 7);
  assert.equal(session.compactions, 1);
  assert.equal(session.meter.includeReasoning, false);
  assert.equal(contextTokens(session, { model: 'deepseek-flash', systemPrompt: SYSTEM_PROMPT, includeReasoning: false }), result.after);
  assert.deepEqual(session.cache, { hit: 2500, miss: 500, measured: 1, unknown: 0 });
});

test('failed compression without reasoning replay preserves original thinking and tools', async () => {
  const session = { messages: history() }, original = JSON.stringify(session.messages);
  await assert.rejects(compactContext(session, 'fake', new AbortController().signal, () => {}, async (key, input) => {
    assert.ok(input.every(message => message.reasoning_content === undefined));
    throw Error('service unavailable');
  }, 0, true, SYSTEM_PROMPT, {}, 'deepseek-flash', false), /压缩失败/);
  assert.equal(JSON.stringify(session.messages), original);
  assert.equal(session.meter, undefined);
});

test('unchanged large native parameters reuse the token estimate while same-length text changes invalidate it',()=>{
  const message={role:'assistant',content:'body',reasoning_content:'thought',tool_calls:[{id:'large',type:'function',function:{name:'stage_notebook_edits',arguments:JSON.stringify({source:'x'.repeat(80000)})}}]};
  const stringify=JSON.stringify;let serializations=0;
  JSON.stringify=(value,...args)=>{if(value===message.tool_calls)serializations++;return stringify(value,...args);};
  try{
    const first=estimateMessages([message]);
    for(let index=0;index<20;index++)assert.equal(estimateMessages([message]),first);
    assert.equal(serializations,1);
    message.tool_calls[0].function.arguments=stringify({source:'中'.repeat(80000)});
    assert.ok(estimateMessages([message])>first);assert.equal(serializations,2);
    message.content='中中中中';const contentChanged=estimateMessages([message]);assert.equal(serializations,3);
    message.reasoning_content='中文中文中中中';assert.ok(estimateMessages([message])>contentChanged);assert.equal(serializations,4);
  }finally{JSON.stringify=stringify;}
});

test('compression retains authentication metadata and measured failed-request usage',async()=>{
  const session={messages:history()},original=JSON.stringify(session.messages);
  const usage={prompt_tokens:1000,completion_tokens:20,prompt_cache_hit_tokens:700,prompt_cache_miss_tokens:300};
  const cause=Object.assign(Error('Key expired'),{authExpired:true,authService:'deepseek',httpStatus:401,requestHost:'api.deepseek.com',category:'authentication',usage});
  await assert.rejects(compactContext(session,'fake',new AbortController().signal,()=>{},async()=>{throw cause;},0,true),error=>{
    assert.match(error.message,/上下文压缩失败/);assert.equal(error.authExpired,true);assert.equal(error.authService,'deepseek');assert.equal(error.httpStatus,401);assert.equal(error.category,'authentication');
    assert.equal(error.cause,cause);assert.equal(error.usage,usage);assert.equal(Object.keys(error).includes('stack'),false);return true;
  });
  assert.deepEqual(session.cache,{hit:700,miss:300,measured:1,unknown:0});assert.equal(JSON.stringify(session.messages),original);
});

test('compression records returned usage exactly once when cancellation follows completion or accompanies a failure',async()=>{
  for(const reject of [false,true]){
    const controller=new AbortController(),session={messages:history()},original=JSON.stringify(session.messages);
    const usage={prompt_tokens:1000,completion_tokens:20,prompt_cache_hit_tokens:800,prompt_cache_miss_tokens:200};
    await assert.rejects(compactContext(session,'fake',controller.signal,()=>{},async(_key,_messages,_signal,onText)=>{
      onText('Checkpoint text.');controller.abort();
      if(reject)throw Object.assign(Error('Stopped after usage arrived'),{name:'AbortError',usage});
      return usage;
    },0,true),{name:'AbortError'});
    assert.deepEqual(session.cache,{hit:800,miss:200,measured:1,unknown:0});assert.equal(JSON.stringify(session.messages),original);assert.equal(session.meter,undefined);
  }
});

test('cancelling at the compression notice never starts a request or creates unknown usage',async()=>{
  const controller=new AbortController(),session={messages:history()};
  await assert.rejects(compactContext(session,'fake',controller.signal,()=>controller.abort(),async()=>assert.fail('No request may start after cancellation'),0,true),{name:'AbortError'});
  assert.equal(session.cache,undefined);
});

test('compression rejects every live content, reasoning, native-argument or provider-extra change before commit',async()=>{
  const changes=[
    messages=>{messages[0].content='Another equally relevant request.';},
    messages=>{messages[1].reasoning_content='Changed reasoning with new facts.';},
    messages=>{messages[1].tool_calls[0].function.arguments='{"url":"https://example.com/changed"}';},
    messages=>{messages[1].tool_calls[0].provider.state='new';}
  ];
  for(const mutate of changes){
    const session={messages:history()};session.messages[1].tool_calls[0].provider={state:'old'};
    await assert.rejects(compactContext(session,'fake',new AbortController().signal,()=>{},async(_key,_messages,_signal,onText)=>{onText('A short checkpoint.');mutate(session.messages);return{prompt_tokens:1000,completion_tokens:10};},0,true),/会话已变化/);
    assert.equal(session.messages.length,4);assert.equal(session.compactions,undefined);
  }
  const session={messages:history()};
  await compactContext(session,'fake',new AbortController().signal,()=>{},async(_key,_messages,_signal,onText)=>{session.messages[0].content=Array.from(session.messages[0].content).join('');onText('A short checkpoint.');return{prompt_tokens:1000,completion_tokens:10};},0,true);
  assert.equal(session.compactions,1);
});
