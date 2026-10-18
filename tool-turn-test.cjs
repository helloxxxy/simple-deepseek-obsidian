const test = require('node:test');
const assert = require('node:assert/strict');
const { runToolTurn, addUsage, turnTools } = require('./src/tool-turn');
const { SYSTEM_PROMPT } = require('./src/context');
const { NotebookEditBuffer, notebookHash } = require('./src/notebook');

const usage = n => ({ prompt_tokens: n * 100, completion_tokens: n * 10, prompt_cache_hit_tokens: n * 60, prompt_cache_miss_tokens: n * 40, total_tokens: n * 110, completion_tokens_details: { reasoning_tokens: n * 3 } });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const cancelled = () => Object.assign(new Error('stopped'), { name: 'AbortError' });

test('real chat SSE parser and tool orchestration complete a fetch round without losing raw reasoning',async()=>{
  const {chat}=require('./src/core');let requests=0;const visible=[],thinking=[];
  const session={messages:[{role:'user',content:'Read the page'}]};
  const http=async(url,options)=>{
    const body=JSON.parse(options.body);assert.equal(url,'https://api.deepseek.com/chat/completions');
    const first=requests++===0;
    if(first){
      for(const value of [{choices:[{delta:{reasoning_content:'Need source.'}}]},{choices:[{delta:{tool_calls:[{index:0,id:'fetch-call',type:'function',function:{name:'fetch_page',arguments:'{"url":"https://example.com"}'}}]}}]},{choices:[{delta:{},finish_reason:'tool_calls'}],usage:usage(1)}])options.onChunk(Buffer.from('data: '+JSON.stringify(value)+'\n\n'));
    }else{
      assert.equal(body.messages[2].reasoning_content,'Need source.');assert.equal(body.messages[3].tool_call_id,'fetch-call');
      options.onChunk(Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:'Verified answer.'},finish_reason:'stop'}],usage:usage(2)})+'\n\n'));
    }
    options.onChunk(Buffer.from('data: [DONE]\n\n'));
  };
  const result=await runToolTurn({key:'fake',session,signal:new AbortController().signal,model:'deepseek-flash',reasoningEffort:'low',systemPrompt:SYSTEM_PROMPT,capabilities:{contextWindow:1048576,maxOutputTokens:393216},web:{execute:async()=>'{"content":"Source body"}'},send:(key,messages,signal,onText,_http,options)=>chat(key,messages,signal,onText,http,options),onText:text=>visible.push(text),onThinking:text=>thinking.push(text)});
  assert.equal(requests,2);assert.deepEqual(visible,['Verified answer.']);assert.deepEqual(thinking,['Need source.']);assert.equal(result.usage.prompt_tokens,300);assert.equal(session.messages.at(-1).reasoning_content,'');
});

function harness(script, extras = {}) {
  const requests = [], records = [], reportedUsage = [], messages = [], statuses = [], shown = [], thoughts = [], preparations = [], raw = [], protocolIssues = [];
  const session = { messages: [{ role: 'user', content: 'Please complete the requested task.' }] };
  const controller = new AbortController();
  const send = async (key, input, signal, onText, http, options) => {
    assert.equal(key, 'fake-key'); assert.equal(http, undefined);
    const index = requests.length;
    requests.push({ input: structuredClone(input), options });
    const response = script[index];
    assert.ok(response, 'Unexpected additional model request');
    if (response.inspect) await response.inspect({ key, input, signal, onText, options });
    if (response.thinking) options.onThinking(response.thinking);
    if (response.text) onText(response.text);
    if (response.error) throw response.error;
    if (response.calls) await options.onToolCalls(response.calls);
    return response.usage === undefined ? usage(index + 1) : response.usage;
  };
  const options = {
    key: 'fake-key', session, signal: controller.signal, model: 'deepseek-flash', reasoningEffort: 'low', systemPrompt: SYSTEM_PROMPT,
    capabilities: { contextWindow: 1048576, maxOutputTokens: 393216 }, send,
    onRawText: value => raw.push(value), onText: value => shown.push(value), onThinking: value => thoughts.push(value), onMessage: value => messages.push(structuredClone(value)),
    onRecord: value => records.push(structuredClone(value)), onUsage: (...value) => reportedUsage.push(structuredClone(value)),
    onStatus: value => statuses.push(value), onProtocolIssue: value => protocolIssues.push(value), beforeRequest: async value => { preparations.push(value); }, ...extras
  };
  return { run: () => runToolTurn(options), options, session, controller, requests, records, reportedUsage, messages, statuses, shown, thoughts, preparations, raw, protocolIssues };
}

function nativeHarness(script, extras = {}) {
  const { chat } = require('./src/core');
  const h = harness([], extras);
  h.options.send = (key, input, signal, onText, _http, options) => chat(key,input,signal,onText,async (_url, request) => {
    const index = h.requests.length, response = script[index];
    assert.ok(response, 'Unexpected additional native model request');
    h.requests.push({input:structuredClone(input),options,body:JSON.parse(request.body)});
    const delta = { ...(response.thinking ? {reasoning_content:response.thinking} : {}), ...(response.text ? {content:response.text} : {}), ...(response.calls ? {tool_calls:response.calls.map((call,index) => ({index,...call}))} : {}) };
    for(const part of response.deltas || [delta])request.onChunk(Buffer.from('data: '+JSON.stringify({choices:[{delta:part}]})+'\n\n'));
    request.onChunk(Buffer.from('data: '+JSON.stringify({choices:[{delta:{},finish_reason:response.reason || (response.calls ? 'tool_calls' : 'stop')}],usage:response.usage || usage(index+1)})+'\n\ndata: [DONE]\n\n'));
  },options);
  return h;
}

class FakeEditBuffer {
  constructor() { this.currentHash = 'hash-0'; this.operations = []; this.batches = []; this.started = false; this.done = false; this.applyCalls = 0; }
  stage(args) {
    assert.equal(args.baseHash, this.currentHash);
    assert.ok(Array.isArray(args.operations));
    this.started = true; this.done = args.done; this.batches.push(structuredClone(args));
    this.operations.push(...args.operations); this.currentHash = 'hash-' + this.batches.length;
    return { currentHash: this.currentHash, operations: this.operations.length, done: this.done };
  }
  status() { return { currentHash: this.currentHash, started: this.started, pendingChunks: 0, done: this.done, operations: this.operations.length }; }
  result() {
    if (!this.started || !this.done) throw new Error('incomplete');
    return { baseHash: 'hash-0', operations: structuredClone(this.operations) };
  }
  apply() { this.applyCalls++; throw new Error('The turn must never apply staged edits'); }
}

test('direct normal text remains a single response with thinking and usage reported once', async () => {
  const h = harness([{ text: 'Direct answer.', thinking: 'Reasoning.' }], { web: { execute: () => { throw Error('No tool should run'); } } });
  const result = await h.run();
  assert.deepEqual(result, { usage: usage(1), patch: null, hasText: true });
  assert.deepEqual(h.shown, ['Direct answer.']); assert.deepEqual(h.thoughts, ['Reasoning.']);
  assert.equal(h.requests.length, 1); assert.equal(h.reportedUsage.length, 1); assert.equal(h.records.length, 1);
  assert.equal(h.session.messages[1].reasoning_content, 'Reasoning.');
  assert.equal(h.requests[0].options.responseFormat, undefined);
  assert.deepEqual(turnTools(null).map(item => item.function.name), ['search_web', 'fetch_page']);
});

test('search and fetch tool rounds replay complete original reasoning, calls and tool_call_id messages', async () => {
  const invoked = [];
  const search = call('search-id', 'search_web', { query: 'official API', count: 2 });
  const fetch = call('fetch-id', 'fetch_page', { url: 'https://example.com/docs' });
  const h = harness([
    { thinking: 'First reasoning\n🌱', text: 'Looking up sources.\n', calls: [search] },
    { thinking: 'Second reasoning', calls: [fetch] },
    { text: 'The verified answer [source](https://example.com/docs).' }
  ], { web: { execute: async (name, args) => { invoked.push({ name, args }); return JSON.stringify({ name, text: 'reference text' }); } } });
  const result = await h.run();
  assert.deepEqual(invoked, [{ name: 'search_web', args: { query: 'official API', count: 2 } }, { name: 'fetch_page', args: { url: 'https://example.com/docs' } }]);
  assert.deepEqual(h.requests[1].input.slice(-2), [
    { role: 'assistant', content: 'Looking up sources.\n', reasoning_content: 'First reasoning\n🌱', tool_calls: [search] },
    { role: 'tool', tool_call_id: 'search-id', content: JSON.stringify({ name: 'search_web', text: 'reference text' }) }
  ]);
  assert.equal(h.requests[2].input[2].reasoning_content, 'First reasoning\n🌱');
  assert.deepEqual(h.requests[2].input.slice(-2), [
    { role: 'assistant', content: '', reasoning_content: 'Second reasoning', tool_calls: [fetch] },
    { role: 'tool', tool_call_id: 'fetch-id', content: JSON.stringify({ name: 'fetch_page', text: 'reference text' }) }
  ]);
  assert.equal(h.records.filter(item => item.type === 'response').length, 3);
  assert.equal(h.records.filter(item => item.type === 'tool_result').length, 2);
  assert.equal(h.reportedUsage.length, 3);
  assert.deepEqual(h.reportedUsage.map(([item]) => item), [usage(1), usage(2), usage(3)]);
  assert.deepEqual(result.usage, usage(6));
  assert.equal(h.preparations.length, 3); assert.ok(h.preparations.every(value => value > 16));
});

test('a failed tool can be corrected once, with each result closed before the next model request', async () => {
  let runs = 0;
  const h = harness([
    { calls: [call('bad', 'search_web', 'not JSON')] },
    { calls: [call('good', 'search_web', { query: 'corrected query' })] },
    { text: 'Answer.' }
  ], { web: { execute: async () => { runs++; return '{}'; } } });
  await h.run();
  assert.equal(runs, 1);
  assert.equal(h.requests[1].input.at(-1).role, 'tool');
  assert.equal(h.requests[1].input.at(-1).tool_call_id, 'bad');
  assert.equal(JSON.parse(h.requests[1].input.at(-1).content).executed, false);
  assert.equal(h.requests[2].input.at(-1).tool_call_id, 'good');
});

test('the same failing tool request cannot cause an unbounded retry loop', async () => {
  let runs = 0;
  const h = harness([
    { calls: [call('first', 'search_web', { query: 'query' })] },
    { calls: [call('second', 'search_web', { query: 'query' })] }
  ], { web: { execute: async () => { runs++; throw Error('service unavailable'); } } });
  await assert.rejects(h.run(), error => error.message === 'service unavailable' && error.turnUsage.prompt_tokens === 300);
  assert.equal(runs, 2); assert.equal(h.requests.length, 2);
  const replies = h.session.messages.filter(item => item.role === 'tool');
  assert.deepEqual(replies.map(item => item.tool_call_id), ['first', 'second']);
  assert.ok(replies.every(item => JSON.parse(item.content).executed === false));
});

test('stopping during one tool closes every outstanding call and does not execute the rest', async () => {
  let runs = 0;
  const h = harness([{ calls: [call('one', 'fetch_page', { url: 'https://example.com/one' }), call('two', 'fetch_page', { url: 'https://example.com/two' })] }]);
  h.options.web = { execute: async () => { runs++; h.controller.abort(); throw cancelled(); } };
  await assert.rejects(h.run(), error => error.name === 'AbortError' && error.turnUsage.prompt_tokens === 100);
  assert.equal(runs, 1);
  assert.deepEqual(h.session.messages.filter(item => item.role === 'tool').map(item => item.tool_call_id), ['one', 'two']);
  assert.ok(h.session.messages.filter(item => item.role === 'tool').every(item => JSON.parse(item.content).executed === false));
  assert.equal(h.records.filter(item => item.type === 'tool_result').length, 2);
});

test('authentication or balance failure closes the remaining calls without executing them', async () => {
  for (const attributes of [{ authExpired: true }, { httpStatus: 402 }]) {
    let runs = 0;
    const h = harness([{ calls: [call('one', 'fetch_page', { url: 'https://example.com/one' }), call('two', 'fetch_page', { url: 'https://example.com/two' })] }], {
      web: { execute: async () => { runs++; throw Object.assign(new Error('cannot continue'), attributes); } }
    });
    await assert.rejects(h.run(), error => error.message === 'cannot continue' && error.turnUsage.prompt_tokens === 100);
    assert.equal(runs, 1);
    const replies = h.session.messages.filter(item => item.role === 'tool');
    assert.deepEqual(replies.map(item => item.tool_call_id), ['one', 'two']);
    assert.ok(replies.every(item => JSON.parse(item.content).executed === false));
  }
});

test('Notebook edit batches remain staged in memory, replay current hashes and produce one unapplied patch', async () => {
  const notebook = new FakeEditBuffer();
  const first = { baseHash: 'hash-0', done: false, operations: [{ type: 'replace_text', cellId: 'a', oldText: 'x=1', newText: 'x=2' }] };
  const second = { baseHash: 'hash-1', done: true, operations: [{ type: 'insert_cell', index: 1, cellType: 'code', source: 'print(x)' }] };
  const h = harness([
    { calls: [call('batch-one', 'stage_notebook_edits', first)] },
    { calls: [call('batch-two', 'stage_notebook_edits', second)] },
    { text: 'Changes await review.' }
  ], { notebook });
  const result = await h.run();
  assert.equal(notebook.applyCalls, 0);
  assert.deepEqual(notebook.batches, [first, second]);
  assert.deepEqual(result.patch, { baseHash: 'hash-0', operations: [...first.operations, ...second.operations] });
  assert.equal(JSON.parse(h.requests[1].input.at(-1).content).currentHash, 'hash-1');
  assert.equal(JSON.parse(h.requests[1].input.at(-1).content).applied, false);
  assert.equal(JSON.parse(h.requests[2].input.at(-1).content).applied, false);
  assert.ok(h.requests[0].options.tools.some(item => item.function.name === 'stage_notebook_edits'));
});

test('truncated edit JSON is archived verbatim and retried as smaller new calls without staging partial parameters', async () => {
  const notebook = new FakeEditBuffer();
  const raw = '{"baseHash":"hash-0","operations":[{"type":"insert_cell","source":"unfinished';
  const failure = Object.assign(new Error('length exceeded'), { finishReason: 'length', usage: usage(1), toolCalls: [call('unfinished', 'stage_notebook_edits', raw)] });
  const h = harness([
    { thinking: 'Original thinking', text: 'Original plan.', error: failure },
    { calls: [call('complete', 'stage_notebook_edits', { baseHash: 'hash-0', done: true, operations: [{ type: 'insert_cell', index: 0, cellType: 'code', source: 'print(1)' }] })] },
    { text: 'Ready for review.' }
  ], { notebook });
  const result = await h.run();
  assert.equal(notebook.batches.length, 1);
  assert.equal(notebook.batches[0].operations[0].source, 'print(1)');
  assert.equal(h.records[0].unfinishedToolCalls[0].function.arguments, raw);
  assert.equal(h.records[0].message.reasoning_content, 'Original thinking');
  assert.equal(h.records[0].finishReason, 'length');
  assert.ok(!Object.hasOwn(h.requests[1].input[2], 'tool_calls'));
  assert.match(h.requests[1].input.at(-1).content, /smaller complete JSON batches/);
  assert.equal(h.requests[1].input.at(-1).role, 'user');
  assert.equal(result.patch.operations.length, 1);
  assert.deepEqual(result.usage, usage(6));
  assert.equal(h.reportedUsage.length, 3);
});

test('repeating the same truncated edit response stops without staging or parameter concatenation', async () => {
  const notebook = new FakeEditBuffer();
  const error = id => Object.assign(new Error('length exceeded'), { finishReason: 'length', usage: usage(1), toolCalls: [call(id, 'stage_notebook_edits', '{"source":"raw')] });
  const h = harness([{ error: error('unfinished-1') }, { error: error('unfinished-2') }], { notebook });
  await assert.rejects(h.run(), value => value.finishReason === 'length' && value.turnUsage.prompt_tokens === 200);
  assert.equal(h.requests.length, 2); assert.equal(notebook.batches.length, 0); assert.equal(notebook.applyCalls, 0);
  assert.equal(h.records.length, 2);
});

test('an unfinished Notebook batch followed by ordinary text is resumed once and never exposed as an applicable patch', async () => {
  const notebook = new FakeEditBuffer();
  const h = harness([
    { calls: [call('batch', 'stage_notebook_edits', { baseHash: 'hash-0', done: false, operations: [{ type: 'insert_cell', cellType: 'code', source: 'part' }] })] },
    { text: 'Done.' },
    { text: 'Done again.' }
  ], { notebook });
  await assert.rejects(h.run(), error => /尚未完整/.test(error.message) && error.turnUsage.prompt_tokens === 600);
  assert.match(h.requests[2].input.at(-1).content, /unfinished/);
  assert.equal(notebook.applyCalls, 0);
  assert.throws(() => notebook.result(), /incomplete/);
});

test('an abort after a successful tool result retains aggregate usage and any completed staging patch', async () => {
  const notebook = new FakeEditBuffer();
  notebook.stage({ baseHash: 'hash-0', done: true, operations: [{ type: 'insert_cell', cellType: 'code', source: 'prepared' }] });
  const h = harness([{ calls: [call('fetch', 'fetch_page', { url: 'https://example.com' })] }], { notebook });
  h.options.web = { execute: async () => { h.controller.abort(); return '{"content":"received"}'; } };
  await assert.rejects(h.run(), error => {
    assert.equal(error.name, 'AbortError');
    assert.deepEqual(error.turnUsage, usage(1));
    assert.deepEqual(error.stagedPatch, notebook.result());
    return true;
  });
  assert.equal(h.session.messages.at(-1).tool_call_id, 'fetch');
});

test('a later preflight failure retains usage accumulated by earlier successful tool requests', async () => {
  let count = 0;
  const h = harness([{ calls: [call('search', 'search_web', { query: 'query' })] }], {
    web: { execute: async () => '{}' }, beforeRequest: async () => { if (++count === 2) throw Error('context full'); }
  });
  await assert.rejects(h.run(), error => error.message === 'context full' && error.turnUsage?.prompt_tokens === 100);
  assert.equal(h.requests.length, 1);
});

test('an output-budget rejection does not report a request that was never sent', async () => {
  const h = harness([], { capabilities: { contextWindow: 8, maxOutputTokens: 4 } });
  await assert.rejects(h.run(), /可用空间/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.reportedUsage.length, 0);
});

test('usage aggregation does not double count requests and keeps detailed reasoning totals', () => {
  assert.equal(addUsage(null, null), null);
  const aggregate = addUsage(addUsage(null, usage(1)), usage(2));
  assert.deepEqual(aggregate, usage(3));
  assert.deepEqual(addUsage(aggregate, { prompt_tokens: NaN }), usage(3));
});

function exampleNotebook() {
  return { cells: [
    { id: 'code-1', cell_type: 'code', source: ['print("first")\n', 'hidden_second_line = 42'], execution_count: 1, outputs: [
      { output_type: 'stream', name: 'stdout', text: 'printed text\n' },
      { output_type: 'display_data', data: { 'image/png': 'private-image-contents', 'text/plain': 'text output' } }
    ] },
    { id: 'markdown-1', cell_type: 'markdown', source: ['# Heading\n', 'hidden_markdown_paragraph'], attachments: { figure: { 'image/png': 'private-attachment' } } },
    { id: 'image-code', cell_type: 'code', source: 'image = "data:image/png;base64,' + 'A'.repeat(500) + '"', outputs: [] }
  ], metadata: { widgets: { state: 'private-widget' } } };
}

test('read_notebook with no cellIds returns only safe metadata and current virtual hash', async () => {
  const original = exampleNotebook(), notebook = new NotebookEditBuffer(original);
  const h = harness([{ calls: [call('read', 'read_notebook', {})] }, { text: 'Read index.' }], { notebook });
  await h.run();
  const result = JSON.parse(h.session.messages.find(item => item.role === 'tool').content);
  assert.equal(result.kind, 'notebook_index');
  assert.equal(result.currentHash, notebookHash(original));
  assert.deepEqual(result.cells[0], { cellId: 'code-1', index: 0, cellType: 'code', firstLine: 'print("first")',sourceLength:original.cells[0].source.join('').length,firstLineTruncated:false });
  assert.deepEqual(result.cells[1], { cellId: 'markdown-1', index: 1, cellType: 'markdown', firstLine: '# Heading',sourceLength:original.cells[1].source.join('').length,firstLineTruncated:false });
  assert.ok(result.cells.every(cell => !Object.hasOwn(cell, 'source') && !Object.hasOwn(cell, 'outputs')));
  const encoded = JSON.stringify(result);
  assert.ok(!encoded.includes('hidden_second_line') && !encoded.includes('hidden_markdown_paragraph'));
  assert.ok(!encoded.includes('private-image') && !encoded.includes('private-attachment') && !encoded.includes('private-widget'));
  assert.ok(!encoded.includes('A'.repeat(500)));
  assert.ok(h.requests[0].options.tools.some(item => item.function.name === 'read_notebook'));
  assert.equal(turnTools(null).some(item => item.function.name === 'read_notebook'), false);
});

test('read_notebook selects requested cell IDs, preserves text outputs, and omits images and base64', async () => {
  const notebook = new NotebookEditBuffer(exampleNotebook());
  const h = harness([{ calls: [call('read', 'read_notebook', { cellIds: ['image-code', 'code-1'] })] }, { text: 'Read cells.' }], { notebook });
  await h.run();
  const result = JSON.parse(h.session.messages.find(item => item.role === 'tool').content);
  assert.equal(result.kind, 'notebook_cells');
  assert.equal(result.currentHash, notebook.currentHash);
  assert.deepEqual(result.cells.map(cell => cell.cellId), ['image-code', 'code-1']);
  assert.match(result.cells[0].source, /image data omitted/);
  assert.equal(result.cells[1].source, 'print("first")\nhidden_second_line = 42');
  assert.equal(result.cells[1].outputs[0].text, 'printed text\n');
  assert.deepEqual(result.cells[1].outputs[1].data, { 'text/plain': 'text output' });
  const encoded = JSON.stringify(result);
  assert.ok(!encoded.includes('data:image') && !encoded.includes('private-image') && !encoded.includes('private-attachment') && !encoded.includes('private-widget'));
});

test('read_notebook reads staged virtual changes without mutating the source Notebook', async () => {
  const original = exampleNotebook(), before = structuredClone(original), notebook = new NotebookEditBuffer(original);
  notebook.stage({ baseHash: notebook.currentHash, done: true, operations: [{ type: 'replace_text', cellId: 'code-1', oldText: 'hidden_second_line = 42', newText: 'staged_value = 43' }] });
  const h = harness([{ calls: [call('read', 'read_notebook', { cellIds: ['code-1'] })] }, { text: 'Virtual state read.' }], { notebook });
  const outcome = await h.run();
  const result = JSON.parse(h.session.messages.find(item => item.role === 'tool').content);
  assert.equal(result.currentHash, notebook.currentHash);
  assert.notEqual(result.currentHash, notebookHash(original));
  assert.match(result.cells[0].source, /staged_value = 43/);
  assert.deepEqual(original, before);
  assert.equal(outcome.patch.operations.length, 1);
});

test('read_notebook rejects malformed, duplicate and unknown cell IDs as closed tool errors', async () => {
  for (const args of [{ cellIds: 'code-1' }, { cellIds: [1] }, { cellIds: [''] }, { cellIds: ['code-1', 'code-1'] }, { unknown: true }, { cellIds: ['missing'] }]) {
    const notebook = new NotebookEditBuffer(exampleNotebook());
    const h = harness([{ calls: [call('read', 'read_notebook', args)] }, { text: 'Please correct the selection.' }], { notebook });
    await h.run();
    const result = JSON.parse(h.session.messages.find(item => item.role === 'tool').content);
    assert.equal(result.executed, false);
    assert.match(result.error, /read_notebook/);
    assert.equal(notebook.status().started, false);
  }
});

test('read_notebook with an explicit empty selection returns no source text', async () => {
  const notebook = new NotebookEditBuffer(exampleNotebook());
  const h = harness([{ calls: [call('read', 'read_notebook', { cellIds: [] })] }, { text: 'No cells selected.' }], { notebook });
  await h.run();
  const result = JSON.parse(h.session.messages.find(item => item.role === 'tool').content);
  assert.equal(result.kind, 'notebook_cells');
  assert.deepEqual(result.cells, []);
});

test('cancelling immediately after a model response retains its usage without executing its tool', async () => {
  let runs = 0;
  const h = harness([{ usage: usage(1), inspect: () => { h.controller.abort(); }, calls: [call('search', 'search_web', { query: 'query' })] }], { web: { execute: () => { runs++; } } });
  await assert.rejects(h.run(), error => error.name === 'AbortError' && error.turnUsage.prompt_tokens === 100);
  assert.equal(h.reportedUsage.length, 1); assert.equal(runs, 0);
});

test('late text, thinking and tool callbacks after cancellation are ignored without throwing', async () => {
  let callbacks, release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness([]);
  h.options.send = async (_key, _input, _signal, onText, _http, options) => { callbacks = { onText, options }; return gate; };
  const pending = h.run();
  await Promise.resolve(); await Promise.resolve();
  assert.ok(callbacks);
  h.controller.abort();
  assert.doesNotThrow(() => callbacks.onText('late text'));
  assert.doesNotThrow(() => callbacks.options.onThinking('late reasoning'));
  assert.doesNotThrow(() => callbacks.options.onToolCalls([call('late', 'fetch_page', '{}')]));
  release(usage(1));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.session.messages.length, 1);
  assert.deepEqual(h.shown, []); assert.deepEqual(h.thoughts, []);
  assert.equal(h.records.length, 1);assert.match(h.records[0].error,/已停止/);
  assert.doesNotMatch(JSON.stringify(h.records),/late text|late reasoning|"id":"late"/);
  assert.doesNotThrow(() => callbacks.onText('even later text'));
  assert.equal(h.session.messages.length, 1);
});

test('callbacks received after a completed request cannot append an untracked response', async () => {
  let callbacks;
  const h = harness([{ text: 'Done.', inspect: value => { callbacks = value; } }]);
  await h.run();
  const before = structuredClone(h.session.messages);
  callbacks.onText('late text'); callbacks.options.onThinking('late thinking');
  assert.deepEqual(h.session.messages, before);
});

test('repeating an empty unfinished stage reports no progress once and then stops without applying', async () => {
  const notebook = new NotebookEditBuffer(exampleNotebook());
  const args = { baseHash: notebook.currentHash, operations: [], done: false };
  const h = harness([
    { calls: [call('empty-1', 'stage_notebook_edits', args)] },
    { calls: [call('empty-2', 'stage_notebook_edits', args)] },
    { calls: [call('empty-3', 'stage_notebook_edits', args)] }
  ], { notebook });
  await assert.rejects(h.run(), error => /没有新的进展/.test(error.message) && error.turnUsage.prompt_tokens === 600);
  assert.equal(h.requests.length, 3);
  const replies = h.session.messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content));
  assert.equal(replies[0].status, 'staged_for_review');
  assert.equal(replies[1].executed, false); assert.match(replies[1].error, /更改请求/);
  assert.equal(replies[2].executed, false);
  assert.equal(notebook.status().done, false); assert.equal(notebook.operations.length, 0);
});

test('repeating the same notebook read and repeated deduplicated web results cannot loop indefinitely', async () => {
  for (const name of ['read_notebook', 'fetch_page']) {
    const notebook = new NotebookEditBuffer(exampleNotebook());
    const args = name === 'read_notebook' ? {} : { url: 'https://example.com' };
    const h = harness([
      { calls: [call('read-1', name, args)] },
      { calls: [call('read-2', name, args)] },
      { calls: [call('read-3', name, args)] }
    ], { notebook, web: { execute: async () => '{"already_in_context":true,"hash":"same"}' } });
    await assert.rejects(h.run(), /没有新的进展/);
    const replies = h.session.messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content));
    assert.equal(replies.length, 3);
    if(name==='fetch_page') assert.ok(replies.every(reply=>reply.already_in_context===true&&reply.hash==='same'));
    else { assert.equal(replies[1].executed, false); assert.equal(replies[2].executed, false); }
  }
});

test('compaction permits rereading the same notebook state or web result', async () => {
  for (const name of ['read_notebook', 'fetch_page']) {
    const notebook = new NotebookEditBuffer(exampleNotebook());
    const args = name === 'read_notebook' ? {} : { url: 'https://example.com' };
    let preparations = 0;
    const h = harness([
      { calls: [call('before', name, args)] },
      { calls: [call('after', name, args)] },
      { text: 'Answer from the recovered reference.' }
    ], { notebook, web: { execute: async () => '{"content":"same original text"}' }, beforeRequest: async () => {
      if (++preparations === 2) {
        h.session.compactions = (h.session.compactions || 0) + 1;
        h.session.messages.splice(0, h.session.messages.length, { role: 'user', content: 'Continuation checkpoint.' });
      }
    } });
    await h.run();
    const replies = h.records.filter(item => item.type === 'tool_result').map(item => JSON.parse(item.message.content));
    assert.equal(replies.length, 2); assert.ok(replies.every(item => item.error === undefined));
    assert.match(h.requests[1].input[1].content, /Continuation checkpoint/);
  }
});

test('the same read arguments are allowed when the virtual notebook hash has changed', async () => {
  const notebook = new NotebookEditBuffer(exampleNotebook());
  let preparations = 0;
  const h = harness([
    { calls: [call('before', 'read_notebook', { cellIds: ['code-1'] })] },
    { calls: [call('after', 'read_notebook', { cellIds: ['code-1'] })] },
    { text: 'New state read.' }
  ], { notebook, beforeRequest: async () => {
    if (++preparations === 2) notebook.stage({ baseHash: notebook.currentHash, done: true, operations: [{ type: 'replace_text', cellId: 'code-1', oldText: 'hidden_second_line = 42', newText: 'new_value = 99' }] });
  } });
  await h.run();
  const replies = h.records.filter(item => item.type === 'tool_result').map(item => JSON.parse(item.message.content));
  assert.equal(replies.length, 2); assert.ok(replies.every(item => item.error === undefined));
  assert.notEqual(replies[0].currentHash, replies[1].currentHash);
  assert.match(replies[1].cells[0].source, /new_value = 99/);
});

test('the same web arguments remain allowed when the successful result changes', async () => {
  let reads = 0;
  const h = harness([
    { calls: [call('first', 'fetch_page', { url: 'https://example.com' })] },
    { calls: [call('second', 'fetch_page', { url: 'https://example.com' })] },
    { text: 'Answer.' }
  ], { web: { execute: async () => JSON.stringify({ content: 'version ' + ++reads }) } });
  await h.run();
  const replies = h.session.messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content));
  assert.deepEqual(replies.map(item => item.content), ['version 1', 'version 2']);
});

test('web retrieval timestamps cannot disguise repeated content as progress and each raw result keeps its real timestamp',async()=>{
  for(const name of ['search_web','fetch_page']) {
    let reads=0;const returned=[];const args=name==='search_web'?{query:'current source'}:{url:'https://example.com'};
    const h=harness([{calls:[call('first',name,args)]},{calls:[call('second',name,args)]},{calls:[call('third',name,args)]}],{web:{execute:async()=>{
      const stamp='2026-10-17T00:00:0'+(++reads)+'.000Z';
      const result=JSON.stringify({retrieved_at:stamp,results:[{url:'https://example.com',content:'Same article body',hash:'same',retrieved_at:stamp,metadata:{retrieved_at:stamp}}]});returned.push(result);return result;
    }}});
    await assert.rejects(h.run(),error=>/没有新的进展/.test(error.message)&&error.turnUsage.prompt_tokens===600);
    const messages=h.session.messages.filter(message=>message.role==='tool');
    assert.equal(h.requests.length,3);assert.deepEqual(messages.map(message=>message.content),returned);
    assert.deepEqual(h.records.filter(record=>record.type==='tool_result').map(record=>record.message.content),returned);
    assert.deepEqual(messages.map(message=>JSON.parse(message.content).retrieved_at),['2026-10-17T00:00:01.000Z','2026-10-17T00:00:02.000Z','2026-10-17T00:00:03.000Z']);
  }
});

test('source content, dates and hashes still count as progress and retrieved_at text inside content stays significant',async()=>{
  for(const field of ['content','date','hash']) {
    let reads=0;const returned=[];const args={url:'https://example.com'};
    const h=harness([{calls:[call('first','fetch_page',args)]},{calls:[call('second','fetch_page',args)]},{text:'Read changed source.'}],{web:{execute:async()=>{
      const result=JSON.stringify({retrieved_at:'2026-10-17T00:00:00.000Z',content:'Article body',date:'2026-10-17',hash:'same',[field]:field==='content'?'Literal JSON text {"retrieved_at":"'+(++reads)+'"}':'changed-'+(++reads)});returned.push(result);return result;
    }}});
    await h.run();assert.equal(h.requests.length,3);assert.deepEqual(h.session.messages.filter(message=>message.role==='tool').map(message=>message.content),returned);assert.equal(h.statuses.length,0);
  }
});

test('disabling web omits its schemas and never executes even an unexpected generated web call',async()=>{
  assert.deepEqual(turnTools(null,false),[]);
  const notebook=new NotebookEditBuffer(exampleNotebook());assert.deepEqual(turnTools(notebook,false).map(tool=>tool.function.name),['stage_notebook_edits','read_notebook']);
  const h=harness([{calls:[call('unexpected','fetch_page',{url:'https://example.com'})]},{text:'Available context only.'}],{webEnabled:false,web:{execute:async()=>assert.fail('disabled')}});
  await h.run();assert.deepEqual(h.requests[0].options.tools,[]);assert.equal(JSON.parse(h.session.messages.find(message=>message.role==='tool').content).executed,false);
});

test('Notebook editing tools remain usable while Search Fetch is disabled',async()=>{
  const notebook=new FakeEditBuffer();const h=harness([{calls:[call('stage-only','stage_notebook_edits',{baseHash:notebook.currentHash,operations:[{type:'insert_cell',source:'print(1)'}],done:true})]},{text:'Ready for review.'}],{notebook,webEnabled:false,web:{execute:async()=>assert.fail('no web')}});
  const result=await h.run();assert.equal(result.patch.operations.length,1);assert.ok(h.requests.every(request=>request.options.tools.every(tool=>!['search_web','fetch_page'].includes(tool.function.name))));
});

test('textual tool tags are never executed and remain archived with usage in both web modes',async()=>{
  const text='<tool_call>\n{"name":"search_web","arguments":{"query":"Denver weather today"}}\n</tool_call>';
  for(const webEnabled of [false,true]){
    const h=harness([{text,thinking:'Need current weather.'},...(webEnabled?[{text}]:[])],{webEnabled,userText:"How's the weather like in Mile high?",systemPrompt:require('./src/prompts').buildSystemPrompt({webEnabled}),web:{execute:async()=>assert.fail('text must never execute')}});
    await assert.rejects(h.run(),error=>error.toolProtocolError===(webEnabled?'invalid_tool_protocol':'web_disabled')&&error.turnUsage.prompt_tokens===(webEnabled?300:100));
    assert.equal(h.requests.length,webEnabled?2:1);assert.equal(h.session.messages.at(-1).content,text);assert.equal(h.records[0].message.content,text);assert.equal(h.session.messages.some(message=>message.role==='tool'),false);assert.equal(h.reportedUsage.length,webEnabled?2:1);assert.deepEqual(h.shown,[]);
  }
});

const reportedDsml = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="search_web">\n<｜｜DSML｜｜ parameter name="query" string="true">Washington DC current weather forecast today</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="count" string="false">5</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="need_content" string="false">true</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';

test('the reported DSML request is corrected once through the native channel, preserving original raw history and all usage',async()=>{
  const runs=[];
  const h=harness([
    {text:reportedDsml,thinking:'Need Washington DC weather.'},
    {calls:[call('native-dc','search_web',{query:'Washington DC current weather forecast today',count:5,need_content:true})]},
    {text:'The verified DC answer.'}
  ],{userText:'what about dc',web:{execute:async(name,args)=>{runs.push({name,args});return'{"content":"Current weather"}';}}});
  const result=await h.run();
  assert.equal(runs.length,1);assert.equal(h.requests.length,3);assert.equal(result.usage.prompt_tokens,600);
  assert.deepEqual(h.shown,['The verified DC answer.']);assert.equal(h.raw.join(''),reportedDsml+'The verified DC answer.');
  assert.equal(h.records[0].message.content,reportedDsml);assert.equal(h.session.messages[1].content,reportedDsml);
  assert.deepEqual(h.requests[1].input.slice(0,-1),h.requests[0].input.concat(h.records[0].message));
  assert.equal(h.requests[1].input.at(-1).role,'user');assert.match(h.requests[1].input.at(-1).content,/not executed/);
  assert.deepEqual(h.protocolIssues,[{recovered:false,attempt:1},{recovered:true,attempt:1}]);
  assert.equal(h.reportedUsage.length,3);assert.equal(h.session.messages.filter(message=>message.role==='tool').length,1);
});

test('continuous DSML leakage stops after one correction without executing text parameters',async()=>{
  const h=harness([{text:reportedDsml},{text:reportedDsml}],{userText:'what about dc',web:{execute:async()=>assert.fail('not native')}});
  await assert.rejects(h.run(),error=>error.toolProtocolError==='invalid_tool_protocol'&&error.turnUsage.prompt_tokens===300);
  assert.equal(h.requests.length,2);assert.deepEqual(h.shown,[]);assert.equal(h.raw.join(''),reportedDsml.repeat(2));
  assert.deepEqual(h.protocolIssues,[{recovered:false,attempt:1},{recovered:false,attempt:2}]);
  assert.equal(h.records.length,2);assert.equal(h.session.messages.filter(message=>message.role==='tool').length,0);
});

test('native calls mixed with leaked DSML execute only the native call and do not display leaked markup',async()=>{
  let executed=0;const native=call('only-native','search_web',{query:'native query'});
  const h=harness([{text:reportedDsml,calls:[native]},{text:'Answer from the native result.'}],{web:{execute:async(name,args)=>{executed++;assert.deepEqual(args,{query:'native query'});return'{}';}}});
  await h.run();assert.equal(executed,1);assert.equal(h.requests.length,2);assert.deepEqual(h.shown,['Answer from the native result.']);
  assert.equal(h.session.messages[1].content,reportedDsml);assert.deepEqual(h.session.messages[1].tool_calls,[native]);
  assert.deepEqual(h.protocolIssues,[{recovered:true,attempt:1}]);assert.equal(h.raw.join(''),reportedDsml+'Answer from the native result.');
});

test('DSML web requests cannot use protocol correction to bypass the disabled web switch through Notebook tools',async()=>{
  const notebook=new FakeEditBuffer();
  const h=harness([{text:reportedDsml}],{webEnabled:false,notebook,web:{execute:async()=>assert.fail('disabled')}});
  await assert.rejects(h.run(),error=>error.toolProtocolError==='web_disabled'&&error.turnUsage.prompt_tokens===100);
  assert.equal(h.requests.length,1);assert.equal(notebook.batches.length,0);assert.deepEqual(h.shown,[]);
});

test('cancelling at the protocol issue never appends a correction or sends a second request',async()=>{
  const h=harness([{text:reportedDsml}]);h.options.onProtocolIssue=()=>h.controller.abort();
  await assert.rejects(h.run(),error=>error.name==='AbortError'&&error.turnUsage.prompt_tokens===100);
  assert.equal(h.requests.length,1);assert.equal(h.session.messages.length,2);assert.equal(h.session.messages[1].content,reportedDsml);
});

test('cancelling while preparing the correction prevents the recovery request',async()=>{
  const h=harness([{text:reportedDsml}]);let preparations=0;
  h.options.beforeRequest=async()=>{if(++preparations===2)h.controller.abort();};
  await assert.rejects(h.run(),error=>error.name==='AbortError'&&error.turnUsage.prompt_tokens===100);
  assert.equal(h.requests.length,1);assert.equal(preparations,2);assert.deepEqual(h.shown,[]);
});

test('protocol recovery may produce a normal answer without any tool and emits raw deltas unchanged',async()=>{
  const chunks=[...reportedDsml];const answer='I cannot verify live conditions from the provided information.';
  const h=harness([{inspect:async({onText})=>{for(const chunk of chunks)onText(chunk);}},{text:answer}],{userText:'what about dc'});
  await h.run();assert.deepEqual(h.raw,[...chunks,answer]);assert.deepEqual(h.shown,[answer]);
  assert.deepEqual(h.protocolIssues,[{recovered:false,attempt:1},{recovered:true,attempt:1}]);
});

test('explicit DSML examples remain ordinary text with no recovery request',async()=>{
  const text='```xml\n'+reportedDsml+'\n```';const h=harness([{text}],{userText:'Explain the DSML syntax and show an example',web:{execute:async()=>assert.fail('example')}});
  await h.run();assert.deepEqual(h.shown,[text]);assert.deepEqual(h.raw,[text]);assert.deepEqual(h.protocolIssues,[]);assert.equal(h.requests.length,1);
});

test('an empty correction response is not announced as a successful protocol recovery',async()=>{
  const h=harness([{text:reportedDsml},{thinking:'Still deciding.'}]);
  await assert.rejects(h.run(),error=>error.toolProtocolError==='invalid_tool_protocol'&&error.turnUsage.prompt_tokens===300);
  assert.equal(h.requests.length,2);assert.deepEqual(h.shown,[]);assert.deepEqual(h.protocolIssues,[{recovered:false,attempt:1},{recovered:false,attempt:2}]);
});

test('real SSE byte chunks containing DSML recover with a native call without flashing protocol text',async()=>{
  const {chat}=require('./src/core');let requests=0,executed=0;const shown=[],raw=[];
  const http=async(url,options)=>{
    const step=requests++,event=step===0?{choices:[{delta:{content:reportedDsml},finish_reason:'stop'}],usage:usage(1)}:step===1?{choices:[{delta:{tool_calls:[{index:0,id:'native-search',type:'function',function:{name:'search_web',arguments:'{"query":"Washington DC weather"}'}}]},finish_reason:'tool_calls'}],usage:usage(2)}:{choices:[{delta:{content:'Verified weather.'},finish_reason:'stop'}],usage:usage(3)};
    const bytes=Buffer.from('data: '+JSON.stringify(event)+'\n\ndata: [DONE]\n\n');
    for(let index=0;index<bytes.length;index+=3)options.onChunk(bytes.subarray(index,index+3));
  };
  const session={messages:[{role:'user',content:'what about dc'}]};
  const result=await runToolTurn({key:'fake',session,signal:new AbortController().signal,model:'deepseek-flash',reasoningEffort:'low',systemPrompt:SYSTEM_PROMPT,capabilities:{contextWindow:1048576,maxOutputTokens:393216},web:{execute:async()=>{executed++;return'{}';}},send:(key,messages,signal,onText,_http,options)=>chat(key,messages,signal,onText,http,options),onRawText:text=>raw.push(text),onText:text=>shown.push(text)});
  assert.equal(requests,3);assert.equal(executed,1);assert.equal(raw.join(''),reportedDsml+'Verified weather.');assert.deepEqual(shown,['Verified weather.']);assert.equal(result.usage.prompt_tokens,600);
});

test('tool tag examples in fences, quotes and explicit format questions remain ordinary text',async()=>{
  const markup='<tool_call>{"name":"search_web","arguments":{}}</tool_call>';
  for(const [text,userText] of [['```xml\n'+markup+'\n```','Show an XML example'],['The following is an example:\n'+markup,'Explain the format'],[markup,'Show the exact <tool_call> wrapper']]){
    const h=harness([{text}],{webEnabled:false,userText,web:{execute:async()=>assert.fail('no execution')}});await h.run();assert.equal(h.session.messages.at(-1).content,text);
  }
});

test('image tools are independent of web and Notebook capabilities',()=>{
  assert.deepEqual(turnTools(null,false,null),[]);
  assert.deepEqual(turnTools(null,false,{}).map(tool=>tool.function.name),['read_image']);
  assert.deepEqual(turnTools({},true,{}).map(tool=>tool.function.name),['search_web','fetch_page','stage_notebook_edits','read_notebook','read_image']);
  const schema=turnTools(null,false,{})[0].function.parameters;
  assert.deepEqual(schema.required,['imageIds','question']);assert.equal(schema.additionalProperties,false);
  assert.equal(schema.properties.imageIds.uniqueItems,true);assert.equal(schema.properties.imageIds.minItems,1);
});

test('read_image rereads IDs with a task, keeps image bytes out of history, and counts auxiliary usage once',async()=>{
  const args={imageIds:['image-a','image-b'],question:'Compare the axis scales.'},reads=[];
  const h=harness([{calls:[call('image-read','read_image',args)]},{text:'The scales differ.'}],{webEnabled:false,images:{execute:async(input,{onUsage})=>{
    reads.push(input);onUsage(usage(7));
    return {kind:'image_description',imageIds:input.imageIds,text:'Both axes are logarithmic. data:image/png;base64,'+'A'.repeat(600),binaryExample:'B'.repeat(600)};
  }}});
  const result=await h.run();
  assert.deepEqual(reads,[args]);assert.deepEqual(result.usage,usage(10));
  assert.equal(h.reportedUsage.length,3);assert.deepEqual(h.reportedUsage.map(([item])=>item),[usage(1),usage(7),usage(2)]);
  assert.deepEqual(h.reportedUsage[1],[usage(7),null,{auxiliary:true,kind:'image'}]);
  assert.ok(h.requests.every(request=>request.options.tools.length===1&&request.options.tools[0].function.name==='read_image'));
  const tool=h.session.messages.find(message=>message.role==='tool');
  assert.equal(tool.tool_call_id,'image-read');assert.match(tool.content,/Both axes are logarithmic/);
  assert.doesNotMatch(JSON.stringify(h.session.messages),/data:image|A{400}|B{400}/);
  assert.equal(JSON.parse(h.requests[1].input.at(-1).content).kind,'image_description');
});

test('a crop preserves normalized source coordinates and supports a safe string result',async()=>{
  const args={imageIds:['image-a'],question:'Read this axis label.',region:{x:0.6,y:0.2,width:0.3,height:0.4}};
  const h=harness([{calls:[call('image-crop','read_image',args)]},{text:'The axis is time.'}],{webEnabled:false,images:{execute:async(input)=>{assert.deepEqual(input,args);return 'Axis label: time.';}}});
  await h.run();assert.equal(h.session.messages.find(message=>message.role==='tool').content,'Axis label: time.');
  assert.equal(h.reportedUsage.length,2);
});

test('invalid image IDs, tasks and crop bounds never reach the image reader',async()=>{
  const valid={imageIds:['a'],question:'Read the label.'};
  for (const args of [
    {},{...valid,imageIds:[]},{...valid,imageIds:['a','a']},{...valid,imageIds:[' ']},{...valid,imageIds:[1]},
    {...valid,question:' '},{...valid,question:7},{...valid,url:'https://example.com/image.png'},
    {...valid,region:{x:0,y:0,width:0,height:1}},{...valid,region:{x:0.8,y:0,width:0.3,height:1}},
    {...valid,region:{x:0,y:0,width:1,height:1,extra:1}},{...valid,region:{x:0,y:0,width:1}},
    {...valid,imageIds:['a','b'],region:{x:0,y:0,width:1,height:1}}
  ]) {
    const h=harness([{calls:[call('invalid-image','read_image',args)]},{text:'Please specify a valid image.'}],{webEnabled:false,images:{execute:async()=>assert.fail('invalid image request')}});
    await h.run();const result=JSON.parse(h.session.messages.find(message=>message.role==='tool').content);
    assert.equal(result.executed,false);assert.match(result.error,/read_image/);assert.equal(h.reportedUsage.length,2);
  }
});

test('unavailable images return a closed tool result and can be reattached without imaginary rereading',async()=>{
  for(const images of [null,{execute:async()=>({kind:'image_unavailable',missingImageIds:['expired-id'],message:'Please reattach the original image.'})}]){
    const h=harness([{calls:[call('missing-image','read_image',{imageIds:['expired-id'],question:'Read the label.'})]},{text:'Please reattach the image.'}],{webEnabled:false,images});
    await h.run();const result=JSON.parse(h.session.messages.find(message=>message.role==='tool').content);
    if(images)assert.deepEqual(result.missingImageIds,['expired-id']);else assert.equal(result.executed,false);
    assert.deepEqual(h.shown,['Please reattach the image.']);assert.equal(h.reportedUsage.length,2);
  }
});

test('image failures and cancellation keep paid auxiliary usage and close all pending native calls',async()=>{
  for(const abort of [false,true]){
    let reads=0;
    const h=harness([{calls:[call('first-image','read_image',{imageIds:['a'],question:'Read A.'}),call('second-image','read_image',{imageIds:['b'],question:'Read B.'})]},...(!abort?[{text:'Please reattach A.'}]:[])],{webEnabled:false});
    h.options.images={execute:async(args,{onUsage})=>{reads++;onUsage(usage(4));if(abort){h.controller.abort();throw cancelled();}throw Object.assign(Error('Image request failed'),{authExpired:true});}};
    await assert.rejects(h.run(),error=>error.turnUsage.prompt_tokens===500&&(abort?error.name==='AbortError':error.authExpired));
    assert.equal(reads,1);assert.equal(h.reportedUsage.length,2);assert.deepEqual(h.reportedUsage[1],[usage(4),null,{auxiliary:true,kind:'image'}]);
    assert.deepEqual(h.session.messages.filter(message=>message.role==='tool').map(message=>message.tool_call_id),['first-image','second-image']);
    assert.ok(h.session.messages.filter(message=>message.role==='tool').every(message=>JSON.parse(message.content).executed===false));
  }
});

test('repeating an unchanged image reread cannot loop and keeps all real vision usage',async()=>{
  const args={imageIds:['a'],question:'Read A.'};let reads=0;
  const h=harness([{calls:[call('first','read_image',args)]},{calls:[call('second','read_image',args)]},{calls:[call('third','read_image',args)]}],{webEnabled:false,images:{execute:async(input,{onUsage})=>{reads++;onUsage(usage(1));return {text:'Unclear label.'};}}});
  await assert.rejects(h.run(),error=>/没有新的进展/.test(error.message)&&error.turnUsage.prompt_tokens===900);
  assert.equal(reads,3);assert.equal(h.reportedUsage.length,6);
});

test('accidental binary image results are rejected before serialization into context or raw tool records',async()=>{
  for(const binary of [Buffer.from('private pixels'),new Uint8Array([80,73,88,69,76]),new ArrayBuffer(20),new Blob(['private pixels'])]) {
    const h=harness([{calls:[call('binary','read_image',{imageIds:['a'],question:'Read A.'})]},{text:'The image could not be read.'}],{webEnabled:false,images:{execute:async()=>({text:'Description',images:[{id:'a',bytes:binary}]})}});
    await h.run();const tool=h.session.messages.find(message=>message.role==='tool'),data=JSON.parse(tool.content);
    assert.equal(data.executed,false);assert.match(data.error,/binary data/);
    assert.doesNotMatch(JSON.stringify(h.records),/private pixels|"type":"Buffer"|80,73,88,69,76/);
  }
});

test('changing truncated edit arguments still stops after three failures and reduces only the recommended batch size',async()=>{
  const notebook=new NotebookEditBuffer(exampleNotebook());
  const errors=[0,1,2].map(index=>Object.assign(Error('length exceeded'),{finishReason:'length',usage:usage(index+1),toolCalls:[call('cut-'+index,'stage_notebook_edits','{"source":"different-'+index)]}));
  const h=harness(errors.map(error=>({error})),{notebook});
  await assert.rejects(h.run(),error=>error.finishReason==='length'&&error.recoveryLimitReached&&error.turnUsage.prompt_tokens===600);
  assert.equal(h.requests.length,3);assert.equal(notebook.status().started,false);assert.equal(notebook.operations.length,0);
  assert.deepEqual(h.requests.map(request=>Number(request.options.tools.find(tool=>tool.function.name==='stage_notebook_edits').function.description.match(/Current recommendedBatchTokens: (\d+)/)[1])),[4096,2048,1024]);
  assert.ok(h.requests.every(request=>request.options.maxOutputTokens>100000));
  assert.match(h.requests[1].input.at(-1).content,/2048 tokens/);assert.match(h.requests[2].input.at(-1).content,/1024 tokens/);
  assert.deepEqual(h.records.map(record=>record.unfinishedToolCalls?.[0]?.function.arguments).filter(Boolean),errors.map(error=>error.toolCalls[0].function.arguments));
});

test('accepted source progress resets the length-failure streak without raising the adaptive batch recommendation',async()=>{
  const notebook=new NotebookEditBuffer(exampleNotebook()),baseHash=notebook.currentHash;
  const failure=n=>Object.assign(Error('length exceeded'),{finishReason:'length',toolCalls:[call('cut-'+n,'stage_notebook_edits','{"source":"cut-'+n)]});
  const first={baseHash,operations:[{type:'source_chunk',chunkId:'rewrite',part:0,source:'print(',operation:{type:'set_source',cellId:'code-1'}}],done:false};
  const last={baseHash,operations:[{type:'source_chunk',chunkId:'rewrite',part:1,source:'2)',final:true}],done:true};
  const h=harness([{error:failure(1)},{calls:[call('start','stage_notebook_edits',first)]},{error:failure(2)},{error:failure(3)},{calls:[call('finish','stage_notebook_edits',last)]},{text:'Ready for review.'}],{notebook});
  const result=await h.run();assert.equal(result.patch.operations[0].source,'print(2)');assert.equal(h.requests.length,6);
  const receipts=h.session.messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content));
  assert.deepEqual(receipts.map(item=>item.recommendedBatchTokens),[2048,512]);
  assert.equal(receipts[0].taskId,receipts[1].taskId);assert.equal(receipts[0].nextPart,1);assert.ok(receipts[1].revision>receipts[0].revision);
});

test('three changing invalid tool arguments cannot evade the global consecutive failure limit',async()=>{
  const notebook=new NotebookEditBuffer(exampleNotebook());
  const h=harness([0,1,2].map(index=>({calls:[call('invalid-'+index,'stage_notebook_edits',{baseHash:'wrong-'+index,operations:[],done:false})]})),{notebook});
  await assert.rejects(h.run(),error=>error.turnUsage.prompt_tokens===600);
  assert.equal(h.requests.length,3);assert.equal(notebook.status().started,false);
  assert.ok(h.session.messages.filter(message=>message.role==='tool').every(message=>JSON.parse(message.content).executed===false));
});

test('accepted Notebook batches and the final result await durable checkpoints',async()=>{
  const original=exampleNotebook();original.cells=original.cells.filter(cell=>cell.id!=='image-code');
  const notebook=new NotebookEditBuffer(original),snapshots=[];let saving=false;
  const h=harness([{calls:[call('stage','stage_notebook_edits',{baseHash:notebook.currentHash,operations:[{type:'replace_text',cellId:'code-1',oldText:'42',newText:'43'}],done:true})]},{text:'Ready for review.',inspect:()=>assert.equal(saving,false)}],{notebook,onCheckpoint:async state=>{saving=true;await Promise.resolve();snapshots.push(structuredClone(state));saving=false;}});
  const result=await h.run();assert.equal(snapshots.length,2);assert.equal(snapshots[0].taskId,notebook.taskId);
  assert.equal(NotebookEditBuffer.restore(snapshots[0]).result().operations[0].newText,'43');assert.equal(result.patch.operations[0].newText,'43');
  assert.equal(saving,false);assert.doesNotMatch(JSON.stringify(snapshots),/private-image-contents|private-attachment|private-widget/);
});

test('cancelling after a collected chunk saves resumable state and sends no continuation request',async()=>{
  const original=exampleNotebook();original.cells=original.cells.filter(cell=>cell.id!=='image-code');
  const notebook=new NotebookEditBuffer(original),saved=[];
  const h=harness([{calls:[call('partial','stage_notebook_edits',{baseHash:notebook.currentHash,operations:[{type:'source_chunk',chunkId:'large',part:0,source:'print(',operation:{type:'set_source',cellId:'code-1'}}],done:false})]}],{notebook});
  h.options.onCheckpoint=async state=>{saved.push(structuredClone(state));h.controller.abort();};
  await assert.rejects(h.run(),error=>error.name==='AbortError'&&error.stagedPatch===null);
  assert.equal(h.requests.length,1);assert.ok(saved.length>=1);const restored=NotebookEditBuffer.restore(saved.at(-1));
  assert.equal(restored.status().nextPart,1);assert.equal(restored.readPending({}).source,'print(');assert.equal(restored.done,false);
  assert.equal(JSON.parse(h.session.messages.at(-1).content).applied,false);
});

test('checkpoint write errors stop the turn while acknowledging already staged edits',async()=>{
  const notebook=new NotebookEditBuffer(exampleNotebook());
  const h=harness([{calls:[call('stage','stage_notebook_edits',{baseHash:notebook.currentHash,operations:[{type:'set_source',cellId:'code-1',source:'print(2)'}],done:true})]}],{notebook,onCheckpoint:async()=>{throw Error('checkpoint storage unavailable');}});
  await assert.rejects(h.run(),error=>error.checkpointFailure&&error.stagedPatch.operations[0].source==='print(2)'&&error.checkpointError==='checkpoint storage unavailable');
  const receipt=JSON.parse(h.session.messages.at(-1).content);assert.equal(receipt.staged,true);assert.equal(receipt.executed,true);assert.equal(receipt.applied,false);assert.equal(h.requests.length,1);
});

test('read_notebook can page accepted unfinished source and then finish a large existing-cell rewrite',async()=>{
  const notebook=new NotebookEditBuffer(exampleNotebook()),baseHash=notebook.currentHash;
  notebook.stage({baseHash,operations:[{type:'source_chunk',chunkId:'rewrite',part:0,source:'0123456789',operation:{type:'set_source',cellId:'code-1'}}],done:false});
  const h=harness([{calls:[call('pending','read_notebook',{pendingSource:{offset:3,limit:4}})]},{calls:[call('finish','stage_notebook_edits',{baseHash,operations:[{type:'source_chunk',chunkId:'rewrite',part:1,source:'END',final:true}],done:true})]},{text:'Complete and awaiting review.'}],{notebook});
  const result=await h.run(),read=JSON.parse(h.session.messages.find(message=>message.role==='tool').content);
  assert.equal(read.kind,'notebook_pending_source');assert.equal(read.source,'3456');assert.equal(read.nextPart,1);assert.equal(read.nextOffset,7);assert.equal(read.hasMore,true);assert.equal(read.taskId,notebook.taskId);
  assert.equal(result.patch.operations[0].type,'set_source');assert.equal(result.patch.operations[0].source,'0123456789END');
});

test('read_notebook sourceRange returns only a bounded source page with offsets',async()=>{
  const notebook=new NotebookEditBuffer(exampleNotebook());
  const h=harness([{calls:[call('page','read_notebook',{cellIds:['code-1'],sourceRange:{offset:2,limit:7}})]},{text:'Read source page.'}],{notebook});
  await h.run();const page=JSON.parse(h.session.messages.find(message=>message.role==='tool').content);
  assert.equal(page.kind,'notebook_source');assert.equal(page.cells[0].source,'int("fi');assert.equal(page.cells[0].offset,2);assert.equal(page.cells[0].nextOffset,9);assert.equal(page.cells[0].hasMore,true);
  assert.equal(page.cells[0].outputs,undefined);assert.doesNotMatch(JSON.stringify(page),/private-image|text output/);
});

test('read_notebook rejects ambiguous and unbounded source requests before reading',async()=>{
  for(const args of [{pendingSource:{offset:-1}},{pendingSource:{limit:12001}},{pendingSource:{limit:0}},{pendingSource:{extra:1}},{pendingSource:{},cellIds:['code-1']},{sourceRange:{}},{sourceRange:{},cellIds:['code-1','markdown-1']},{sourceRange:{offset:0.2},cellIds:['code-1']}]) {
    const h=harness([{calls:[call('bad-page','read_notebook',args)]},{text:'Use a valid range.'}],{notebook:new NotebookEditBuffer(exampleNotebook())});
    await h.run();assert.equal(JSON.parse(h.session.messages.find(message=>message.role==='tool').content).executed,false);
  }
});

test('Notebook schemas support rewrite chunks, unknown part counts and bounded partial reads',()=>{
  const [stage,read]=turnTools({},false);
  const operation=stage.function.parameters.properties.operations.items.properties;
  assert.deepEqual(operation.operation.properties.type.enum,['insert_cell','set_source']);
  assert.equal(operation.final.type,'boolean');assert.ok(!stage.function.parameters.properties.operations.items.required.includes('totalParts'));
  assert.match(stage.function.description,/omit it and finish the last part with final:true/);assert.match(stage.function.description,/recommendedBatchTokens: 4096/);
  assert.equal(read.function.parameters.properties.pendingSource.properties.limit.maximum,12000);
  assert.equal(read.function.parameters.properties.sourceRange.properties.offset.minimum,0);
});

test('JSON whitespace and object-key order cannot disguise repeated tool requests while raw arguments stay archived',async()=>{
  const argumentsText=[
    '{"query":"official docs","count":2,"need_content":true}',
    '{ "need_content" : true, "query" : "official docs", "count" : 2 }',
    '{\n  "count": 2,\n  "need_content": true,\n  "query": "official docs"\n}'
  ];
  const calls=argumentsText.map((args,index)=>call('same-search-'+index,'search_web',args));let executions=0;
  const h=harness(calls.map(item=>({calls:[item]})),{web:{execute:async(name,args)=>{executions++;assert.deepEqual(args,{query:'official docs',count:2,need_content:true});return JSON.stringify({kind:'web_search',results:[{url:'https://example.com/docs',content:'Unchanged reference text.'}]});}}});
  await assert.rejects(h.run(),error=>/没有新的进展/.test(error.message)&&error.turnUsage.prompt_tokens===600);
  assert.equal(h.requests.length,3);assert.equal(executions,3);
  assert.deepEqual(h.session.messages.filter(message=>message.tool_calls).map(message=>message.tool_calls[0].function.arguments),argumentsText);
  assert.deepEqual(h.records.filter(record=>record.type==='response').map(record=>record.message.tool_calls[0].function.arguments),argumentsText);
  assert.equal(h.session.messages.filter(message=>message.role==='tool').length,3);
});

test('canonical tool arguments still permit genuinely changed results without a total tool-call cap',async()=>{
  let executions=0;const queries=Array.from({length:6},(_,index)=>index%2 ? '{ "need_content":true, "query":"official docs" }' : '{"query":"official docs","need_content":true}');
  const h=harness([...queries.map((args,index)=>({calls:[call('changed-'+index,'search_web',args)]})),{text:'Answer from changed references.'}],{web:{execute:async()=>JSON.stringify({kind:'web_search',results:[{url:'https://example.com/docs',content:'Verified update '+(++executions)}]})}});
  await h.run();assert.equal(executions,6);assert.equal(h.requests.length,7);assert.deepEqual(h.shown,['Answer from changed references.']);
  assert.ok(h.session.messages.filter(message=>message.role==='tool').every(message=>!JSON.parse(message.content).error));
});

test('Notebook index bounds a minified source preview while explicit reads retain the complete original source',async()=>{
  const source='x=1;'.repeat(50000),notebook=new NotebookEditBuffer({nbformat:4,nbformat_minor:5,cells:[{id:'minified',cell_type:'code',source,outputs:[]}]});
  const h=harness([{calls:[call('index','read_notebook',{})]},{calls:[call('page','read_notebook',{cellIds:['minified'],sourceRange:{offset:199,limit:1234}})]},{calls:[call('full','read_notebook',{cellIds:['minified']})]},{text:'Read the requested source.'}],{notebook});
  await h.run();const [index,page,full]=h.session.messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content));
  assert.deepEqual(index.cells[0],{cellId:'minified',index:0,cellType:'code',firstLine:source.slice(0,200),sourceLength:200000,firstLineTruncated:true});
  assert.ok(JSON.stringify(index).length<1000);assert.equal(page.cells[0].source,source.slice(199,1433));
  assert.equal(page.cells[0].totalSourceLength,source.length);assert.equal(page.cells[0].nextOffset,1433);assert.equal(page.cells[0].hasMore,true);
  assert.equal(full.cells[0].source,source);assert.equal(notebook.read().cells[0].source,source);
});

test('Notebook index previews avoid splitting Unicode surrogate pairs and retain accurate source lengths',async()=>{
  const source='x'.repeat(199)+'🌱'+'end',notebook=new NotebookEditBuffer({nbformat:4,nbformat_minor:5,cells:[{id:'unicode',cell_type:'markdown',source}]});
  const h=harness([{calls:[call('index','read_notebook',{})]},{text:'Read index.'}],{notebook});await h.run();
  const cell=JSON.parse(h.session.messages.find(message=>message.role==='tool').content).cells[0];
  assert.equal(cell.firstLine,'x'.repeat(199));assert.equal(cell.sourceLength,source.length);assert.equal(cell.firstLineTruncated,true);
});

test('deep valid JSON tool arguments cannot break failed-tool result pairing during signature fallback',async()=>{
  const raw='{"imageIds":["image-a"],"question":"Read the axis.","unknown":'+'['.repeat(12000)+'0'+']'.repeat(12000)+'}';
  const h=harness([{calls:[call('deep-image','read_image',raw)]},{text:'Please use valid image arguments.'}],{webEnabled:false,images:{execute:async()=>assert.fail('unknown arguments must not execute')}});
  await h.run();const assistant=h.session.messages.find(message=>message.tool_calls),tool=h.session.messages.find(message=>message.role==='tool');
  assert.equal(assistant.tool_calls[0].function.arguments,raw);assert.equal(tool.tool_call_id,'deep-image');
  assert.equal(JSON.parse(tool.content).executed,false);assert.match(JSON.parse(tool.content).error,/read_image requires/);
  assert.equal(h.records.filter(record=>record.type==='tool_result').length,1);assert.equal(h.requests.length,2);
  assert.equal(h.requests[1].input.at(-1).tool_call_id,'deep-image');assert.deepEqual(h.shown,['Please use valid image arguments.']);
});

test('a historical Notebook call rejected in a web-only request is closed and corrected without enabling Notebook',async()=>{
  let executed=0;
  const rejected=call('call-current-read','read_notebook','{}');
  const history=[
    {role:'user',content:'Write Notebook code.'},
    {role:'assistant',content:'',reasoning_content:'Read previous state.',tool_calls:[call('historical-read','read_notebook','{}')]},
    {role:'tool',tool_call_id:'historical-read',content:'{"kind":"notebook_index","cells":[]}'},
    {role:'assistant',content:'The edits await review.',reasoning_content:'Original prior reasoning.'},
    {role:'user',content:'写点代码'}
  ];
  const h=nativeHarness([{thinking:'Need to inspect the previous Notebook.',calls:[rejected]},{text:'Here is a self-contained code example.'}],{web:{execute:async()=>{executed++;return'{}';}},notebook:null,images:null});
  h.session.messages=structuredClone(history);
  const result=await h.run();
  assert.equal(executed,0);assert.equal(result.patch,null);assert.deepEqual(result.usage,usage(3));
  assert.equal(h.requests.length,2);assert.equal(h.reportedUsage.length,2);
  assert.deepEqual(h.session.messages.slice(0,history.length),history);
  for(const request of h.requests){
    assert.deepEqual(request.body.tools.map(tool=>tool.function.name),['search_web','fetch_page']);
    assert.deepEqual(request.input.slice(1,history.length+1),history);
  }
  const assistant=h.session.messages[history.length],reply=h.session.messages[history.length+1];
  assert.deepEqual(assistant.tool_calls,[rejected]);assert.equal(assistant.reasoning_content,'Need to inspect the previous Notebook.');
  assert.equal(reply.tool_call_id,rejected.id);
  const data=JSON.parse(reply.content);assert.equal(data.executed,false);assert.equal(data.batchRejected,true);
  assert.deepEqual(data.availableTools,['search_web','fetch_page']);assert.deepEqual(data.unavailableTools,['read_notebook']);
  const record=h.records.find(record=>record.rejectedToolCalls);
  assert.deepEqual(record.rejectedToolCalls,[rejected]);assert.equal(record.unfinishedToolCalls,undefined);
  assert.equal(record.rejection.category,'unavailable_tool');assert.match(record.rejection.error,/本次未提供/);
  assert.deepEqual(h.requests[1].input.slice(-3,-1),[assistant,reply]);
  assert.match(h.requests[1].input.at(-1).content,/Tools used in previous turns do not imply access now/);
  assert.deepEqual(h.shown,['Here is a self-contained code example.']);
});

test('unavailable native calls can be safely closed when every tool is disabled',async()=>{
  let executed=0;
  const h=nativeHarness([{calls:[call('disabled-read','read_notebook',{})]},{text:'Plain answer without tools.'}],{webEnabled:false,web:{execute:async()=>{executed++;return'{}';}}});
  const result=await h.run();
  assert.equal(executed,0);assert.equal(result.patch,null);assert.equal(h.requests.length,2);
  assert.ok(h.requests.every(request=>!Object.hasOwn(request.body,'tools')));
  const reply=JSON.parse(h.session.messages.find(message=>message.role==='tool').content);
  assert.equal(reply.executed,false);assert.deepEqual(reply.availableTools,[]);
  assert.equal(h.session.messages.find(message=>message.tool_calls).reasoning_content,'');
  assert.ok(h.requests[1].input.filter(message=>message.role==='assistant').every(message=>message.reasoning_content===undefined));
});

test('mixed available and unavailable native calls are rejected atomically in either ordering',async()=>{
  for(const unknownFirst of [false,true]){
    let executed=0;
    const available=call('known-search','search_web','{"query": "source", "count": 1}'),unavailable=call('unprovided-read','read_notebook','{}');
    const batch=unknownFirst?[unavailable,available]:[available,unavailable];
    const h=nativeHarness([{thinking:'Original mixed batch.',calls:batch},{text:'Continue without Notebook access.'}],{web:{execute:async()=>{executed++;return'{}';}}});
    await h.run();assert.equal(executed,0);
    const assistant=h.session.messages.find(message=>message.tool_calls),replies=h.session.messages.filter(message=>message.role==='tool');
    assert.deepEqual(assistant.tool_calls,batch);assert.equal(assistant.reasoning_content,'Original mixed batch.');
    assert.deepEqual(replies.map(reply=>reply.tool_call_id),batch.map(item=>item.id));
    assert.ok(replies.every(reply=>JSON.parse(reply.content).executed===false&&JSON.parse(reply.content).batchRejected===true));
    assert.equal(h.records.filter(record=>record.rejectedToolCalls).length,1);
    assert.ok(h.records.every(record=>!record.unfinishedToolCalls));
  }
});

test('rejecting a mixed batch also prevents otherwise valid Notebook staging and image requests',async()=>{
  const notebook=new NotebookEditBuffer(exampleNotebook()),before=notebook.currentHash;
  let stages=0,images=0;
  const stage=notebook.stage.bind(notebook);notebook.stage=args=>{stages++;return stage(args);};
  const notebookBatch=[call('stage-valid','stage_notebook_edits',{baseHash:before,operations:[{type:'insert_cell',cellType:'code',source:'print(1)'}],done:true}),call('web-unavailable','fetch_page',{url:'https://example.com'})];
  const staged=nativeHarness([{calls:notebookBatch},{text:'Answer without staging.'}],{webEnabled:false,notebook});
  const result=await staged.run();assert.equal(stages,0);assert.equal(notebook.currentHash,before);assert.equal(result.patch,null);
  const imageBatch=[call('image-valid','read_image',{imageIds:['image-one'],question:'Inspect it.'}),call('notebook-unavailable','read_notebook',{})];
  const pictured=nativeHarness([{calls:imageBatch},{text:'Answer without rereading images.'}],{webEnabled:false,images:{execute:async()=>{images++;return'Image result';}}});
  await pictured.run();assert.equal(images,0);
  for(const h of [staged,pictured])assert.ok(h.session.messages.filter(message=>message.role==='tool').every(message=>JSON.parse(message.content).executed===false));
});

test('unavailable calls with changing IDs, names and arguments hit one shared recovery boundary',async()=>{
  const batches=[
    call('one','read_notebook',{cellIds:['a']}),
    call('two','stage_notebook_edits',{baseHash:'changed',operations:[],done:false}),
    call('three','read_image',{imageIds:['missing'],question:'New question.'})
  ];
  const h=nativeHarness(batches.map(item=>({calls:[item]})),{web:{execute:async()=>assert.fail('No call from a rejected batch may execute')}});
  await assert.rejects(h.run(),error=>{
    assert.equal(error.category,'unavailable_tool');assert.equal(error.incomplete,false);
    assert.equal(error.recoveryLimitReached,true);assert.equal(error.turnUsage.prompt_tokens,600);
    assert.deepEqual(error.toolCalls,[batches[2]]);assert.equal(error.cause.category,'unavailable_tool');
    return true;
  });
  assert.equal(h.requests.length,3);assert.equal(h.reportedUsage.length,3);
  assert.deepEqual(h.session.messages.filter(message=>message.role==='tool').map(message=>message.tool_call_id),batches.map(item=>item.id));
  assert.ok(h.records.every(record=>!record.unfinishedToolCalls));
});

test('the same unavailable call with a different ID cannot repeatedly restart recovery',async()=>{
  const h=nativeHarness([{calls:[call('first','read_notebook',{})]},{calls:[call('second','read_notebook','{ }')]}]);
  await assert.rejects(h.run(),error=>error.category==='unavailable_tool'&&error.recoveryLimitReached===true&&error.turnUsage.prompt_tokens===300);
  assert.equal(h.requests.length,2);assert.equal(h.session.messages.filter(message=>message.role==='tool').length,2);
});

test('malformed or truncated unavailable native calls remain fatal without recovery',async()=>{
  const malformed={id:'',type:'function',function:{name:'read_notebook',arguments:'{}'}};
  for(const response of [{calls:[malformed]},{calls:[call('invalid-json','read_notebook','{"cellIds":')]},{calls:[call('truncated','read_notebook','{"cellIds":')],reason:'length'}]){
    let executed=0;
    const h=nativeHarness([response],{web:{execute:async()=>{executed++;return'{}';}}});
    await assert.rejects(h.run());assert.equal(h.requests.length,1);assert.equal(executed,0);
    assert.equal(h.session.messages.filter(message=>message.role==='tool').length,0);
    assert.equal(h.records.filter(record=>record.rejectedToolCalls).length,0);
    assert.equal(h.records.filter(record=>record.unfinishedToolCalls?.length).length,1);
    assert.equal(h.reportedUsage.length,1);
  }
});

test('cancelling after a complete rejection closes every batch ID without executing or retrying',async()=>{
  let executed=0;
  const batch=[call('known','search_web',{query:'source'}),call('unknown','read_notebook',{})];
  const h=nativeHarness([{thinking:'Original rejection reasoning.',calls:batch}],{web:{execute:async()=>{executed++;return'{}';}}});
  const record=h.options.onRecord;
  h.options.onRecord=value=>{record(value);if(value.rejectedToolCalls)h.controller.abort();};
  await assert.rejects(h.run(),error=>error.name==='AbortError'&&error.turnUsage.prompt_tokens===100);
  assert.equal(executed,0);assert.equal(h.requests.length,1);
  const replies=h.session.messages.filter(message=>message.role==='tool');
  assert.deepEqual(replies.map(reply=>reply.tool_call_id),batch.map(item=>item.id));
  assert.ok(replies.every(reply=>JSON.parse(reply.content).executed===false));
  assert.equal(h.session.messages.find(message=>message.tool_calls).reasoning_content,'Original rejection reasoning.');
});

test('native tool progress reaches the view before execution without adding partial parameters to history',async()=>{
  let executed=0;const progress=[];
  const args='{"query":"A detailed query"}';
  const h=nativeHarness([{calls:[call('native-progress','search_web',args)]},{text:'Verified answer.'}],{web:{execute:async()=>{executed++;return'{}';}}});
  h.options.onToolProgress=value=>{
    progress.push(structuredClone(value));
    assert.equal(executed,0);assert.equal(h.session.messages.length,1);
    assert.deepEqual(h.records,[]);assert.deepEqual(h.raw,[]);
  };
  await h.run();assert.equal(executed,1);assert.equal(progress.length,1);
  assert.equal(progress[0].name,'search_web');assert.equal(progress[0].argumentCharacters,args.length);
  assert.equal(progress[0].totalArgumentCharacters,args.length);
  assert.ok(!JSON.stringify(progress).includes('A detailed query'));
  assert.equal(h.session.messages.find(message=>message.tool_calls).tool_calls[0].function.arguments,args);
  assert.ok(h.session.messages.every(message=>!Object.hasOwn(message,'argumentCharacters')));
});

test('late tool progress after cancellation or request completion does not reach the view',async()=>{
  for(const cancel of [false,true]){
    let options,release;const progress=[];
    const gate=new Promise(resolve=>{release=resolve;});
    const h=harness([],{onToolProgress:value=>progress.push(value)});
    h.options.send=async(_key,_messages,_signal,_text,_http,value)=>{options=value;return gate;};
    const pending=h.run();await Promise.resolve();await Promise.resolve();
    assert.ok(options);
    const value={index:0,name:'search_web',argumentCharacters:2,totalArgumentCharacters:2,addedArgumentCharacters:2,callCount:1};
    if(cancel)h.controller.abort();
    else options.onToolProgress(value);
    release(usage(1));
    if(cancel)await assert.rejects(pending,{name:'AbortError'});else await pending;
    options.onToolProgress({...value,argumentCharacters:100,totalArgumentCharacters:100,addedArgumentCharacters:98});
    assert.equal(progress.length,cancel?0:1);
    assert.equal(h.session.messages.length,1);
  }
});

test('long reasoning, web lookup and staged source survive Stop, serialized reload, resume and compression as one workflow',async()=>{
  const {copyMessage,rebuildEntryMessages,repairOpenTools}=require('./src/history');
  const {compactContext}=require('./src/context');
  const original=exampleNotebook();original.cells=original.cells.filter(cell=>cell.id!=='image-code');
  const live=structuredClone(original),buffer=new NotebookEditBuffer(original),baseHash=buffer.currentHash;
  const longReasoning='Preserve the user changes and verify source evidence.\n'.repeat(250),search=call('workflow-search','search_web',{query:'official source'});
  const start={baseHash,operations:[{type:'source_chunk',chunkId:'workflow-cell',part:0,source:'print(',operation:{type:'set_source',cellId:'code-1'}}],done:false};
  const firstJournal=[],savedStates=[];
  const first=nativeHarness([
    {reason:'tool_calls',deltas:[{reasoning_content:longReasoning.slice(0,4000)},{reasoning_content:longReasoning.slice(4000)},{tool_calls:[{index:0,...search}]}]},
    {thinking:'Use the verified evidence while collecting source.',calls:[call('workflow-stage-first','stage_notebook_edits',start)]}
  ],{notebook:buffer,web:{execute:async()=>'{"content":"Verified source evidence","url":"https://example.com/docs"}'},onMessage:message=>firstJournal.push(message)});
  first.options.onCheckpoint=async state=>{savedStates.push(JSON.parse(JSON.stringify(state)));first.controller.abort();};
  await assert.rejects(first.run(),error=>error.name==='AbortError'&&error.turnUsage.prompt_tokens===300);
  assert.equal(first.requests.length,2);assert.equal(first.reportedUsage.length,2);
  assert.equal(buffer.readPending().source,'print(');assert.equal(buffer.done,false);assert.deepEqual(live,original);
  assert.equal(first.session.messages[1].reasoning_content,longReasoning);
  const firstEntries=[{label:'你',raw:first.session.messages[0].content},{label:'deepseek-flash',raw:'',thinking:longReasoning,modelMessages:firstJournal}];
  const disk=JSON.parse(JSON.stringify({messages:first.session.messages,entries:firstEntries,task:savedStates.at(-1)}));
  const restored=NotebookEditBuffer.restore(disk.task),restoredMessages=rebuildEntryMessages(disk.entries);
  assert.deepEqual(restoredMessages,disk.messages);assert.deepEqual(repairOpenTools(restoredMessages),[]);
  assert.equal(restored.readPending().source,'print(');assert.equal(restored.status().nextPart,1);
  const frozenPrefix=JSON.stringify(restoredMessages),secondJournal=[];
  const finish={baseHash:restored.currentHash,operations:[{type:'source_chunk',chunkId:'workflow-cell',part:1,source:'"complete")',final:true}],done:true};
  const second=nativeHarness([
    {thinking:'Read accepted source before resuming.',calls:[call('workflow-read-pending','read_notebook',{pendingSource:{offset:0,limit:12000}})]},
    {thinking:'Finish only the unaccepted source.',calls:[call('workflow-stage-last','stage_notebook_edits',finish)]},
    {text:'The complete change awaits review.'}
  ],{notebook:restored,onMessage:message=>secondJournal.push(message)});
  second.session.messages=[...restoredMessages,{role:'user',content:'Resume the accepted edit task.'}];
  const completed=await second.run();
  assert.equal(JSON.stringify(second.session.messages.slice(0,restoredMessages.length)),frozenPrefix);
  assert.equal(completed.patch.operations.length,1);assert.equal(completed.patch.operations[0].source,'print("complete")');
  assert.deepEqual(live,original);
  const pendingReply=second.session.messages.find(message=>message.tool_call_id==='workflow-read-pending');
  assert.equal(JSON.parse(pendingReply.content).source,'print(');
  const allEntries=[...disk.entries,{label:'你',raw:'Resume the accepted edit task.'},{label:'deepseek-flash',raw:'The complete change awaits review.',modelMessages:secondJournal}];
  const transcript=JSON.stringify(allEntries),before=second.session.messages.map(copyMessage);
  const summary='Edit task '+restored.taskId+' is complete but unapplied. One set_source operation contains print("complete"). Source: https://example.com/docs.';
  const checkpoint=await compactContext(second.session,'fake',new AbortController().signal,()=>{},async(_key,messages,_signal,onText)=>{
    assert.deepEqual(messages.slice(1,1+before.length),before);
    assert.equal(messages.filter(message=>message.tool_calls?.some(call=>call.id==='workflow-stage-first')).length,1);
    onText(summary);return usage(1);
  },0,true,SYSTEM_PROMPT,{contextWindow:1048576,maxOutputTokens:393216},'deepseek-flash',true);
  assert.ok(checkpoint.after<checkpoint.before);assert.equal(second.session.messages.length,1);
  assert.equal(second.session.compactions,1);assert.match(second.session.messages[0].content,/complete but unapplied/);
  assert.equal(JSON.stringify(allEntries),transcript);
  const finalDisk=JSON.parse(JSON.stringify({messages:second.session.messages,entries:allEntries,task:restored.exportState()}));
  assert.deepEqual(repairOpenTools(finalDisk.messages),[]);
  assert.deepEqual(NotebookEditBuffer.restore(finalDisk.task).result(),completed.patch);
  assert.deepEqual(rebuildEntryMessages(finalDisk.entries),before);
});

test('Stop during native parameter streaming archives the partial call but never replays it after reload or compression',async()=>{
  const {rebuildEntryMessages,repairOpenTools}=require('./src/history');
  const {compactContext}=require('./src/context');
  const thoughts='Long original reasoning before parameters.\n'.repeat(200),partial='{"query":"NEVER_REPLAY_PARTIAL';
  const journal=[];let executions=0;
  const h=nativeHarness([{reason:'tool_calls',deltas:[{reasoning_content:thoughts},{tool_calls:[{index:0,...call('cut-args','search_web',partial)}]},{tool_calls:[{index:0,function:{arguments:' ignored final"}'}}]}]}],{web:{execute:async()=>{executions++;return'{}';}},onMessage:message=>journal.push(message)});
  h.options.onToolProgress=()=>h.controller.abort();
  await assert.rejects(h.run(),{name:'AbortError'});
  assert.equal(executions,0);assert.equal(h.requests.length,1);
  assert.equal(h.records[0].unfinishedToolCalls[0].function.arguments,partial);
  assert.equal(journal[0].tool_calls,undefined);assert.equal(journal[0].reasoning_content,thoughts);
  const entries=JSON.parse(JSON.stringify([{label:'你',raw:h.session.messages[0].content},{label:'deepseek-flash',raw:'',modelMessages:journal,failedRequests:h.records}]));
  const restored=rebuildEntryMessages(entries);assert.deepEqual(repairOpenTools(restored),[]);
  const next=nativeHarness([{text:'A normal answer after stopping.'}]);next.session.messages=[...restored,{role:'user',content:'Continue in ordinary chat.'}];
  await next.run();
  assert.doesNotMatch(JSON.stringify(next.requests[0].input),/NEVER_REPLAY_PARTIAL/);
  assert.equal(next.requests[0].input[2].reasoning_content,thoughts);
  const originalArchive=JSON.stringify(entries);
  await compactContext(next.session,'fake',new AbortController().signal,()=>{},async(_key,messages,_signal,onText)=>{
    assert.doesNotMatch(JSON.stringify(messages),/NEVER_REPLAY_PARTIAL/);onText('The earlier request was stopped before any tool executed.');return usage(1);
  },0,true,SYSTEM_PROMPT,{contextWindow:1048576,maxOutputTokens:393216},'deepseek-flash',true);
  assert.equal(JSON.stringify(entries),originalArchive);assert.match(originalArchive,/NEVER_REPLAY_PARTIAL/);
});

test('a crash-repaired native batch is replayed to the next request without reexecuting old calls',async()=>{
  const {rebuildEntryMessages,repairOpenTools}=require('./src/history');
  const oldCalls=[call('crash-completed','fetch_page',{url:'https://example.com/one'}),call('crash-unknown','fetch_page',{url:'https://example.com/two'})];
  const entries=[{label:'你',raw:'Read both sources.'},{label:'deepseek-flash',raw:'',modelMessages:[{role:'assistant',content:'Reading.',reasoning_content:'Preserve exact original reasoning.',tool_calls:oldCalls},{role:'tool',tool_call_id:'crash-completed',content:'{"content":"Saved first source"}'}]}];
  const original=JSON.stringify(entries),messages=rebuildEntryMessages(JSON.parse(JSON.stringify(entries))),added=repairOpenTools(messages);
  assert.equal(added.length,1);assert.equal(added[0].tool_call_id,'crash-unknown');assert.equal(JSON.parse(added[0].content).executed,null);
  let executed=0;const h=nativeHarness([{text:'The second source outcome is unknown; it was not assumed successful.'}],{web:{execute:async()=>{executed++;return'{}';}}});
  h.session.messages=[...messages,{role:'user',content:'What can be concluded?'}];await h.run();
  assert.equal(executed,0);assert.equal(h.requests.length,1);
  assert.deepEqual(h.requests[0].input.slice(1,messages.length+1),messages);
  assert.equal(JSON.stringify(entries),original);assert.deepEqual(repairOpenTools(h.session.messages),[]);
});

test('Stop inside compression between accepted batches preserves the paired history and resumable source',async()=>{
  const {chat}=require('./src/core'),{compactContext}=require('./src/context'),{repairOpenTools}=require('./src/history');
  const original=exampleNotebook();original.cells=original.cells.filter(cell=>cell.id!=='image-code');
  const notebook=new NotebookEditBuffer(original),journal=[],checkpoints=[];
  const first={baseHash:notebook.currentHash,operations:[{type:'source_chunk',chunkId:'between-batches',part:0,source:'print(',operation:{type:'set_source',cellId:'code-1'}}],done:false};
  let preparations=0,compressionRequests=0,beforeCompression;
  const h=nativeHarness([{thinking:'Accepted work must survive interrupted compression.\n'.repeat(80),calls:[call('before-compression','stage_notebook_edits',first)]}],{notebook,onMessage:message=>journal.push(message),onCheckpoint:async state=>checkpoints.push(JSON.parse(JSON.stringify(state)))});
  h.options.beforeRequest=async()=>{
    if(++preparations!==2)return;
    beforeCompression=JSON.stringify(h.session.messages);
    await compactContext(h.session,'fake',h.controller.signal,()=>{},(key,messages,signal,onText,_http,options)=>chat(key,messages,signal,onText,async(_url,request)=>{
      compressionRequests++;assert.equal(request.body.includes('before-compression'),true);
      request.onChunk(Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:'A partial checkpoint that must not replace history.'}}]})+'\n\n'));
      h.controller.abort();
      request.onChunk(Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:'Late text'},finish_reason:'stop'}],usage:usage(5)})+'\n\ndata: [DONE]\n\n'));
    },options),0,true,SYSTEM_PROMPT,{contextWindow:1048576,maxOutputTokens:393216},'deepseek-flash',true);
  };
  await assert.rejects(h.run(),error=>error.name==='AbortError'&&error.turnUsage.prompt_tokens===100);
  assert.equal(compressionRequests,1);assert.equal(h.requests.length,1);assert.equal(h.reportedUsage.length,1);
  assert.equal(JSON.stringify(h.session.messages),beforeCompression);
  assert.deepEqual(repairOpenTools(h.session.messages),[]);
  assert.doesNotMatch(JSON.stringify(h.session.messages),/partial checkpoint|Late text/);
  assert.equal(notebook.readPending().source,'print(');
  const restored=NotebookEditBuffer.restore(checkpoints.at(-1));
  assert.equal(restored.status().nextPart,1);assert.equal(restored.readPending().source,'print(');
  const next=nativeHarness([{calls:[call('after-compression-stop','stage_notebook_edits',{baseHash:restored.currentHash,operations:[{type:'source_chunk',chunkId:'between-batches',part:1,source:'9)',final:true}],done:true})]},{text:'Complete, awaiting review.'}],{notebook:restored});
  next.session.messages=[...JSON.parse(beforeCompression),{role:'user',content:'Continue after the stopped checkpoint.'}];
  const result=await next.run();assert.equal(result.patch.operations[0].source,'print(9)');assert.equal(result.patch.operations.length,1);
  assert.equal(journal.filter(message=>message.role==='tool').length,1);
});

test('reasoning, body and argument phases remain separate and replay unchanged across native tool rounds',async()=>{
  let executions=0;const progress=[];
  const h=nativeHarness([
    {reason:'tool_calls',deltas:[
      {reasoning_content:'Reasoning before the lookup.\n'},
      {content:'I will verify the source.\n'},
      {tool_calls:[{index:0,...call('phase-call','fetch_page','{"url":"https://example.com')}]},
      {reasoning_content:'More original reasoning while assembling the request.\n'},
      {tool_calls:[{index:0,function:{arguments:'/docs"}'}}]}
    ]},
    {deltas:[{reasoning_content:'Reasoning from the returned page.'},{content:'First conclusion. '},{content:'Second conclusion.'}]}
  ],{web:{execute:async()=>{executions++;return'{"content":"Full reference text"}';}},onToolProgress:value=>{progress.push(value);assert.equal(executions,0);}});
  await h.run();assert.equal(executions,1);assert.equal(progress.length,2);
  const first=h.session.messages[1];
  assert.equal(first.content,'I will verify the source.\n');
  assert.equal(first.reasoning_content,'Reasoning before the lookup.\nMore original reasoning while assembling the request.\n');
  assert.equal(first.tool_calls[0].function.arguments,'{"url":"https://example.com/docs"}');
  assert.deepEqual(h.requests[1].input.slice(-2),[first,h.session.messages[2]]);
  assert.equal(h.session.messages.at(-1).reasoning_content,'Reasoning from the returned page.');
  assert.equal(h.session.messages.at(-1).content,'First conclusion. Second conclusion.');
});

test('an initially unavailable Notebook lease exposes only web tools and does not force an unfinished task to resume',async()=>{
  const originalNotebook=exampleNotebook();originalNotebook.cells=originalNotebook.cells.filter(cell=>cell.id!=='image-code');
  const notebook=new NotebookEditBuffer(originalNotebook),baseHash=notebook.currentHash;
  notebook.stage({baseHash,operations:[{type:'source_chunk',chunkId:'lease-pending',part:0,source:'print(',operation:{type:'set_source',cellId:'code-1'}}],done:false});
  const original=notebook.exportState(),checkpoints=[];let webCalls=0;
  const h=nativeHarness([{calls:[call('web-only','search_web',{query:'source'})]},{text:'The ordinary answer can continue.'}],{
    notebook,notebookAvailable:()=>false,web:{execute:async()=>{webCalls++;return'{}';}},onCheckpoint:async state=>checkpoints.push(state)
  });
  const result=await h.run();assert.equal(webCalls,1);assert.equal(result.patch,null);assert.equal(h.requests.length,2);
  assert.ok(h.requests.every(request=>request.body.tools.every(tool=>['search_web','fetch_page'].includes(tool.function.name))));
  assert.deepEqual(notebook.exportState(),original);assert.ok(checkpoints.length>0);
  assert.equal(NotebookEditBuffer.restore(checkpoints.at(-1)).readPending().source,'print(');
  assert.ok(!h.session.messages.some(message=>message.role==='user'&&/unfinished/.test(message.content)));
});

test('Notebook loss during preflight revokes this request and a reconnection cannot restore its schemas',async()=>{
  const notebook=new NotebookEditBuffer(exampleNotebook());let live=true,preparations=0;
  const h=nativeHarness([{calls:[call('request-one','fetch_page',{url:'https://example.com'})]},{text:'Web answer after reconnection.'}],{
    notebook,notebookAvailable:()=>live,beforeRequest:async()=>{if(++preparations===1){await Promise.resolve();live=false;}},
    web:{execute:async()=>{live=true;return'{}';}}
  });
  await h.run();assert.equal(live,true);
  assert.ok(h.requests.every(request=>request.body.tools.every(tool=>!['read_notebook','stage_notebook_edits'].includes(tool.function.name))));
  assert.equal(notebook.status().started,false);
  const next=nativeHarness([{calls:[call('next-turn-read','read_notebook',{})]},{text:'Notebook is available in the next turn.'}],{notebook,notebookAvailable:()=>live});
  await next.run();assert.ok(next.requests[0].body.tools.some(tool=>tool.function.name==='read_notebook'));
  assert.equal(JSON.parse(next.session.messages.find(message=>message.role==='tool').content).kind,'notebook_index');
});

test('a registered Notebook call revoked during streaming is paired without execution while its web sibling still runs',async()=>{
  for(const notebookFirst of [false,true]){
    const notebook=new NotebookEditBuffer(exampleNotebook()),before=notebook.currentHash;let live=true,stages=0,webCalls=0;
    const originalStage=notebook.stage.bind(notebook);notebook.stage=args=>{stages++;return originalStage(args);};
    const edit=call('revoked-stage','stage_notebook_edits',{baseHash:before,operations:[{type:'set_source',cellId:'code-1',source:'must not be staged'}],done:true});
    const search=call('allowed-search','search_web',{query:'still useful'}),batch=notebookFirst?[edit,search]:[search,edit];
    const h=nativeHarness([{thinking:'Both calls were initially advertised.',calls:batch},{text:'Continue with verified web information.'}],{
      notebook,notebookAvailable:()=>live,onToolProgress:()=>{live=false;},web:{execute:async()=>{webCalls++;return'{"content":"Verified web text"}';}}
    });
    const result=await h.run();assert.equal(stages,0);assert.equal(notebook.currentHash,before);assert.equal(webCalls,1);assert.equal(result.patch,null);
    assert.ok(h.requests[0].body.tools.some(tool=>tool.function.name==='stage_notebook_edits'));
    assert.ok(h.requests[1].body.tools.every(tool=>!['read_notebook','stage_notebook_edits'].includes(tool.function.name)));
    const replies=h.session.messages.filter(message=>message.role==='tool');assert.deepEqual(replies.map(reply=>reply.tool_call_id),batch.map(item=>item.id));
    const unavailable=JSON.parse(replies.find(reply=>reply.tool_call_id==='revoked-stage').content);
    assert.equal(unavailable.code,'notebook_unavailable');assert.equal(unavailable.executed,false);assert.equal(unavailable.applied,false);
    assert.equal(JSON.parse(replies.find(reply=>reply.tool_call_id==='allowed-search').content).content,'Verified web text');
    assert.ok(h.records.every(record=>!record.rejectedToolCalls&&!record.unfinishedToolCalls));
    assert.deepEqual(h.session.messages.find(message=>message.tool_calls).tool_calls,batch);
  }
});

test('Notebook execution checks the lease again after an earlier web tool awaited network work',async()=>{
  const notebook=new NotebookEditBuffer(exampleNotebook()),before=notebook.currentHash;let live=true;
  const h=nativeHarness([{calls:[call('awaited-web','fetch_page',{url:'https://example.com'}),call('late-notebook','stage_notebook_edits',{baseHash:before,operations:[],done:true})]},{text:'The web answer remains available.'}],{
    notebook,notebookAvailable:()=>live,web:{execute:async()=>{await Promise.resolve();live=false;return'{"content":"Source"}';}}
  });
  await h.run();assert.equal(notebook.status().started,false);
  const replies=h.session.messages.filter(message=>message.role==='tool');
  assert.equal(JSON.parse(replies[0].content).content,'Source');assert.equal(JSON.parse(replies[1].content).code,'notebook_unavailable');
  assert.equal(h.requests.length,2);
});

test('disconnect after accepted staging preserves the pending task and disables forced completion and reasoning replay for the next tool-free request',async()=>{
  const original=exampleNotebook();original.cells=original.cells.filter(cell=>cell.id!=='image-code');
  const notebook=new NotebookEditBuffer(original),saved=[];let live=true;
  const first=call('accepted-before-loss','stage_notebook_edits',{baseHash:notebook.currentHash,operations:[{type:'source_chunk',chunkId:'lost-connection',part:0,source:'print(',operation:{type:'set_source',cellId:'code-1'}}],done:false});
  const h=nativeHarness([{thinking:'This thinking belongs to the original tools request.',calls:[first]},{text:'The partial edits are saved; reconnect before continuing.'}],{
    notebook,webEnabled:false,notebookAvailable:()=>live,onCheckpoint:async state=>{saved.push(structuredClone(state));live=false;}
  });
  const result=await h.run();assert.equal(result.patch,null);assert.equal(h.requests.length,2);
  assert.ok(h.requests[0].body.tools.some(tool=>tool.function.name==='stage_notebook_edits'));
  assert.equal(h.requests[1].body.tools,undefined);
  assert.equal(h.requests[1].input.find(message=>message.tool_calls).reasoning_content,undefined);
  assert.equal(h.session.messages.find(message=>message.tool_calls).reasoning_content,'This thinking belongs to the original tools request.');
  assert.deepEqual(h.reportedUsage.map(item=>item[2].includeReasoning),[true,false]);
  assert.equal(NotebookEditBuffer.restore(saved.at(-1)).readPending().source,'print(');
  assert.ok(!h.session.messages.some(message=>message.role==='user'&&/unfinished/.test(message.content)));
});

test('several registered Notebook calls after lease loss remain paired without turning an ordinary web answer into a fatal retry loop',async()=>{
  const notebook=new NotebookEditBuffer(exampleNotebook());let live=true,reads=0;
  const originalRead=notebook.read.bind(notebook);notebook.read=()=>{reads++;return originalRead();};
  const batch=Array.from({length:5},(_,index)=>call('revoked-read-'+index,'read_notebook',{}));
  const h=nativeHarness([{calls:batch},{text:'Continue as an ordinary conversation.'}],{notebook,notebookAvailable:()=>live,onToolProgress:()=>{live=false;}});
  await h.run();assert.equal(reads,0);assert.equal(h.requests.length,2);
  const replies=h.session.messages.filter(message=>message.role==='tool');assert.equal(replies.length,5);
  assert.ok(replies.every(reply=>JSON.parse(reply.content).code==='notebook_unavailable'));
});

test('a truncated Notebook call after stream-time disconnect degrades to web or ordinary chat without replaying partial source',async()=>{
  for(const webEnabled of [false,true]){
    const original=exampleNotebook();original.cells=original.cells.filter(cell=>cell.id!=='image-code');
    const notebook=new NotebookEditBuffer(original),baseHash=notebook.currentHash,saved=[];let live=true,webCalls=0;
    notebook.stage({baseHash,operations:[{type:'source_chunk',chunkId:'preserved-before-disconnect',part:0,source:'print(',operation:{type:'set_source',cellId:'code-1'}}],done:false});
    const before=notebook.exportState(),partial='{"baseHash":"'+baseHash+'","operations":[{"type":"source_chunk","source":"NEVER_REPLAY_LOST_SOURCE';
    const script=[{thinking:'The connection may disappear while arguments are being generated.',calls:[call('lost-length','stage_notebook_edits',partial)],reason:'length'}];
    if(webEnabled)script.push({calls:[call('remaining-web','search_web',{query:'still useful'})]});
    script.push({text:'The accepted partial task is saved. Here is the normal answer.'});
    const h=nativeHarness(script,{notebook,webEnabled,notebookAvailable:()=>live,onToolProgress:()=>{live=false;},web:{execute:async()=>{webCalls++;return'{}';}},onCheckpoint:async state=>saved.push(structuredClone(state))});
    const result=await h.run();assert.equal(result.patch,null);assert.equal(webCalls,webEnabled?1:0);
    assert.equal(h.requests.length,webEnabled?3:2);assert.deepEqual(notebook.exportState(),before);
    assert.equal(NotebookEditBuffer.restore(saved.at(-1)).readPending().source,'print(');
    const record=h.records.find(record=>record.unfinishedToolCalls);
    assert.equal(record.unfinishedToolCalls[0].function.arguments,partial);assert.equal(record.finishReason,'length');
    assert.equal(h.session.messages.some(message=>message.role==='tool'&&message.tool_call_id==='lost-length'),false);
    assert.equal(h.session.messages.some(message=>message.tool_calls?.some(call=>call.id==='lost-length')),false);
    assert.match(h.requests[1].input.at(-1).content,/do not continue Notebook edits/);
    assert.doesNotMatch(JSON.stringify(h.requests[1].input),/NEVER_REPLAY_LOST_SOURCE|smaller complete JSON batches/);
    for(const request of h.requests.slice(1))assert.ok(!request.body.tools?.some(tool=>['stage_notebook_edits','read_notebook'].includes(tool.function.name)));
    assert.deepEqual(h.reportedUsage.map(item=>item[2].includeReasoning),webEnabled?[true,true,true]:[true,false]);
  }
});

test('changing truncated Notebook calls after lease loss cannot endlessly restart ordinary-chat recovery',async()=>{
  const notebook=new NotebookEditBuffer(exampleNotebook());let live=true;
  const h=nativeHarness([0,1,2].map(index=>({calls:[call('lost-'+index,'stage_notebook_edits','{"source":"different-lost-'+index)],reason:'length'})),{
    notebook,webEnabled:false,notebookAvailable:()=>live,onToolProgress:()=>{live=false;}
  });
  await assert.rejects(h.run(),error=>error.finishReason==='length'&&error.recoveryLimitReached===true&&error.turnUsage.prompt_tokens===600);
  assert.equal(h.requests.length,3);assert.equal(notebook.status().started,false);
  assert.equal(h.session.messages.filter(message=>message.role==='tool').length,0);
  assert.equal(h.records.filter(record=>record.unfinishedToolCalls).length,3);
  assert.ok(h.requests.slice(1).every(request=>request.body.tools===undefined));
  assert.doesNotMatch(JSON.stringify(h.session.messages),/smaller complete JSON batches/);
});
