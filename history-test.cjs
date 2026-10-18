const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { copyMessage, sameMessage, repairOpenTools, rebuildEntryMessages } = require('./src/history');
const { requestTimeContext } = require('./src/request-context');
const hash = text => createHash('sha256').update(text).digest('hex');
const call = id => ({ id, type: 'function', function: { name: 'fetch_page', arguments: JSON.stringify({ url: 'https://example.com/' + id }) } });
const reply = (id, content = '{}') => ({ role: 'tool', tool_call_id: id, content });
const assistant = calls => ({ role: 'assistant', content: 'Reading the source.', reasoning_content: 'Original thought.', tool_calls: calls });
const library = (id, text) => `Reference ID: ${id}\nTitle: Paper ${id}\nSource: arxiv/${id}/source.tex\nReference text:\n\n${text}`;
const web = (text, url = 'https://example.com/docs', title = 'Docs') => `\n\n[Web reference sha256:${hash(text)}]\nURL: ${url}\nTitle: ${title}\n\n${text}`;
const user = (raw, suffix, references) => ({ label: '你', raw, contextText: raw + suffix, ...(references ? { references } : {}) });

test('large message snapshots preserve exact JSON and field ordering without serializing immutable text',()=>{
  const calls=[{function:{arguments:JSON.stringify({source:'print("line")\n'.repeat(15000)}),name:'stage_notebook_edits'},type:'function',id:'large-call'}];
  const message={role:'assistant',content:'Text\n$z$\n'.repeat(40000),reasoning_content:'Reasoning.\n'.repeat(40000),tool_calls:calls,ignored:'not transmitted'};
  const fields=['role','content','reasoning_content','tool_calls','tool_call_id'];
  const original=JSON.stringify(Object.fromEntries(fields.filter(name=>message[name]!==undefined).map(name=>[name,message[name]])));
  const stringify=JSON.stringify;let serializations=0;JSON.stringify=(...args)=>{serializations++;return stringify(...args);};let copied;
  try{copied=copyMessage(message);}finally{JSON.stringify=stringify;}
  assert.equal(serializations,0);assert.equal(JSON.stringify(copied),original);
  assert.notEqual(copied,message);assert.notEqual(copied.tool_calls,calls);assert.notEqual(copied.tool_calls[0],calls[0]);assert.notEqual(copied.tool_calls[0].function,calls[0].function);
  copied.tool_calls[0].function.name='changed';copied.content+='more';assert.equal(message.tool_calls[0].function.name,'stage_notebook_edits');assert.ok(!message.content.endsWith('more'));
});

test('message snapshot fallback preserves additional provider fields and JSON conversion semantics',()=>{
  const message={role:'assistant',content:'unchanged',tool_calls:[{id:'extra',type:'function',function:{name:'fetch_page',arguments:'{}',provider:{value:undefined,values:[NaN,undefined]}},additional:{nested:['keep']}}]};
  const copied=copyMessage(message);assert.deepEqual(copied,JSON.parse(JSON.stringify(message)));copied.tool_calls[0].additional.nested.push('new');assert.deepEqual(message.tool_calls[0].additional.nested,['keep']);
  assert.deepEqual(copyMessage({role:'user',content:null}),{role:'user',content:null});assert.deepEqual(copyMessage({role:'assistant',content:'ok',tool_calls:[]}),{role:'assistant',content:'ok',tool_calls:[]});
});

test('exact message matching preserves field order and detects equal-length edits without serializing ordinary native parameters',()=>{
  const original={role:'assistant',content:'Body A',reasoning_content:'Reason A',tool_calls:[call('one')]},snapshot=copyMessage(original);
  const stringify=JSON.stringify;let serialized=0;JSON.stringify=(...args)=>{serialized++;return stringify(...args);};
  try{
    assert.equal(sameMessage(original,snapshot),true);
    original.content=['B','o','d','y',' ','A'].join('');original.reasoning_content=Array.from('Reason A').join('');
    assert.equal(sameMessage(original,snapshot),true);assert.equal(serialized,0);
  }finally{JSON.stringify=stringify;}
  const mutations=[message=>{message.content='Body B';},message=>{message.reasoning_content='Reason B';},message=>{message.tool_calls[0].function.arguments='{"url":"https://example.com/two"}';},message=>{message.tool_calls[0].id='two';},message=>{message.tool_calls[0].function={arguments:message.tool_calls[0].function.arguments,name:message.tool_calls[0].function.name};}];
  for(const mutate of mutations){const changed=copyMessage(snapshot);mutate(changed);assert.equal(sameMessage(changed,snapshot),false);}
});

test('exact message matching retains provider extra-field JSON fallback and normalization semantics',()=>{
  const message={role:'assistant',content:'Body',tool_calls:[{...call('one'),provider:{value:'old',ignored:undefined}}]},snapshot=copyMessage(message);
  assert.equal(sameMessage(message,snapshot),true);
  message.tool_calls[0].provider.value='new';assert.equal(sameMessage(message,snapshot),false);
  message.tool_calls[0].provider.value='old';message.tool_calls[0].provider.ignored=undefined;
  assert.equal(sameMessage(message,snapshot),true);
  message.tool_calls[0].provider={ignored:undefined,value:'old'};assert.equal(sameMessage(message,snapshot),true);
  assert.equal(sameMessage({role:'assistant',content:null},{role:'assistant',content:null}),true);
});

test('interrupted tool restoration appends only missing results and explicitly preserves an unknown outcome', () => {
  const messages = [{ role: 'user', content: 'Read sources.' }, assistant([call('one'), call('two'), call('three')]), reply('two')];
  const before = structuredClone(messages), added = repairOpenTools(messages);
  assert.deepEqual(messages.slice(0, before.length), before);
  assert.deepEqual(added.map(message => message.tool_call_id), ['one', 'three']);
  assert.deepEqual(messages.slice(before.length), added);
  for (const message of added) { const data = JSON.parse(message.content); assert.equal(data.executed, null); assert.equal(data.interrupted, true); assert.match(data.error, /outcome is unknown/); }
  assert.deepEqual(repairOpenTools(messages), []);
});

test('tool restoration does not rewrite completed, interleaved or ambiguous historical groups', () => {
  for (const messages of [
    [assistant([call('one')]), reply('one')],
    [assistant([call('one')]), { role: 'user', content: 'Later question.' }],
    [assistant([call('one')]), reply('unknown')],
    [assistant([call('one')]), reply('one'), reply('one')],
    [assistant([call('one'), call('one')])],
    [{ role: 'assistant', content: 'Ordinary answer.' }]
  ]) { const before = structuredClone(messages); assert.deepEqual(repairOpenTools(messages), []); assert.deepEqual(messages, before); }
});

test('history rebuilding retains one full library reference while preserving each question and Notebook delta', () => {
  const a = library('2601.XXXXX', 'FIRST SOURCE'), b = library('2602.YYYYY', 'SECOND SOURCE');
  const entries = [user('first', '\n\n' + a, a), { label: 'deepseek-flash', raw: 'answer' }, user('second', '\n\n' + a + '\n\n---\n\n' + b + '\n\n[Notebook delta]\n{"currentHash":"snapshot"}', a + '\n\n---\n\n' + b)];
  const before = structuredClone(entries), messages = rebuildEntryMessages(entries);
  assert.equal(messages[0].content, 'first\n\n' + a);
  assert.equal(messages[2].content, 'second\n\n' + b + '\n\n[Notebook delta]\n{"currentHash":"snapshot"}');
  assert.deepEqual(entries, before);
  assert.equal(rebuildEntryMessages(entries.slice(2))[0].content, entries[2].contextText);
});

test('history rebuilding preserves simple archived reference bodies and original user text', () => {
  const reference = 'FULL REFERENCE', entries = [user('first', '\n\n' + reference, reference), user('FULL REFERENCE is my question', '\n\n' + reference, reference)];
  const result = rebuildEntryMessages(entries);
  assert.equal(result[0].content, entries[0].contextText); assert.equal(result[1].content, 'FULL REFERENCE is my question');
  const raw = '[Web reference sha256:' + hash('literal') + ']\nURL: https://example.com\nTitle: User text\n\nliteral';
  assert.equal(rebuildEntryMessages([user(raw, '')])[0].content, raw);
});

test('history rebuilding deduplicates verified web references without dropping Notebook context', () => {
  const body = '# Page\nOriginal text.', suffix = web(body), delta = '\n\n[Notebook delta]\n{"currentHash":"hash"}';
  const entries = [user('first URL', suffix), user('second URL', suffix + delta)];
  const messages = rebuildEntryMessages(entries);
  assert.equal(messages[0].content, entries[0].contextText); assert.equal(messages[1].content, 'second URL' + delta);
  assert.equal(rebuildEntryMessages(entries.slice(1))[0].content, entries[1].contextText);
});

test('web text already present in paired tool results is reused without rewriting the tool conversation or receipts', () => {
  const body = 'FULL WEB TEXT', toolMessages = [assistant([call('fetch')]), reply('fetch', JSON.stringify({ kind: 'web_fetch', hash: hash(body), content: body, url: 'https://example.com/docs' })), { role: 'assistant', content: 'Done.' }];
  const receipt = { role: 'user', content: '[Notebook edits applied]\n{"currentHash":"applied"}' };
  const entries = [{ label: 'deepseek-flash', raw: 'Done.', modelMessages: toolMessages }, user('Read again', web(body)), { label: 'Notebook 操作', raw: 'Applied.', notebookEvent: true, modelMessages: [receipt] }];
  const before = structuredClone(entries), messages = rebuildEntryMessages(entries);
  assert.deepEqual(messages.slice(0, 3), toolMessages); assert.equal(messages[3].content, 'Read again'); assert.deepEqual(messages[4], receipt); assert.deepEqual(entries, before);
});

test('changed web text or a forged reference hash remains available during rebuilding', () => {
  const first = 'Version one', second = 'Version two';
  const forged = web(second).replace(hash(second), hash(first));
  const entries = [user('first', web(first)), user('changed', web(second)), user('uncertain', forged)];
  assert.deepEqual(rebuildEntryMessages(entries).map(message => message.content), entries.map(entry => entry.contextText));
});

test('history rebuilding handles direct URL mentions and mixed library plus web references', () => {
  const body = 'WEB BODY', reference = library('2601.XXXXX', 'LIBRARY BODY'), raw = 'Read @[https://example.com/docs]';
  const first = user('first', '\n\n' + reference + web(body), reference);
  const second = { label: '你', raw, references: reference, contextText: 'Read https://example.com/docs\n\n' + reference + web(body) + '\n\n[Notebook delta]\n{}' };
  assert.equal(rebuildEntryMessages([first, second])[1].content, 'Read https://example.com/docs\n\n[Notebook delta]\n{}');
});

test('nested web markers inside a source remain part of its verified body', () => {
  const nestedBody = 'Nested source text', nested = web(nestedBody), outer = '# Outer source' + nested;
  const entries = [user('known nested source', nested), user('outer source', web(outer))];
  assert.equal(rebuildEntryMessages(entries)[1].content, entries[1].contextText);
});

test('request time metadata survives reference deduplication for every original question', () => {
  const firstTime = requestTimeContext({ now: Date.parse('2026-10-17T00:00:00Z'), timeZone: 'UTC' });
  const secondTime = requestTimeContext({ now: Date.parse('2026-10-17T01:00:00Z'), timeZone: 'Asia/Shanghai' });
  const reference = library('2601.XXXXX', 'LIBRARY BODY'), body = 'WEB BODY';
  const entries = [user('First question', '\n\n' + reference + web(body) + firstTime, reference), user('Second question', '\n\n' + reference + web(body) + secondTime, reference)];
  const before = structuredClone(entries), result = rebuildEntryMessages(entries);
  assert.equal(result[0].content, entries[0].contextText);
  assert.equal(result[1].content, 'Second question' + secondTime);
  assert.deepEqual(entries, before);
  assert.equal(rebuildEntryMessages(entries.slice(1))[0].content, entries[1].contextText);
});

test('web metadata and request time are excluded from verified body hashes', () => {
  const body = 'Original page text.', timestamp = requestTimeContext({ now: Date.parse('2026-10-17T00:00:00Z'), timeZone: 'UTC' });
  const metadata = '\nMetadata: ' + JSON.stringify({ retrieved_at: '2026-10-17T00:00:00.000Z', text_kind: 'full' });
  const block = web(body).replace('\nTitle: Docs', '\nTitle: Docs' + metadata);
  const entries = [user('First', block + timestamp), user('Second', block + timestamp)];
  assert.equal(rebuildEntryMessages(entries)[0].content, entries[0].contextText);
  assert.equal(rebuildEntryMessages(entries)[1].content, 'Second' + timestamp);
  const altered = block.replace(body, body + ' altered');
  assert.equal(rebuildEntryMessages([entries[0], user('Changed', altered + timestamp)])[1].content, 'Changed' + altered + timestamp);
});

test('request context markers inside retrieved text remain part of its verified body', () => {
  const body = 'Documentation example:\n\n[Request context]\n{"illustration":true}', timestamp = requestTimeContext({ now: 0, timeZone: 'UTC' });
  const entries = [user('First', web(body) + timestamp), user('Second', web(body) + timestamp)];
  assert.equal(rebuildEntryMessages(entries)[0].content, entries[0].contextText);
  assert.equal(rebuildEntryMessages(entries)[1].content, 'Second' + timestamp);
});

test('mixed URL markers independently retain their literal form or expand to a URL during rebuilding', () => {
  const reference = library('2601.12345', 'LIBRARY BODY'), body = 'WEB BODY';
  const urls = ['https://example.com/docs', 'https://arxiv.org/abs/2601.12345'];
  const raw = 'Compare @[' + urls[0] + '] and @[' + urls[1] + '] please.';
  for (const expandFirst of [false, true]) for (const expandSecond of [false, true]) {
    const prefix = 'Compare ' + (expandFirst ? urls[0] : '@[' + urls[0] + ']') + ' and ' + (expandSecond ? urls[1] : '@[' + urls[1] + ']') + ' please.';
    const firstTime = requestTimeContext({ now: 0, timeZone: 'UTC' }), secondTime = requestTimeContext({ now: 1, timeZone: 'UTC' });
    const entries = [user('Previous', '\n\n' + reference + web(body) + firstTime, reference), { label: '你', raw, references: reference, contextText: prefix + '\n\n' + reference + web(body) + secondTime }];
    const before = structuredClone(entries), messages = rebuildEntryMessages(entries);
    assert.equal(messages[0].content, entries[0].contextText);
    assert.equal(messages[1].content, prefix + secondTime);
    assert.deepEqual(entries, before);
    assert.equal(rebuildEntryMessages(entries.slice(1))[0].content, entries[1].contextText);
  }
});

test('URL-prefix matching still requires all ordinary user text to match exactly', () => {
  const body = 'WEB BODY', raw = 'Read @[https://example.com/docs] now.';
  const changed = { label: '你', raw, contextText: 'Read https://example.com/docs later.' + web(body) };
  const result = rebuildEntryMessages([user('Known', web(body)), changed]);
  assert.equal(result[1].content, changed.contextText);
});

test('short web metadata receipts survive full-body deduplication in each original turn', () => {
  const body = 'WEB BODY', reference = library('2601.12345', 'LIBRARY BODY');
  const receipt = second => '\n\n[Web reference metadata]\n' + JSON.stringify({ url: 'https://example.com/docs', hash: hash(body), retrieved_at: new Date(second).toISOString(), text_kind: 'content', date: null });
  const firstTime = requestTimeContext({ now: 0, timeZone: 'UTC' }), secondTime = requestTimeContext({ now: 1, timeZone: 'UTC' });
  const entries = [user('First', '\n\n' + reference + web(body) + receipt(0) + firstTime, reference), user('Second', '\n\n' + reference + web(body) + receipt(1) + secondTime, reference)];
  const messages = rebuildEntryMessages(entries);
  assert.equal(messages[0].content, entries[0].contextText);
  assert.equal(messages[1].content, 'Second' + receipt(1) + secondTime);
  assert.equal(messages.map(message => message.content).join('').split(body).length - 1, 1);
  assert.equal(messages.map(message => message.content).join('').split('[Web reference metadata]').length - 1, 2);
  assert.equal(rebuildEntryMessages(entries.slice(1))[0].content, entries[1].contextText);
  const withoutBody = user('Third', '\n\n' + reference + receipt(2) + secondTime, reference);
  assert.equal(rebuildEntryMessages([...entries, withoutBody])[2].content, 'Third' + receipt(2) + secondTime);
});

test('metadata receipt markers inside source content remain part of the verified source body', () => {
  const body = 'Example:\n\n[Web reference metadata]\n{"hash":"not a receipt"}', timestamp = requestTimeContext({ now: 0, timeZone: 'UTC' });
  const entries = [user('First', web(body) + timestamp), user('Second', web(body) + timestamp)];
  assert.equal(rebuildEntryMessages(entries)[0].content, entries[0].contextText);
  assert.equal(rebuildEntryMessages(entries)[1].content, 'Second' + timestamp);
});
