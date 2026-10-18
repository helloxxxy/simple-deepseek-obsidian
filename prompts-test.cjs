const test = require('node:test');
const assert = require('node:assert/strict');
const { REFERENCE_PROMPT, buildSystemPrompt, COMPRESSION_SYSTEM_PROMPT } = require('./src/prompts');
const context = require('./src/context');
const { NOTEBOOK_SYSTEM_PROMPT } = require('./src/notebook');

const webNames = /search_web|fetch_page/;
const notebookNames = /stage_notebook_edits|read_notebook|source_chunk|notebook-patch/;
const nativeChannel = /native tool-calling channel/;

test('default chat exposes only the available web tools and uses the native tool channel', () => {
  const prompt = buildSystemPrompt();
  assert.equal(prompt, context.SYSTEM_PROMPT);
  assert.ok(prompt.startsWith(REFERENCE_PROMPT));
  assert.match(prompt, /search_web/);
  assert.match(prompt, /fetch_page/);
  assert.match(prompt, nativeChannel);
  assert.doesNotMatch(prompt, notebookNames);
  assert.doesNotMatch(prompt, /<tool_call>|XML/);
});

test('disabled web chat contains no unavailable tool names or simulated call protocol', () => {
  const prompt = buildSystemPrompt({ webEnabled: false });
  assert.match(prompt, /Web search and page retrieval are unavailable/);
  assert.match(prompt, /state when current information cannot be verified/);
  assert.doesNotMatch(prompt, webNames);
  assert.doesNotMatch(prompt, notebookNames);
  assert.doesNotMatch(prompt, /native tool|tool_call|XML|JSON/);
});

test('Notebook-only requests include edit and read instructions without web tool names', () => {
  const prompt = buildSystemPrompt({ webEnabled: false, notebookMode: true, notebookEnabled: true });
  assert.match(prompt, /ordinary questions in Notebook mode/);
  for (const name of ['stage_notebook_edits', 'read_notebook', 'replace_text', 'source_chunk']) assert.ok(prompt.includes(name));
  assert.match(prompt, /await user confirmation/);
  assert.match(prompt, nativeChannel);
  assert.doesNotMatch(prompt, webNames);
  assert.doesNotMatch(prompt, /notebook-patch|<tool_call>/);
});

test('Notebook mode without an attachment gives no edit protocol or unavailable tool fallback', () => {
  for (const webEnabled of [false, true]) {
    const prompt = buildSystemPrompt({ webEnabled, notebookMode: true, notebookEnabled: false });
    assert.match(prompt, /ordinary questions in Notebook mode/);
    assert.doesNotMatch(prompt, notebookNames);
    assert.doesNotMatch(prompt, /baseHash|sourcePatch|Notebook delta|complete JSON batches/);
    if (!webEnabled) assert.doesNotMatch(prompt, /native tool|tool_call|XML|JSON/);
  }
});

test('available Notebook tools select their instructions independently of UI mode', () => {
  assert.match(buildSystemPrompt({ notebookEnabled: true }), /stage_notebook_edits/);
  assert.equal(NOTEBOOK_SYSTEM_PROMPT, buildSystemPrompt({ webEnabled: true, notebookMode: true, notebookEnabled: true }));
  assert.equal(buildSystemPrompt({ webEnabled: false }), buildSystemPrompt({ webEnabled: false }));
});

test('current request tool availability takes precedence over previous tool history', () => {
  for (const webEnabled of [false, true]) for (const notebookEnabled of [false, true]) for (const imagesEnabled of [false, true]) {
    const prompt = buildSystemPrompt({webEnabled,notebookEnabled,imagesEnabled});
    if (webEnabled || notebookEnabled || imagesEnabled) {
      assert.match(prompt, /Use only the tools provided for this request/);
      assert.match(prompt, /Tools used in earlier turns may be unavailable now/);
    } else assert.match(prompt, /No tools are available in this request\./);
    if (!notebookEnabled) assert.doesNotMatch(prompt, notebookNames);
    if (!imagesEnabled) assert.doesNotMatch(prompt, /read_image/);
    if (!webEnabled) assert.doesNotMatch(prompt, webNames);
  }
});

test('compression uses a neutral system while the replacement retains the dialog meter metadata', async () => {
  const systemPrompt = buildSystemPrompt({ notebookMode: true, notebookEnabled: true });
  const session = { messages: [{role:'user',content:'Verified source detail. '.repeat(1000)}], compactions: 0, cache: null };
  let sent;
  const result = await context.compactContext(session, 'fake-key', new AbortController().signal, () => {}, async (key, messages, signal, onText, http, options) => {
    sent = { messages, options };
    onText('The goal is to continue from verified details.');
    return {prompt_tokens:1000,completion_tokens:12,prompt_cache_hit_tokens:500,prompt_cache_miss_tokens:500};
  }, 0, true, systemPrompt, {}, 'deepseek-flash', false);
  assert.equal(sent.messages[0].content, systemPrompt);
  assert.equal(sent.messages.at(-2).role, 'system');
  assert.equal(sent.messages.at(-2).content, COMPRESSION_SYSTEM_PROMPT);
  assert.doesNotMatch(sent.messages.at(-2).content, webNames);
  assert.doesNotMatch(sent.messages.at(-2).content, notebookNames);
  assert.doesNotMatch(sent.messages.at(-2).content, /native tool|tool_call|XML|JSON/);
  assert.match(sent.messages.at(-2).content, /No tools are available/);
  assert.equal(sent.messages.at(-1).content, context.COMPRESSION_PROMPT);
  assert.equal(sent.options.tools, undefined);
  assert.ok(result.after < result.before);
  assert.equal(session.meter.systemPrompt, systemPrompt);
  assert.equal(session.meter.model, 'deepseek-flash');
  assert.equal(session.meter.includeReasoning, false);
  assert.equal(session.meter.tokens, context.estimateMessages([{role:'system',content:systemPrompt}, ...session.messages], {includeReasoning:false}));
  assert.equal(session.cache.measured, 1);
});

test('a textual tool request cannot replace the original conversation as a compression checkpoint',async()=>{
  const session={messages:[{role:'user',content:'Keep verified context. '.repeat(1000)}],compactions:0};const original=JSON.stringify(session.messages);
  await assert.rejects(context.compactContext(session,'fake',new AbortController().signal,()=>{},async(k,m,s,d)=>{d('<tool_call>{"name":"search_web","arguments":{}}</tool_call>');return{prompt_tokens:1000,completion_tokens:15,prompt_cache_hit_tokens:500,prompt_cache_miss_tokens:500};},0,true),/原上下文已保留/);
  assert.equal(JSON.stringify(session.messages),original);assert.equal(session.compactions,0);assert.equal(session.cache.measured,1);
});

test('request-time guidance is fixed while freshness remains tied to source evidence',()=>{
  for(const webEnabled of [false,true]){
    const prompt=buildSystemPrompt({webEnabled});assert.match(prompt,/latest \[Request context\]/);assert.match(prompt,/relative dates/);assert.doesNotMatch(prompt,/2026-\d\d-\d\d/);
    if(webEnabled){assert.match(prompt,/retrieval time, not the content update time/);assert.match(prompt,/fresh retrieval can return old content/);assert.match(prompt,/target entity or location/);}
  }
});

test('image rereading is advertised only when image references are available',()=>{
  for (const webEnabled of [false,true]) for (const notebookEnabled of [false,true]) {
    const without = buildSystemPrompt({webEnabled,notebookEnabled});
    assert.doesNotMatch(without,/read_image|image IDs|optional region/);
    const withImages = buildSystemPrompt({webEnabled,notebookEnabled,imagesEnabled:true});
    assert.match(withImages,/read_image/); assert.match(withImages,nativeChannel);
    assert.match(withImages,/specific question only when/); assert.match(withImages,/session memory and may expire/);
    assert.match(withImages,/ask the user to reattach/); assert.match(withImages,/coordinates normalized to the original/);
    if (!webEnabled) assert.doesNotMatch(withImages,webNames);
    if (!notebookEnabled) assert.doesNotMatch(withImages,notebookNames);
  }
});

test('compression preserves image references and uncertainty without advertising a tool',()=>{
  assert.match(context.COMPRESSION_PROMPT,/Preserve image IDs, established visual findings, uncertainty/);
  assert.match(context.COMPRESSION_PROMPT,/whether originals remain available/);
  assert.doesNotMatch(COMPRESSION_SYSTEM_PROMPT,/read_image/);
});

test('Notebook editing prompts use resumable small chunks for both insertions and rewrites',()=>{
  const prompt=buildSystemPrompt({webEnabled:false,notebookEnabled:true});
  for(const term of ['recommendedBatchTokens','insert_cell or set_source','final:true','pendingSource','sourceRange','nextPart']) assert.ok(prompt.includes(term),term);
  assert.match(prompt,/never repeat accepted parts or repair truncated JSON/);
  assert.match(context.COMPRESSION_PROMPT,/taskId, revision, recommendedBatchTokens/);
  assert.match(context.COMPRESSION_PROMPT,/chunkId, nextPart, totalParts or open-ended status/);
  assert.match(context.COMPRESSION_PROMPT,/accepted unfinished source can be read with pendingSource/);
  assert.doesNotMatch(buildSystemPrompt({webEnabled:false}),/pendingSource|sourceRange|recommendedBatchTokens/);
});
