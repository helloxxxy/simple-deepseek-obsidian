const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webTools, WebReferences, extractWebMentions, referenceMarker, publicWebUrl, contentHash, MAX_RESPONSE_BYTES, MAX_CACHED_RESPONSES } = require('./src/web');
const bytes = value => Buffer.from(JSON.stringify(value));
const retrievedAt = '2026-10-17T14:14:10.932Z';
const make = options => new WebReferences({ key: 'sk-test-key', now: () => Date.parse(retrievedAt), ...options });

test('web schemas describe optional search parameters and require only public URL for fetch', () => {
  assert.deepEqual(webTools.map(tool => tool.function.name), ['search_web', 'fetch_page']);
  assert.deepEqual(webTools[0].function.parameters.required, ['query']);
  assert.equal(webTools[0].function.parameters.properties.count.maximum, 50);
  assert.equal(webTools[1].function.parameters.additionalProperties, false);
});
test('web mentions are explicit, unique, canonicalized and do not consume local library citations', () => {
  assert.deepEqual(extractWebMentions('https://example.com/plain @[2601.12345] @[https://example.com/a#x] @[https://example.com/a]'), ['https://example.com/a']);
  assert.deepEqual(extractWebMentions('@[https://[2001:4860:4860::8888]/doc]'), ['https://[2001:4860:4860::8888]/doc']);
  assert.throws(() => extractWebMentions('@[http://localhost:8888/lab]'), /私网/);
});
test('web URL validation blocks private, local, credential and disguised IP forms before any request', async () => {
  const invalid = ['file:///C:/secret', 'https://me:pass@example.com/', 'http://localhost/', 'http://localHOST./', 'http://printer/', 'http://docs.local/', 'http://team.internal/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.10.1/', 'http://169.254.169.254/', 'http://100.64.0.1/', 'http://127.1/', 'http://0x7f000001/', 'http://2130706433/', 'http://[::1]/', 'http://[::]/', 'http://[fc00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'https://example.com\\@localhost/', 'https://example.com/\nsecret', 'https://example.com/' + 'x'.repeat(8192), 'https://example.com/?access_token=private', 'https://example.com/?apiKey=private', 'https://example.com/?X-Amz-Signature=private'];
  const web = make({ http: () => assert.fail('blocked URL reached network') });
  for (const url of invalid) await assert.rejects(web.execute('fetch_page', { url }), /网址/);
  for (const url of ['https://example.com/a?q=1', 'http://8.8.8.8/', 'https://[2001:4860:4860::8888]/', 'https://[::ffff:8.8.8.8]/']) assert.ok(publicWebUrl(url));
});
test('web search validates official query, count and boolean bounds without paid requests', async () => {
  const web = make({ http: () => assert.fail('invalid query reached network') });
  for (const args of [{ query: '' }, { query: '  ' }, { query: 'x'.repeat(129) }, { query: 'x', count: 0 }, { query: 'x', count: 51 }, { query: 'x', count: 1.2 }, { query: 'x', need_content: 'false' }, 'broken', []]) await assert.rejects(web.execute('search_web', args));
  await assert.rejects(web.execute('other_tool', { query: 'x' }), /未知/);
});
test('web search sends only to DeepSeek with the shared key and passes selected text as tool reference', async () => {
  const calls = [], references = [], statuses = [], selections = [];
  const web = make({
    http: async (url, options) => { calls.push({ url, options }); return bytes({ results: [{ url: 'https://example.com/a', title: 'Article', summary: 'Summary', content: 'Original article' }] }); },
    onStatus: status => statuses.push(status), onReference: ref => references.push(ref),
    selectText: async (text, title) => { selections.push({ text, title }); return 'Selected article'; }
  });
  const output = JSON.parse(await web.execute('search_web', { query: '文'.repeat(128), count: 2, need_content: true, localization: 'private' }));
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
  const { options } = calls[0];
  assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, 'Bearer sk-test-key');
  assert.equal(options.maxBytes, MAX_RESPONSE_BYTES); assert.ok(options.timeoutMs > 0 && options.idleTimeoutMs > 0);
  assert.deepEqual(JSON.parse(options.body), { query: '文'.repeat(128), count: 2, need_content: true });
  assert.deepEqual(selections, [{ text: 'Original article', title: 'Article' }]);
  assert.equal(output.results[0].content, 'Selected article'); assert.equal(output.results[0].hash, contentHash('Selected article'));
  assert.deepEqual(references, [{ url: 'https://example.com/a', title: 'Article', retrieved_at: retrievedAt, text_kind: 'content', content: 'Selected article', hash: contentHash('Selected article'), kind: 'web_search' }]);
  assert.deepEqual(statuses, ['正在搜索网页…']); assert.ok(!JSON.stringify(output).includes('sk-test-key'));
});
test('web fetch uses only DeepSeek POST and preserves URL source metadata', async () => {
  let call;
  const web = make({ http: async (url, options) => { call = { url, options }; return bytes({ title: 'Page', content: '# Body' }); } });
  const result = JSON.parse(await web.execute('fetch_page', JSON.stringify({ url: 'https://example.com/doc#section' })));
  assert.equal(call.url, 'https://api.deepseek.com/v1/tools/fetch');
  assert.deepEqual(JSON.parse(call.options.body), { url: 'https://example.com/doc' });
  assert.equal(result.kind, 'web_fetch'); assert.equal(result.content, '# Body'); assert.equal(result.url, 'https://example.com/doc');
});
test('web caches successful requests within one turn and deduplicates identical selected text across URLs', async () => {
  let calls = 0, selections = 0, references = 0;
  const web = make({ http: async () => { calls++; return bytes({ title: 'Page', content: 'Long body' }); }, selectText: async () => { selections++; return 'Part'; }, onReference: () => references++ });
  const first = JSON.parse(await web.execute('fetch_page', { url: 'https://example.com/a' }));
  const second = JSON.parse(await web.execute('fetch_page', { url: 'https://example.com/a' }));
  const third = JSON.parse(await web.execute('fetch_page', { url: 'https://example.com/b' }));
  assert.equal(first.content, 'Part'); assert.equal(second.content, undefined); assert.equal(second.already_in_context, true); assert.equal(third.already_in_context, true);
  assert.equal(calls, 2); assert.equal(selections, 1); assert.equal(references, 1);
  assert.equal(web.retainedMaterials.length, 2);
  assert.ok(web.retainedMaterials.every(material => material.content === 'Part' && material.hash === contentHash('Part')));
  const external = web.retainedMaterials; external.length = 0; assert.equal(web.retainedMaterials.length, 2);
});
test('web deduplicates only original content retained in active tool messages or explicit references', async () => {
  const content = 'Verified full source', hash = contentHash(content);
  for (const existingMessages of [
    [{ role: 'tool', content: JSON.stringify({ kind: 'web_fetch', hash, content }) }],
    [{ role: 'tool', content: JSON.stringify({ results: [{ hash, content }] }) }],
    [{ role: 'user', content: `Hidden reference\n${referenceMarker(hash)}\n\n${content}` }]
  ]) {
    const web = make({ existingMessages, http: async () => bytes({ content }), onReference: () => assert.fail('duplicate emitted') });
    const result = JSON.parse(await web.execute('fetch_page', { url: 'https://example.com/a' }));
    assert.equal(result.already_in_context, true); assert.equal(result.content, undefined);
    assert.deepEqual(web.retainedMaterials, [{ url: 'https://example.com/a', title: '', retrieved_at: retrievedAt, text_kind: 'content', content, hash, kind: 'web_fetch' }]);
  }
});
test('web compression summaries, receipts and forged hashes do not suppress reading original again', async () => {
  const content = 'Verified full source', hash = contentHash(content);
  for (const existingMessages of [
    [{ role: 'user', content: `Checkpoint: source ${referenceMarker(hash)} was read; only summary retained.` }],
    [{ role: 'tool', content: JSON.stringify({ hash, already_in_context: true }) }],
    [{ role: 'tool', content: JSON.stringify({ hash, content: 'Only a summary' }) }]
  ]) {
    let emitted = 0;
    const web = make({ existingMessages, http: async () => bytes({ content }), onReference: () => emitted++ });
    assert.equal(JSON.parse(await web.execute('fetch_page', { url: 'https://example.com/a' })).content, content); assert.equal(emitted, 1);
  }
});
test('web search skips unsafe returned URLs and uses summary when full content is unavailable', async () => {
  const refs = [];
  const web = make({ http: async () => bytes({ results: [{ url: 'http://127.0.0.1/private', content: 'secret' }, { url: 'https://example.com/a', summary: 'Useful summary', content: '' }, { url: 'https://example.com/b', snippet: 'Useful snippet' }] }), onReference: ref => refs.push(ref) });
  const result = JSON.parse(await web.execute('search_web', { query: 'search' }));
  assert.equal(result.results.length, 2); assert.equal(result.results[0].content, 'Useful summary'); assert.equal(result.results[1].content, 'Useful snippet'); assert.equal(refs.length, 2);
  assert.equal(result.results[0].text_kind, 'summary'); assert.equal(result.results[1].text_kind, 'snippet');
});
test('web leaves an empty successful fetch uncited and handles malformed responses', async () => {
  const empty = make({ http: async () => bytes({ title: '', content: '' }), onReference: () => assert.fail('empty content emitted') });
  assert.equal(JSON.parse(await empty.execute('fetch_page', { url: 'https://example.com/' })).content, undefined);
  for (const payload of ['bad JSON', '[]', '{"error":{"message":"denied"}}', '{"content":3}']) {
    const web = make({ http: async () => Buffer.from(payload) });
    await assert.rejects(web.execute('fetch_page', { url: 'https://example.com/' }), /返回格式异常/);
  }
  await assert.rejects(make({ http: async () => bytes({ results: {} }) }).execute('search_web', { query: 'x' }), /返回格式异常/);
});
test('web service failures are not cached and only HTTP 401 is marked as DeepSeek key expiry', async () => {
  for (const status of [401, 402, 429]) {
    let calls = 0;
    const web = make({ http: async () => { calls++; if (calls === 1) throw Object.assign(new Error('Failure'), { httpStatus: status }); return bytes({ content: 'Recovered' }); } });
    await assert.rejects(web.execute('fetch_page', { url: 'https://example.com/' }), error => { assert.equal(!!error.authExpired, status === 401); if (status === 401) assert.equal(error.authService, 'deepseek'); return true; });
    assert.equal(JSON.parse(await web.execute('fetch_page', { url: 'https://example.com/' })).content, 'Recovered'); assert.equal(calls, 2);
  }
});
test('web cancellation before request, after response and during selection never emits a reference', async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(make({ signal: before.signal, http: () => assert.fail('aborted request') }).execute('fetch_page', { url: 'https://example.com/' }), { name: 'AbortError' });
  const during = new AbortController();
  await assert.rejects(make({ signal: during.signal, http: async () => { during.abort(); return bytes({ content: 'Text' }); }, onReference: () => assert.fail('aborted reference') }).execute('fetch_page', { url: 'https://example.com/' }), { name: 'AbortError' });
  const selection = new AbortController();
  await assert.rejects(make({ signal: selection.signal, http: async () => bytes({ content: 'Text' }), selectText: async text => { selection.abort(); return text; }, onReference: () => assert.fail('aborted reference') }).execute('fetch_page', { url: 'https://example.com/' }), { name: 'AbortError' });
});
test('web filters embedded image data and long base64 from text, summaries and titles before hashing or archival callbacks', async () => {
  const binary = 'A'.repeat(420), image = 'data:image/png;base64,aGVsbG8=';
  const refs = [];
  const web = make({ http: async () => bytes({ results: [{ url: 'https://example.com/a', title: image, summary: `Summary ${binary}`, content: `![plot](${image})\n${binary}\nUseful text` }, { url: 'https://example.com/b', snippet: `Snippet ${image}`, content: '' }] }), onReference: ref => refs.push(ref) });
  const result = JSON.parse(await web.execute('search_web', { query: 'x', need_content: true }));
  assert.ok(!JSON.stringify(result).includes(image)); assert.ok(!JSON.stringify(result).includes(binary));
  assert.match(result.results[0].content, /Useful text/); assert.match(result.results[1].content, /image data omitted/);
  assert.equal(result.results[0].hash, contentHash(result.results[0].content));
  assert.ok(!JSON.stringify(refs).includes(image)); assert.ok(!JSON.stringify(refs).includes(binary));
});
test('web local status and error text is translated for English interface without translating source text', async () => {
  const { translate, translateNotebookEvent } = require('./src/i18n');
  const statuses = [], web = make({ http: async () => bytes({ content: '网页原文保持原样' }), onStatus: status => statuses.push(translate(status, 'en')) });
  assert.equal(JSON.parse(await web.execute('fetch_page', { url: 'https://example.com/' })).content, '网页原文保持原样');
  assert.deepEqual(statuses, ['Reading web page…']);
  for (const text of ['本地或私网网址不能发送给网页工具。', '包含凭据或访问令牌的网址不能发送给网页工具。', '网页工具参数必须是有效的 JSON。', 'DeepSeek 网页工具返回格式异常。', '工具定义格式异常', '工具调用响应不完整或格式异常，未执行任何工具', 'JSON 输出格式设置异常', '代码输出已截断，正在以更小批次继续…', 'Notebook 修改尚未完整收齐，未提供应用操作；请继续生成', 'Notebook 源码分块顺序或元数据不一致', 'replace_text 的 oldText 必须在目标单元格中恰好匹配一次', '已检索网页', '模型返回了文字形式的工具请求，正在纠正调用方式…', '模型未能通过原生工具通道发起请求；这段工具指令未执行，请重试']) {
    assert.doesNotMatch(translate(text, 'en'), /[\u3400-\u9fff]/);
    assert.equal(translate(text, 'zh'), text);
  }
  const event = '**AI 修改已通过 RTC 同步**\n\n1. 替换单元格 cell-a 中的文本（12 → 13 字符）\n2. 收集源码分块 1/3\nNotebook 哈希：abcd';
  assert.doesNotMatch(translateNotebookEvent(event, 'en'), /[\u3400-\u9fff]/);
  assert.equal(translateNotebookEvent(event, 'zh'), event);
});
test('web retains a duplicate reference for archival and can reattach it after compaction removes the original', async () => {
  const content = 'The original page text', hash = contentHash(content);
  const existingMessages = [{ role: 'user', content: `${referenceMarker(hash)}\n${content}` }];
  const web = make({ existingMessages, http: async () => bytes({ content }), selectText: () => assert.fail('duplicate range selection') });
  assert.equal(JSON.parse(await web.execute('fetch_page', { url: 'https://example.com/page' })).already_in_context, true);
  existingMessages.splice(0, existingMessages.length, { role: 'user', content: `Checkpoint: page ${hash} was consulted.` });
  const retained = web.retainedMaterials[0];
  const { hasOriginal } = require('./src/web');
  assert.equal(hasOriginal(existingMessages, retained.content, retained.hash), false);
  assert.equal(retained.content, content);
});
test('web bounds its raw response cache and returns summary text only once', async () => {
  const web = make({ http: async () => bytes({ results: [{ url: 'https://example.com/page', summary: 'Useful summary', content: '' }] }) });
  let first;
  for (let i = 0; i < MAX_CACHED_RESPONSES + 3; i++) { const output = await web.execute('search_web', { query: `query ${i}` }); first ||= output; }
  assert.ok(web.responses.size <= MAX_CACHED_RESPONSES);
  assert.equal(first.split('Useful summary').length - 1, 1);
});
test('web cached fetch reattaches selected original after tool-loop compaction, without selecting again', async () => {
  let requests = 0, selections = 0;
  const existingMessages = [];
  const web = make({ existingMessages, http: async () => { requests++; return bytes({ content: 'Long source body' }); }, selectText: async () => { selections++; return 'Chosen source body'; } });
  const first = await web.execute('fetch_page', { url: 'https://example.com/page' });
  existingMessages.push({ role: 'tool', content: first });
  assert.equal(JSON.parse(await web.execute('fetch_page', { url: 'https://example.com/page' })).already_in_context, true);
  existingMessages.splice(0, existingMessages.length, { role: 'user', content: 'Checkpoint: source was read.' });
  const after = JSON.parse(await web.execute('fetch_page', { url: 'https://example.com/page' }));
  assert.equal(after.content, 'Chosen source body'); assert.equal(after.already_in_context, undefined);
  assert.equal(requests, 1); assert.equal(selections, 1);
});
test('web keeps actual retrieval completion time on cached results without replacing source publication time', async () => {
  let clock = Date.parse(retrievedAt), requests = 0;
  const publication = '2026-03-27T12:45:49-06:00';
  const web = make({ now: () => clock, http: async () => {
    requests++; clock += 1000;
    return bytes({ results: [{ url: 'https://example.com/page', content: 'Dated original', date: publication, retrieved_at: '2099-01-01T00:00:00Z' }] });
  } });
  const first = JSON.parse(await web.execute('search_web', { query: 'current information' }));
  clock += 3600000;
  const cached = JSON.parse(await web.execute('search_web', { query: 'current information' }));
  const completedAt = '2026-10-17T14:14:11.932Z';
  assert.equal(first.retrieved_at, completedAt); assert.equal(first.results[0].retrieved_at, completedAt);
  assert.equal(cached.retrieved_at, completedAt); assert.equal(cached.results[0].retrieved_at, completedAt);
  assert.equal(first.results[0].date, publication); assert.equal(cached.results[0].date, publication);
  assert.equal(web.retainedMaterials[0].retrieved_at, completedAt); assert.equal(web.retainedMaterials[0].date, publication);
  assert.equal(requests, 1);
});
test('web retains known source quality metadata and exactly one text field for content, summary or snippet', async () => {
  const refs = [];
  const web = make({ onReference: ref => refs.push(ref), http: async () => bytes({ results: [
    { url: 'https://example.com/body', title: 'Body', content: 'Full article', summary: 'Extra summary', snippet: 'Extra snippet', date: '2026-03-28T07:53:55-04:00', rerank_score: 2.4, authority: 3, site_name: 'Example News', unknown: 'not retained' },
    { url: 'https://example.com/summary', content: '', summary: 'Summary only', snippet: 'Extra short', date: null, authority: -1, site_name: null },
    { url: 'https://example.com/snippet', content: ' ', summary: ' ', snippet: 'Snippet only' },
    { url: 'https://example.com/empty', content: '', summary: '', snippet: '' }
  ] }) });
  const output = JSON.parse(await web.execute('search_web', { query: 'query', need_content: true }));
  const [body, summary, snippet, empty] = output.results;
  assert.equal(body.rerank_score, 2.4); assert.equal(body.authority, 3); assert.equal(body.site_name, 'Example News'); assert.equal(body.date, '2026-03-28T07:53:55-04:00');
  assert.deepEqual(output.results.map(page => page.text_kind), ['content', 'summary', 'snippet', 'none']);
  assert.equal(summary.date, null); assert.equal(summary.authority, -1); assert.equal(summary.site_name, null);
  assert.equal(snippet.content, 'Snippet only'); assert.equal(empty.content, undefined);
  assert.equal(JSON.stringify(output).includes('Extra summary'), false); assert.equal(JSON.stringify(output).includes('Extra short'), false);
  assert.equal(body.summary, undefined); assert.equal(body.snippet, undefined); assert.equal(body.unknown, undefined);
  assert.equal(refs.length, 3); assert.equal(refs[0].rerank_score, body.rerank_score); assert.equal(refs[1].text_kind, 'summary');
  assert.equal(web.retainedMaterials[0].site_name, 'Example News');
});
test('web drops invalid source metadata and filters binary payloads in retained known fields', async () => {
  const binary = 'A'.repeat(420), image = 'data:image/png;base64,aGVsbG8=';
  const refs = [], web = make({ onReference: ref => refs.push(ref), http: async () => bytes({ results: [
    { url: 'https://example.com/invalid', content: 'Original stays intact', date: image, rerank_score: 4, authority: 5, site_name: `Site ${image} ${binary}`, token: 'not retained', retrieved_at: '2099-01-01T00:00:00Z' },
    { url: 'https://example.com/types', content: 'More original', date: {}, rerank_score: '2.4', authority: 2.5, site_name: { nested: image } }
  ] }) });
  const result = JSON.parse(await web.execute('search_web', { query: 'x' }));
  for (const page of result.results) { assert.equal(page.date, undefined); assert.equal(page.rerank_score, undefined); assert.equal(page.authority, undefined); }
  assert.equal(result.results[0].content, 'Original stays intact'); assert.equal(result.results[0].retrieved_at, retrievedAt);
  for (const retained of [JSON.stringify(result), JSON.stringify(refs), JSON.stringify(web.retainedMaterials)]) {
    assert.equal(retained.includes(image), false); assert.equal(retained.includes(binary), false); assert.equal(retained.includes('not retained'), false);
  }
  assert.match(result.results[0].site_name, /image data omitted/); assert.equal(result.results[1].site_name, undefined);
});
