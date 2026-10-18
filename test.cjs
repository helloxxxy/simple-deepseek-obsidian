const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { zipSync, strToU8 } = require('fflate');
const { PDFDocument } = require('pdf-lib');
const core = require('./src/core');
const event = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`;
const stopEvent = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
const signal = () => new AbortController().signal;
test('native image recognition sends image bytes only in the one vision request and returns text',async()=>{
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  const file={name:'figure.png',size:bytes.length,arrayBuffer:async()=>bytes};let request;
  const result=await core.describeImage(file,'fake',signal(),()=>{},async(key,messages,_signal,onText,_http,options)=>{request={key,messages,options};onText('Panel A: energy decreases.');return{completion_tokens:8};},{decodeDimensions:async()=>({width:640,height:480})});
  assert.equal(result,'Panel A: energy decreases.');assert.equal(request.options.model,'deepseek-flash');
  assert.equal(request.messages[0].content[1].type,'image_url');
  assert.match(request.messages[0].content[1].image_url.url,/^data:image\/png;base64,/);
  assert.ok(!result.includes('base64'));
  await assert.rejects(core.describeImage({...file,size:32*1024*1024+1},'fake',signal()),/32 MiB/);
});
test('SSE: Chinese UTF-8 split byte by byte, comments, CRLF and DONE', () => {
  let output = ''; const parser = core.sseParser(s => output += s);
  const input = Buffer.from(': heartbeat\r\n\r\n' + event('# 你好🌱\n') + event('**世界**') + stopEvent + 'data: [DONE]\r\n\r\n');
  for (const byte of input) parser.push(Buffer.from([byte]));
  parser.end(); assert.equal(output, '# 你好🌱\n**世界**');
});
test('SSE: trailing event without newline and finish reason', () => {
  const parser = core.sseParser(() => {});
  parser.push(Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'));
  parser.end();
});
test('SSE: disconnect, malformed data, server error, length limit fail visibly', () => {
  let p = core.sseParser(() => {}); p.push(Buffer.from(event('partial'))); assert.throws(() => p.end(), /中断/);
  p = core.sseParser(() => {}); assert.throws(() => p.push(Buffer.from('data: oops\n\n')), /格式/);
  p = core.sseParser(() => {}); assert.throws(() => p.push(Buffer.from('data: {"error":{"message":"secret"}}\n\n')), /DeepSeek/);
  p = core.sseParser(() => {}); p.push(Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n')); assert.throws(() => p.end(), /长度/);
});
test('chat uses official endpoint, streaming and max thinking', async () => {
  let output = '';
  await core.chat('fake-key', [{role:'user', content:'hi'}], signal(), s => output += s, async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer fake-key');
    const body = JSON.parse(options.body); assert.equal(body.stream, true); assert.equal(body.thinking.type, 'enabled'); assert.equal(body.reasoning_effort, 'low');
    options.onChunk(Buffer.from(event('hello') + stopEvent + 'data: [DONE]\n\n'));
  });
  assert.equal(output, 'hello');
  await core.chat('fake-key', [{role:'user',content:'hi'}], signal(), ()=>{}, async (url,options)=>{const body=JSON.parse(options.body);assert.equal(body.reasoning_effort,'low');options.onChunk(Buffer.from(stopEvent+'data: [DONE]\n\n'));},{reasoningEffort:'low'});
});
test('ZIP: extract nested full.md only; preserve markdown and HTML as text', () => {
  const text = '# Title\n\n![x](images/1.png)\n<script>alert(1)</script>';
  const zip = zipSync({'doc/full.md': strToU8(text), 'doc/other.json': strToU8('{}'), 'doc/images/1.png': new Uint8Array(12)});
  assert.equal(core.markdownFromZip(zip), text);
});
test('ZIP: corrupt, missing, empty and ambiguous markdown rejected', () => {
  for (const zip of [new Uint8Array(8), zipSync({'a.txt':strToU8('x')}), zipSync({'full.md':strToU8(' ')}), zipSync({'full.md':strToU8('x'),'a/full.md':strToU8('y')})]) assert.throws(() => core.markdownFromZip(zip));
});
test('PDF text keeps long ordinary sequences while removing wrapped inline image data',() => {
  const text='Long sequence:\n'+'ACGT'.repeat(1200)+'\n\n'+('x'.repeat(5000))+'\n\n![figure](data:image/png;base64,'+('A'.repeat(76)+'\n').repeat(8)+'TQ==)\nKeep this paragraph.';
  const parsed=core.markdownFromZip(zipSync({'full.md':strToU8(text)}));
  assert.ok(parsed.includes('ACGT'.repeat(1200)));assert.ok(parsed.includes('x'.repeat(5000)));assert.ok(parsed.includes('Keep this paragraph.'));assert.ok(!parsed.includes('A'.repeat(76)));assert.ok(!parsed.includes('data:image/'));
});
test('ZIP: oversized Markdown rejected before decompression', () => {
  assert.throws(() => core.markdownFromZip(zipSync({'full.md': new Uint8Array(16*1024*1024+1)})), /16 MB/);
});
const file = { name: 'sample.png', size: 3, arrayBuffer: async () => Uint8Array.from([1,2,3]).buffer };
const pdfFile = { ...file, name: 'sample.pdf' };
const json = data => Buffer.from(JSON.stringify({code:0,data}));
test('MinerU full upload, polling, download: bearer never sent to storage', async () => {
  const calls = []; const progress = []; let polls = 0;
  const http = async (url, opts) => {
    calls.push(url);
    if (url.endsWith('file-urls/batch')) { assert.equal(JSON.parse(opts.body).model_version, 'vlm'); assert.equal(opts.headers.Authorization, 'Bearer fake'); return json({batch_id:'batch/1',file_urls:['https://storage.example/upload']}); }
    if (url.endsWith('/upload')) { assert.equal(opts.method,'PUT'); assert.equal(opts.headers,undefined); assert.deepEqual([...opts.body],[1,2,3]); return Buffer.alloc(0); }
    if (url.endsWith('batch%2F1')) { polls++; return json({extract_result:[polls === 1 ? {state:'running',extract_progress:{extracted_pages:1,total_pages:2}} : {state:'done',full_zip_url:'https://storage.example/result.zip'}]}); }
    assert.equal(opts.headers,undefined); return Buffer.from(zipSync({'full.md':strToU8('# 文本')}));
  };
  assert.equal(await core.parseFile(file,'fake',signal(), s=>progress.push(s),http,async()=>{}),'# 文本');
  assert.equal(calls.length,5); assert.ok(progress.some(p=>p.includes('1/2')));
});
test('MinerU validates unsupported, empty and oversized files before network', async () => {
  for (const bad of [{...file,name:'a.exe'},{...file,size:0},{...file,size:201*1024*1024}]) await assert.rejects(core.parseFile(bad,'fake',signal(),()=>{},()=>assert.fail('no network')));
});
test('MinerU batches split PDFs, uploads concurrently and merges out-of-order results by data id', async () => {
  const source = await PDFDocument.create();
  for (let index = 0; index < 201; index++) source.addPage([100, 100]);
  const sourceBytes = Buffer.from(await source.save());
  const pdf = {name:'long paper.pdf',size:sourceBytes.length,arrayBuffer:async()=>sourceBytes.buffer.slice(sourceBytes.byteOffset,sourceBytes.byteOffset+sourceBytes.byteLength)};
  const uploads = [], progress = [], waiting = []; let jobs = 0, names, dataIds;
  const http = async (url, options) => {
    if (url.endsWith('file-urls/batch')) {
      jobs++;
      const files = JSON.parse(options.body).files; names = files.map(file=>file.name); dataIds = files.map(file=>file.data_id);
      return json({batch_id:'batch/1',file_urls:['https://storage.example/upload/1','https://storage.example/upload/2']});
    }
    if (url.includes('/upload/')) {
      const index = Number(url.match(/(\d+)$/)[1]) - 1; uploads[index] = Buffer.from(options.body);
      if (uploads.filter(Boolean).length === 2) while (waiting.length) waiting.shift()();
      else await new Promise(resolve=>waiting.push(resolve));
      return Buffer.alloc(0);
    }
    if (url.includes('extract-results/batch/')) {
      return json({extract_result:[
        {data_id:dataIds[1],file_name:names[1],state:'done',full_zip_url:'https://storage.example/result/2.zip'},
        {data_id:dataIds[0],file_name:names[0],state:'done',full_zip_url:'https://storage.example/result/1.zip'}
      ]});
    }
    const job = Number(url.match(/(\d+)\.zip$/)[1]);
    return Buffer.from(zipSync({'full.md':strToU8('# 分块 '+job)}));
  };
  assert.equal(await core.parseFile(pdf,'fake',signal(),value=>progress.push(value),http,async()=>{}),'# 分块 1\n\n# 分块 2');
  assert.equal(jobs,1); assert.equal(uploads.length,2); assert.deepEqual(dataIds,['simple_deepseek_part_0001','simple_deepseek_part_0002']);
  assert.deepEqual(await Promise.all(uploads.map(async bytes=>(await PDFDocument.load(bytes)).getPageCount())),[200,1]);
  assert.match(names[0],/part-001\.pages-1-200\.pdf$/); assert.match(names[1],/part-002\.pages-201-201\.pdf$/);
  assert.ok(progress.some(value=>value.includes('并行上传 2 个'))); assert.ok(progress.some(value=>value.includes('汇总 2 部分')));
});
test('MinerU rejects unreadable PDFs before creating a cloud task', async () => {
  const bad = {name:'broken.pdf',size:4,arrayBuffer:async()=>Uint8Array.from([1,2,3,4]).buffer};
  await assert.rejects(core.parseFile(bad,'fake',signal(),()=>{},()=>assert.fail('no network')),/损坏|加密|密码/);
});
test('MinerU API key failure is sanitized', async () => {
  await assert.rejects(core.parseFile(file,'fake',signal(),()=>{},async()=>Buffer.from('{"code":"A0202","msg":"secret"}')), /密钥错误/);
});
test('auth: MinerU expiry and DeepSeek HTTP 401 carry service markers', async () => {
  await assert.rejects(core.parseFile(file,'fake',signal(),()=>{},async()=>Buffer.from('{"code":"A0211","msg":"secret"}')), error => error.authExpired === true && error.authService === 'mineru' && !error.message.includes('secret'));
  await assert.rejects(core.chat('fake',[],signal(),()=>{},async()=>{const error=Error('密钥无效或已过期（HTTP 401）');error.httpStatus=401;throw error;}), error => error.authExpired === true && error.authService === 'deepseek');
});
test('MinerU task failure and malformed result are surfaced', async () => {
  for (const state of ['failed','done']) {
    await assert.rejects(core.parseFile(file,'fake',signal(),()=>{},async(url)=> {
      if (url.endsWith('file-urls/batch')) return json({batch_id:'id',file_urls:['https://storage.example/upload']});
      if (url.endsWith('/upload')) return Buffer.alloc(0);
      return json({extract_result:[{state}]});
    }), state === 'failed' ? /解析失败/ : /结果包/);
  }
});
test('cancel stops polling without making later requests', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(core.parseFile(file,'fake',controller.signal,()=>{},async(url)=> {
    calls++;
    if (url.endsWith('file-urls/batch')) return json({batch_id:'id',file_urls:['https://storage.example/upload']});
    if (url.endsWith('/upload')) return Buffer.alloc(0);
    return json({extract_result:[{state:'pending'}]});
  }, async()=>{controller.abort();}), {name:'AbortError'});
  assert.equal(calls,3);
});
test('pause cancellation rejects promptly', async () => {
  const controller = new AbortController(); const waiting = core.pause(60000, controller.signal); controller.abort(); await assert.rejects(waiting,{name:'AbortError'});
});
function networkCore(respond) {
  const exports = {exports:{}};
  vm.runInNewContext(fs.readFileSync(__dirname+'/src/core.js','utf8'), {module:exports,require:name=>name==='https'?{request(url,opts,cb){const req = new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};req.end=()=>queueMicrotask(()=>respond(url,opts,cb,req));return req;}}:name.startsWith('./')?require('./src/'+name.slice(2)):require(name),Buffer,URL,setTimeout,clearTimeout});
  return exports.exports;
}
function response(status, headers = {}) { const res=new EventEmitter();res.statusCode=status;res.headers=headers;res.resume=()=>{};res.destroy=()=>{};return res; }
test('network: HTTP auth error never exposes response body', async()=> {
  const api=networkCore((url,opts,cb)=>{const res=response(401);cb(res);res.emit('end');});
  await assert.rejects(api.request('https://api.example',{signal:signal()}),/密钥无效/);
});
test('network: structured service errors are bounded and sanitized while keeping useful parameter details',async()=>{
  const api=networkCore((_url,_opts,callback)=>{const res=response(422);callback(res);res.emit('data',Buffer.from(JSON.stringify({error:{message:'Invalid max_tokens; Authorization: Bearer sk-private-key',type:'invalid_request_error',code:'invalid_parameters'}})));res.emit('end');});
  await assert.rejects(api.request('https://api.deepseek.com/chat/completions'),error=>error.httpStatus===422 && error.category==='parameters' && error.message.includes('max_tokens') && !error.message.includes('sk-private-key'));
});

test('network: a stalled error body ends promptly with its HTTP status and any complete details',async()=>{
  let destroyed=0;
  const api=networkCore((_url,_opts,callback,req)=>{
    const res=response(401);res.destroy=()=>destroyed++;req.destroy=()=>destroyed++;callback(res);
    res.emit('data',Buffer.from('{"error":{"message":"Invalid API key"}}'));
  });
  await assert.rejects(api.request('https://api.deepseek.com/chat/completions',{timeoutMs:0,errorBodyTimeoutMs:10}),error=>error.httpStatus===401 && error.message.includes('Invalid API key'));
  assert.equal(destroyed,2);
});

test('network: oversized error bodies fail without retaining or showing raw content',async()=>{
  const api=networkCore((_url,_opts,callback)=>{const res=response(503);callback(res);res.emit('data',Buffer.alloc(16*1024+1,120));res.emit('end');});
  await assert.rejects(api.request('https://api.deepseek.com/chat/completions'),error=>error.httpStatus===503 && error.retryable && error.message.length<700);
});
test('SSE distinguishes service interruptions and preserves their returned usage',async()=>{
  for(const reason of ['content_filter','insufficient_system_resource','aborted','tool_calls']){
    await assert.rejects(core.chat('test-key',[],signal(),()=>{},async(_url,opts)=>{
      opts.onChunk(Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:reason}],usage:{prompt_tokens:10,completion_tokens:2}})+'\n\ndata: [DONE]\n\n'));
    }),error=>error.finishReason===reason && error.usage.prompt_tokens===10 && error.incomplete===true);
  }
});

test('SSE marks only actual authentication failures and retains error-event usage',async()=>{
  for(const [detail,authExpired] of [
    [{code:402,type:'authentication_error',message:'Insufficient balance'},false],
    [{code:'file_expired'},false],
    [{code:'invalid_api_key'},true],
    [{code:401},true]
  ]) {
    await assert.rejects(core.chat('test-key',[],signal(),()=>{},async(_url,opts)=>{
      opts.onChunk(Buffer.from('data: '+JSON.stringify({error:detail,usage:{prompt_tokens:20,completion_tokens:3}})+'\n\n'));
    }),error=>!!error.authExpired===authExpired && error.usage.prompt_tokens===20);
  }
});
test('model list discovery uses a short bounded authenticated request',async()=>{
  const result=await core.listModels('fake-key',signal(),async(url,opts)=>{
    assert.equal(url,'https://api.deepseek.com/models');assert.equal(opts.headers.Authorization,'Bearer fake-key');assert.equal(opts.timeoutMs,5000);assert.equal(opts.maxBytes,1024*1024);
    return Buffer.from('{"data":[]}');
  });assert.deepEqual(result,{data:[]});
});
test('oversized image dimensions stop before the vision request is sent',async()=>{
  const bytes=Buffer.from([137,80,78,71,13,10,26,10]);
  await assert.rejects(core.describeImage({name:'image.png',size:bytes.length,arrayBuffer:async()=>bytes},'key',signal(),()=>{},async()=>assert.fail('no vision request'),{decodeDimensions:async()=>({width:8193,height:100})}),/8192/);
});
test('network: authorized redirects are refused', async()=> {
  const api=networkCore((url,opts,cb)=>cb(response(302,{location:'https://other.example'})));
  await assert.rejects(api.request('https://api.example',{headers:{Authorization:'Bearer fake'}}),/重定向/);
});
test('network: response size bounded, and abort cancels outstanding request', async()=> {
  const api=networkCore((url,opts,cb)=>{const res=response(200);cb(res);res.emit('data',Buffer.alloc(10));res.emit('end');});
  await assert.rejects(api.request('https://api.example',{maxBytes:4}),/上限/);
  const controller=new AbortController();const hanging=networkCore(()=>{}).request('https://api.example',{signal:controller.signal});controller.abort();await assert.rejects(hanging,{name:'AbortError'});
});
test('network: only HTTPS URLs accepted', async()=> {
  await assert.rejects(core.request('http://example.com'),/HTTPS/);
});
const { normalizeMath } = require('./src/markdown');
test('math: preserve inline versus display math and normalize LaTeX delimiters',()=>{
  assert.equal(normalizeMath('A $x^2$ B \\(y+1\\) C \\[z=2\\] D $$a=b$$'), 'A $x^2$ B $y+1$ C $$z=2$$ D $$a=b$$');
});
test('math: multiline LaTeX and table math preserve document structure',()=>{
  assert.equal(normalizeMath('\\[\n\\frac{a}{b}\n\\]'), '$$\\frac{a}{b}$$');
  assert.equal(normalizeMath('| $a$ | $b$ |'), '| $a$ | $b$ |');
});
test('math: display equations in a nested list are not mistaken for indented code',()=>{
  const source='  - Bottom labels  \n    \\[\n    \\beta_4,\\alpha_4\n    \\]\n    are boundary data.\n';
  assert.equal(normalizeMath(source),'  - Bottom labels  \n    $$\\beta_4,\\alpha_4$$\n    are boundary data.\n');
  const fenced='  - Example\n    ```tex\n    \\[x\\]\n    ```\n';
  assert.equal(normalizeMath(fenced),fenced);
  const code='- Example\n\n      \\[x\\]\n';
  assert.equal(normalizeMath(code),code);
  const standaloneCode='    - literal \\[x\\]\n';
  assert.equal(normalizeMath(standaloneCode),standaloneCode);
});
test('math: code fences, inline code and indented code remain unchanged',()=>{
  const source='`$code$` and ``$other$``\n```latex\n$x$\n```\n~~~\n\\(y\\)\n~~~\n    $z$\n';
  assert.equal(normalizeMath(source),source);
});
test('math: unfinished fences and incomplete streaming formulas remain unchanged',()=>{
  for(const s of ['```\n$x$','before $x','before $$x','before \\(x'])assert.equal(normalizeMath(s),s);
});
test('math: currency, escaped dollars and link destinations stay intact',()=>{
  for(const s of ['Costs $5 and $10.','Costs $5, then $20.','\\$5 and \\$10','[link](https://example.com/$x$)','![pic](images/$x$.png)'])assert.equal(normalizeMath(s),s);
});
test('math: normalization is idempotent with existing display math',()=>{
  const s='$$ x^2 $$ plus $y$ and \\(z\\)';const n=normalizeMath(s);assert.equal(normalizeMath(n),n);
});
const {ui}=require('./scripts/test-ui.cjs');
test('MinerU Markdown ZIP filters embedded image payloads while preserving text, math and relative image links',()=>{
  const line='A'.repeat(76),payload='data:image/png;base64,'+Array(12).fill(line).concat('TQ==').join('\n  ');
  const markdown='# Paper\n\n$x^2$ and \\[y=2\\]\n![figure](figures/plot.png)\n\n'+payload+'\n\nKeep this explanation.';
  const archive=Buffer.from(zipSync({'full.md':strToU8(markdown)})),before=Buffer.from(archive);
  const result=core.markdownFromZip(archive);
  assert.ok(!result.includes(line));assert.ok(!result.includes('TQ=='));assert.ok(!result.includes('data:image/'));
  assert.ok(result.includes('![figure](figures/plot.png)'));assert.ok(result.includes('$x^2$'));assert.ok(result.includes('Keep this explanation.'));
  assert.deepEqual(archive,before);
});

test('uploaded PDF text removes wrapped image payloads before selection, rendering and context archival',async()=>{
  const line='A'.repeat(76),payload='data:image/png;base64,'+Array(12).fill(line).concat('TQ==').join('\n  ');
  const extracted='# Paper\n\n$x^2$ and \\[y=2\\]\n![figure](figures/plot.png)\n\n'+payload+'\n\nKeep this explanation.';
  const original=Buffer.from('%PDF-source'),file={name:'paper.pdf',size:original.length,arrayBuffer:async()=>original};
  const env=ui(async()=>{},async()=>extracted);await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();env.plugin.keys.mineru='key';
  let selected='';view.selectTextRange=async text=>{selected=text;return text;};
  await view.upload(file);
  for(const text of [selected,...env.renders.map(render=>render.text),JSON.stringify(view.session),JSON.stringify([...env.conversationState.values()])]){assert.ok(!text.includes(line));assert.ok(!text.includes('TQ=='));assert.ok(!text.includes('data:image/'));}
  assert.ok(selected.includes('![figure](figures/plot.png)'));assert.ok(selected.includes('$x^2$'));assert.ok(selected.includes('Keep this explanation.'));
  assert.deepEqual(original,Buffer.from('%PDF-source'));assert.ok(extracted.includes(payload));
  assert.ok(view.session.messages[0].content.includes('Keep this explanation.'));await view.onClose();
});

test('UI: expired keys open each official API page once during the cooldown',async()=>{
  const expired=service=>{const error=Error(`${service} expired`);error.authExpired=true;error.authService=service;return error;};
  const env=ui(async()=>{throw expired('deepseek');},async()=>{throw expired('mineru');});const{plugin,opened}=env;await plugin.onload();const view=plugin.factory({});await view.onOpen();plugin.keys={deepseek:'fake',mineru:'fake'};
  view.input.value='one';await view.send();view.input.value='two';await view.send();await view.upload(pdfFile);await view.upload(pdfFile);
  assert.deepEqual(opened,['https://platform.deepseek.com/api_keys','https://mineru.net/apiManage']);await view.onClose();
});
test('clear button confirms system recycling and leaves the conversation intact on cancel',async()=>{
  const env=ui(async()=>{},async()=>{}, {confirm:()=>assert.fail('native confirmation must not open')});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  env.doc.hasFocus=()=>true;
  view.row('你','Keep this message');view.input.value='Keep this draft';
  const clear=[...env.doc.querySelectorAll('.sd-actions button')].find(button=>button.textContent==='清空');
  clear.focus();clear.click();let dialog=env.doc.querySelector('.sd-confirm');assert.ok(dialog);
  assert.match(dialog.textContent,/系统回收站/);assert.match(dialog.textContent,/恢复/);assert.equal(view.session.entries.length,1);
  dialog.querySelector('button').click();await Promise.resolve();
  assert.equal(view.session.entries.length,1);assert.equal(view.input.value,'Keep this draft');assert.equal(env.doc.activeElement,view.input);
  clear.click();dialog=env.doc.querySelector('.sd-confirm');dialog.querySelector('.mod-warning').click();await new Promise(setImmediate);
  assert.equal(view.session.entries.length,0);assert.equal(view.input.value,'');assert.equal(env.doc.activeElement,view.input);
  await view.onClose();
});
test('failed system recycling preserves the conversation, its name and the input draft',async()=>{
  const env=ui(async(_k,_m,_s,delta)=>delta('Answer'),async()=>{}, {trashConversation:async()=>{throw Error('trash unavailable');}});
  await env.plugin.onload();env.plugin.keys.deepseek='test-key';const view=env.plugin.factory({});await view.onOpen();
  view.input.value='Question';await view.send();const id=env.plugin.activeConversationId;
  env.plugin.conversationNames[id]='Keep this name';view.input.value='Draft';
  await view.clear();
  assert.equal(env.plugin.activeConversationId,id);assert.equal(view.session.entries.length,2);assert.equal(view.input.value,'Draft');
  assert.equal(env.plugin.conversationNames[id],'Keep this name');assert.equal(env.conversationState.get(id).name,'Keep this name');
  assert.match(view.status.textContent,/原会话已保留/);assert.equal(view.clearButton.disabled,false);await view.onClose();
});
test('recycled conversations include the latest content and name, and queued saves cannot recreate them',async()=>{
  const recycled=new Map(),records=new Map();
  const env=ui(async()=>{},async()=>{}, {conversationState:records,trashConversation:async id=>{recycled.set(id,structuredClone(records.get(id)));records.delete(id);return true;}});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  view.row('你','Latest unsaved text');const id=env.plugin.activeConversationId;env.plugin.conversationNames[id]='Recoverable title';
  const deleting=view.clear();const lateSave=env.plugin.saveSession();await deleting;await lateSave;await env.plugin.saveQueue;
  assert.equal(records.has(id),false);assert.equal(recycled.get(id).name,'Recoverable title');assert.equal(recycled.get(id).session.entries[0].raw,'Latest unsaved text');
  records.set(id,recycled.get(id));const restored=ui(async()=>{},async()=>{}, {conversationState:records});await restored.plugin.onload();
  assert.equal(restored.plugin.conversationNames[id],'Recoverable title');await view.onClose();
});
test('confirmation restores pending composer focus when the Obsidian window becomes active',async()=>{
  const env=ui(async()=>{},async()=>{});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  let foreground=false;env.doc.hasFocus=()=>foreground;
  const clear=[...env.doc.querySelectorAll('.sd-actions button')].find(button=>button.textContent==='清空');
  clear.focus();clear.click();env.doc.querySelector('.sd-confirm button').click();await Promise.resolve();
  assert.equal(view.pendingComposerFocus,true);
  foreground=true;env.dom.window.dispatchEvent(new env.dom.window.Event('focus'));
  assert.equal(view.pendingComposerFocus,false);assert.equal(env.doc.activeElement,view.input);
  await view.onClose();
});
test('Notebook UI starts local Jupyter, previews RTC cells and opens the exact notebook in default browser',async()=>{
  let started, connection, fake, stopped=0;
  class FakeRtcClient {
    constructor(options){connection=options;fake=this;}
    async connect(){return {cells:[{id:'cell-1',cell_type:'code',source:'print(1)',outputs:[]}]};}
    onChange(callback){this.change=callback;return()=>{};}
    close(){}
  }
  const executablePath='C:/test/Scripts/jupyter.exe', notebookFilePath='C:/test/notebooks/answer.ipynb';
  const keyState={deepseek:'',mineru:'',libraryPath:'',jupyterExecutablePath:executablePath,notebookFilePath};
  const env=ui(async()=>{},async()=>{}, {keyState,
    jupyterLocalApi:{startLocalJupyter:async options=>{started=options;return {baseUrl:'http://127.0.0.1:19002',token:'test-token',root:'C:/test/notebooks',name:'answer.ipynb',browserUrl:'http://127.0.0.1:19002/lab/tree/answer.ipynb?token=test-token',child:{pid:123}};},stopLocalJupyter:async()=>{stopped++;}} ,
    notebookApi:{...require('./src/notebook'),JupyterRtcClient:FakeRtcClient}});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;
  await view.connectNotebook();
  assert.equal(view.notebookPreview.open,false);
  view.notebookPreview.open=true;
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(started.executablePath,executablePath);assert.equal(started.notebookFilePath,notebookFilePath);
  assert.equal(connection.notebookPath,'answer.ipynb');assert.equal(env.keyState.jupyterRoot,'C:/test/notebooks');
  assert.deepEqual(env.opened,['http://127.0.0.1:19002/lab/tree/answer.ipynb?token=test-token']);
  assert.match(view.notebookPreview.textContent,/print\(1\)/);
  fake.change({cells:[{id:'cell-1',cell_type:'code',source:'print(2)',outputs:[{output_type:'display_data',data:{'text/plain':'2','image/png':'A'.repeat(500)}}]}]});
  await new Promise(resolve=>setTimeout(resolve,130));
  assert.match(view.notebookPreview.textContent,/print\(2\)/);assert.match(view.notebookPreview.textContent,/2/);assert.ok(!view.notebookPreview.textContent.includes('image/png'));
  view.toggleNotebookMode();await view.notebookShutdown;await env.plugin.saveQueue;
  assert.equal(stopped,1);assert.equal(env.plugin.jupyterUrl,'');assert.equal(view.notebookMode,false);
  await view.onClose();assert.equal(stopped,1);
});
test('Notebook run restores composer focus after disabling its clicked button',async()=>{
  const env=ui(async()=>{},async()=>{});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  const notebook={cells:[]};view.notebookClient={runAll:async()=>notebook,read:()=>notebook,close:()=>{}};
  env.doc.hasFocus=()=>true;view.runAllButton.focus();
  await view.runNotebookAll();
  assert.equal(env.doc.activeElement,view.input);
  await view.onClose();
});
test('completed chat restores the composer after sending from its button',async()=>{
  const env=ui(async(_key,_messages,_signal,onDelta)=>{onDelta('Hello');return{completion_tokens:2};},async()=>{});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();env.plugin.keys.deepseek='test-key';
  env.doc.hasFocus=()=>true;view.input.value='Question';view.sendButton.focus();
  await view.send();assert.equal(env.doc.activeElement,view.input);
  await view.onClose();
});
test('closing Notebook mode does not shut down a reused server with no owned child process',async()=>{
  class FakeRtcClient { async connect(){return{cells:[]};} onChange(){return()=>{};} close(){} }
  const env=ui(async()=>{},async()=>{}, {jupyterLocalApi:{startLocalJupyter:async()=>({baseUrl:'http://127.0.0.1:19003',token:'prior',root:'C:/work',name:'test.ipynb',browserUrl:'http://127.0.0.1:19003/lab/tree/test.ipynb?token=prior',reused:true}),stopLocalJupyter:async()=>assert.fail('must not stop a reused server')},notebookApi:{...require('./src/notebook'),JupyterRtcClient:FakeRtcClient}});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();env.plugin.jupyterExecutablePath='C:/python/Scripts/jupyter.exe';env.plugin.notebookFilePath='C:/work/test.ipynb';view.notebookMode=true;
  await view.connectNotebook();view.toggleNotebookMode();await view.notebookShutdown;
  assert.equal(env.plugin.jupyterUrl,'http://127.0.0.1:19003');await view.onClose();
});
test('Notebook UI accepts an alternate JSON patch without changing the original conversation',async()=>{
  const env=ui(async()=>{},async()=>{});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  const hash='b'.repeat(64), user=view.row('你','放在末尾cell');
  user.entry.contextText=`Add a cell at the end\n\n[Notebook delta; images removed locally]\n{"baseHash":null,"currentHash":"${hash}","changed":[],"removed":[]}`;
  user.entry.notebookAttached=true;
  const raw='```json\n{"baseHash":null,"operations":[{"op":"insert_cell","index":1,"cellType":"code","source":"print(42)"}]}\n```';
  const reply=view.row('deepseek-flash',raw);view.addPatchAction(reply);
  assert.equal(reply.entry.raw,raw);assert.equal(reply.patchButton?.textContent,'检查并应用 Notebook 修改');
  await view.onClose();
});
test('Notebook edit confirmation uses the selected English interface language',async()=>{
  const env=ui(async()=>{},async()=>{}, {saved:{uiLanguage:'en'}});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  const notebook={cells:[]};let applied=0;
  view.notebookClient={read:()=>notebook,applyPatch:async()=>{applied++;return notebook;},close(){}};
  env.doc.hasFocus=()=>true;
  const hash=require('./src/notebook').notebookHash(notebook),user=view.row('你','Add a cell');
  user.entry.contextText=`[Notebook delta]\n{"currentHash":"${hash}"}`;user.entry.notebookAttached=true;
  const reply=view.row('deepseek-flash','```notebook-patch\n{"baseHash":null,"operations":[{"type":"insert_cell","index":0,"cellType":"code","source":"print(42)"}]}\n```');
  view.addPatchAction(reply);reply.patchButton.focus();reply.patchButton.click();
  let dialog=env.doc.querySelector('.sd-confirm');assert.ok(dialog);
  assert.match(dialog.textContent,/Apply these edits through RTC:/);
  assert.match(dialog.textContent,/Insert a code cell at index 0 \(9 characters\)/);
  assert.match(dialog.textContent,/After confirmation, Jupyter will update in real time\./);
  assert.doesNotMatch(dialog.textContent,/[\u4e00-\u9fff]/);
  dialog.querySelector('button').click();await new Promise(setImmediate);assert.equal(applied,0);assert.equal(env.doc.activeElement,view.input);
  reply.patchButton.click();dialog=env.doc.querySelector('.sd-confirm');assert.ok(dialog);
  dialog.querySelector('.mod-cta').click();await new Promise(setImmediate);
  assert.equal(applied,1);assert.equal(env.doc.querySelector('.sd-confirm'),null);assert.equal(env.doc.activeElement,view.input);
  await view.onClose();
});
test('English Notebook events translate stored operation labels without changing archived text or cell output',async()=>{
  const env=ui(async()=>{},async()=>{}, {saved:{uiLanguage:'en'}});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  const raw='**AI 修改已通过 RTC 同步**\n\n1. 在 17 插入 markdown 单元格（272 字符）\n2. 修改单元格 中文-id（12 字符）\n\nNotebook 哈希：abc123';
  const entry={label:'Notebook 操作',raw,notebookEvent:true};view.session.entries.push(entry);
  const state=view.row(entry.label,raw,entry);await view.render(state);
  assert.match(state.body.textContent,/Insert a markdown cell at index 17 \(272 characters\)/);
  assert.match(state.body.textContent,/Update cell 中文-id \(12 characters\)/);
  assert.match(state.body.textContent,/Notebook hash: abc123/);
  assert.equal(entry.raw,raw);
  view.logNotebookEvent('运行单元格 1','[{"text":"中文输出"}]');await new Promise(setImmediate);
  const output=[...view.rows].at(-1);assert.match(output.body.textContent,/Ran cell 1/);assert.match(output.body.textContent,/中文输出/);
  env.plugin.uiLanguage='zh';view.refreshLanguage();await new Promise(setImmediate);
  assert.match(state.body.textContent,/在 17 插入 markdown 单元格/);
  assert.equal(entry.raw,raw);
  await view.onClose();
});
test('Notebook pending delta count resets after compression and clearing a conversation',async()=>{
  const notebookApi=require('./src/notebook');
  const notebook={cells:[{id:'one',cell_type:'code',source:'print(42)',outputs:[]}]};
  const env=ui(async(_k,_m,_s,delta)=>{delta('short summary');return{completion_tokens:2};},async()=>{});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  view.notebookClient={read:()=>notebook,close(){}};view.notebookMode=true;
  const snapshot=notebookApi.notebookSnapshot(notebook);
  view.notebookSnapshot=snapshot;view.session.notebookSnapshot=snapshot;
  view.session.messages.push({role:'user',content:'old'.repeat(5000)+notebookApi.notebookContext(notebookApi.notebookDelta(notebook,null))});
  view.refreshNotebookDeltaLabel();assert.match(view.notebookAttachLabel.textContent,/待发 0 格/);
  await view.compress('fake',signal(),0,env.plugin.model,true);
  assert.equal(view.notebookSnapshot,null);assert.equal(view.session.notebookSnapshot,undefined);
  assert.match(view.notebookAttachLabel.textContent,/待发 1 格/);
  view.notebookSnapshot=snapshot;view.session.notebookSnapshot=snapshot;view.refreshNotebookDeltaLabel();
  await view.clear();assert.equal(view.notebookSnapshot,null);assert.match(view.notebookAttachLabel.textContent,/待发 1 格/);
  await view.onClose();
});
test('deleting an unrelated exchange preserves the Notebook delta baseline',async()=>{
  const api=require('./src/notebook');
  const notebook={cells:[{id:'calc',cell_type:'code',source:'x = 1',outputs:[]}]};
  const snapshot=api.notebookSnapshot(notebook), context='first'+api.notebookContext(api.notebookDelta(notebook,null));
  const env=ui(async()=>{},async()=>{});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  view.notebookClient={read:()=>notebook,close(){}};view.notebookSnapshot=snapshot;view.session.notebookSnapshot=snapshot;
  const first=view.row('你','first');first.entry.contextText=context;first.entry.notebookAttached=true;
  const firstReply=view.row('deepseek-flash','answer one');
  view.messages.push({role:'user',content:context},{role:'assistant',content:'answer one'});
  view.row('你','second');const secondReply=view.row('deepseek-flash','answer two');
  view.messages.push({role:'user',content:'second'},{role:'assistant',content:'answer two'});
  await view.deleteTurn(secondReply.entry);
  assert.equal(view.notebookSnapshot?.hash,snapshot.hash);assert.match(view.notebookAttachLabel.textContent,/待发 0 格/);
  await view.deleteTurn(firstReply.entry);
  assert.equal(view.notebookSnapshot,null);assert.match(view.notebookAttachLabel.textContent,/待发 1 格/);
  await view.onClose();
});
test('Notebook send mode defaults to changes and supports none or full text',async()=>{
  const api=require('./src/notebook'),requests=[];
  const notebook={cells:[{id:'calc',cell_type:'code',source:'x = 1',outputs:[]}]};
  const env=ui(async(_key,messages,_signal,onDelta)=>{requests.push(messages.at(-1).content);onDelta('OK');return{completion_tokens:2};},async()=>{});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();env.plugin.keys.deepseek='test-key';
  view.notebookMode=true;view.notebookClient={read:()=>notebook,close(){}};
  assert.equal(view.notebookAttach.value,'delta');
  view.input.value='first';await view.send();
  const firstHash=view.notebookSnapshot.hash;
  assert.match(requests[0],/\[Notebook delta/);assert.match(requests[0],/"previousHash":null/);
  notebook.cells[0].source='x = 2';view.notebookAttach.value='none';view.refreshNotebookDeltaLabel();
  view.input.value='second';await view.send();
  assert.ok(!requests[1].includes('[Notebook delta'));assert.equal(view.notebookSnapshot.hash,firstHash);
  assert.match(view.notebookAttachLabel.textContent,/增量待发 1 格/);
  view.notebookAttach.value='all';view.refreshNotebookDeltaLabel();assert.match(view.notebookAttachLabel.textContent,/全部 1 格/);
  view.input.value='third';await view.send();
  assert.match(requests[2],/"previousHash":null/);assert.match(requests[2],/"source":"x = 2"/);
  assert.equal(view.notebookSnapshot.hash,api.notebookHash(notebook));
  view.notebookAttach.value='delta';view.refreshNotebookDeltaLabel();assert.match(view.notebookAttachLabel.textContent,/待发 0 格/);
  await view.onClose();
});
test('automatic compression resends full Notebook content before advancing the delta baseline',async()=>{
  const notebookApi=require('./src/notebook');
  const notebook={cells:[{id:'one',cell_type:'code',source:'print(42)',outputs:[]}]};
  let sent;
  const env=ui(async(_key,messages,_signal,delta)=>{
    if(messages.at(-1).content.includes('压缩')) {delta('short summary');return{completion_tokens:2};}
    sent=messages.at(-1).content;delta('done');return{prompt_tokens:100,completion_tokens:2};
  },async()=>{});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();
  view.notebookClient={read:()=>notebook,close(){}};view.notebookMode=true;view.notebookAttach.value='delta';
  const snapshot=notebookApi.notebookSnapshot(notebook);view.notebookSnapshot=snapshot;view.session.notebookSnapshot=snapshot;
  view.messages.push({role:'user',content:'old'.repeat(5000)+notebookApi.notebookContext(notebookApi.notebookDelta(notebook,null))});
  view.session.meter={tokens:800000,count:1,estimated:true,model:env.plugin.model,systemPrompt:notebookApi.NOTEBOOK_SYSTEM_PROMPT};view.input.value='继续';
  await view.send();
  assert.ok(sent?.includes('print(42)'));assert.ok(sent.includes('"previousHash":null'));
  assert.equal(view.notebookSnapshot?.hash,snapshot.hash);assert.match(view.notebookAttachLabel.textContent,/待发 0 格/);
  await view.onClose();
});
test('dropped image waits for Send, hides recognition text in UI, and keeps base64 out of saved context',async()=>{
  let seen, pdfCalls=0, visionCalls=0;
  const image={name:'paper-figure.png',size:8,arrayBuffer:async()=>Buffer.from([137,80,78,71,13,10,26,10])};
  const env=ui(async(_key,messages,_signal,delta)=>{seen=messages;delta('The plot rises.');return{completion_tokens:4};},async()=>{pdfCalls++;return 'PDF markdown';},{
    describeImage:async()=>{visionCalls++;return 'Panel A: x is time; y rises.';}
  });
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();
  assert.equal(view.dropZone.hidden,true);
  const enter=new env.dom.window.Event('dragenter',{bubbles:true,cancelable:true});view.dropZone.parentElement.dispatchEvent(enter);
  assert.equal(view.dropZone.hidden,false);
  const drop=new env.dom.window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:{files:[image]}});
  view.dropZone.parentElement.dispatchEvent(drop);await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(view.dropZone.hidden,true);
  assert.equal(visionCalls,0);assert.equal(pdfCalls,0);assert.equal(view.pendingImages.length,1);
  assert.ok(!view.feed.textContent.includes('Panel A:'));
  assert.equal(env.plugin.session.messages.length,0);
  assert.ok(!JSON.stringify(env.plugin.session).includes('base64,'));
  env.plugin.keys.mineru='fake';await view.upload({name:'paper.pdf',size:4,arrayBuffer:async()=>Buffer.from('%PDF')});
  assert.equal(pdfCalls,1);assert.ok(view.feed.textContent.includes('PDF markdown'));
  view.input.value='这图说明什么？';await view.send();
  assert.equal(visionCalls,1);assert.equal(view.pendingImages.length,0);
  assert.ok(seen.some(message=>typeof message.content==='string'&&message.content.includes('Panel A: x is time')));
  assert.ok(!view.feed.textContent.includes('Panel A:'));assert.equal(env.plugin.session.entries.find(entry=>entry.label==='你').images[0].name,'paper-figure.png');
  await env.plugin.saveQueue;assert.ok(!JSON.stringify([...env.conversationState.values()]).includes('base64,'));
  await view.onClose();
});
test('pending image notice follows interface language without translating filenames or hidden descriptions',async()=>{
  const env=ui(async(k,m,s,d)=>d('Answer'),async()=>{}, {saved:{uiLanguage:'en'},describeImage:async()=> '图中的横轴是时间。'});
  await env.plugin.onload();env.plugin.keys.deepseek='test-key';const view=env.plugin.factory({});await view.onOpen();
  await view.upload({name:'figure.png',size:8,arrayBuffer:async()=>Buffer.from([137,80,78,71,13,10,26,10])});
  await new Promise(setImmediate);assert.match(view.status.textContent,/Image attached/);assert.equal(view.pendingImageList.textContent,'figure.png');
  assert.equal(view.pendingImageList.querySelector('button').getAttribute('aria-label'),'Remove image');
  env.plugin.uiLanguage='zh';view.refreshLanguage();await new Promise(setImmediate);
  assert.match(view.status.textContent,/图片已暂存/);assert.equal(view.pendingImageList.querySelector('button').getAttribute('aria-label'),'移除图片');
  env.plugin.uiLanguage='en';view.refreshLanguage();await new Promise(setImmediate);
  assert.match(view.status.textContent,/Image attached/);view.input.value='Explain';await view.send();assert.match(view.messages[0].content,/图中的横轴是时间。/);
  assert.ok(!view.feed.textContent.includes('图中的横轴'));assert.equal(view.session.entries[0].images[0].name,'figure.png');
  await view.onClose();
});
test('Ctrl+V stages clipboard images and parses PDFs while ordinary text remains a normal paste',async()=>{
  let imageCalls=0,pdfCalls=0;
  const env=ui(async()=>{},async()=>{pdfCalls++;return '# PDF text';},{describeImage:async()=>{imageCalls++;return 'Figure A: rising curve';}});
  await env.plugin.onload();env.plugin.keys={deepseek:'fake',mineru:'fake'};const view=env.plugin.factory({});await view.onOpen();view.input.value='draft';
  const png={name:'',type:'image/png',size:8,arrayBuffer:async()=>Buffer.from([137,80,78,71,13,10,26,10])};
  const pasteImage=new env.dom.window.Event('paste',{bubbles:true,cancelable:true});
  Object.defineProperty(pasteImage,'clipboardData',{value:{files:[],items:[{kind:'file',getAsFile:()=>png}]}});
  view.input.dispatchEvent(pasteImage);await new Promise(resolve=>setTimeout(resolve,30));
  assert.ok(pasteImage.defaultPrevented);assert.equal(imageCalls,0);assert.equal(view.input.value,'draft');assert.equal(view.pendingImages.length,1);
  assert.equal(env.plugin.session.messages.length,0);
  const pdf={name:'paper.pdf',type:'application/pdf',size:4,arrayBuffer:async()=>Buffer.from('%PDF')};
  const pastePdf=new env.dom.window.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(pastePdf,'clipboardData',{value:{files:[pdf],items:[]}});
  view.input.dispatchEvent(pastePdf);await new Promise(resolve=>setTimeout(resolve,30));
  assert.ok(pastePdf.defaultPrevented);assert.equal(pdfCalls,1);assert.ok(view.feed.textContent.includes('# PDF text'));
  const plain=new env.dom.window.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(plain,'clipboardData',{value:{files:[],items:[],getData:()=> 'hello'}});
  view.input.dispatchEvent(plain);assert.equal(plain.defaultPrevented,false);
  await view.send();assert.equal(imageCalls,1);assert.ok(env.plugin.session.messages.some(message=>message.content.includes('Figure A: rising curve')));
  await view.onClose();
});
test('UI: native renderer receives normalized math; copy preserves Markdown; context keeps original',async()=>{
  const calls=[];const env=ui(async(k,msg,s,delta)=>{calls.push(msg);delta('**回答** $x$');},async()=> '# 文本\n\\(a=b\\)');
  const{plugin,doc,renders,copies}=env;await plugin.onload();const view=plugin.factory({});await view.onOpen();plugin.keys={deepseek:'fake',mineru:'fake'};
  await view.upload(pdfFile);assert.ok(doc.querySelector('h1'));assert.ok(renders.some(r=>r.text==='# 文本\n$a=b$'));
  doc.querySelector('.sd-message-head button').click();await Promise.resolve();assert.equal(copies[0],'# 文本\n$a=b$');
  view.input.value='总结';await view.send();assert.ok(calls[0].some(m=>m.content.includes('\\(a=b\\)')));assert.ok(renders.some(r=>r.text==='**回答** $x$'));
  await view.clear();assert.equal(view.messages.length,0);assert.equal(doc.querySelectorAll('.sd-message').length,0);assert.equal(view.children.size,0);await view.onClose();
});
test('rendered text selection copies local Markdown and pauses replacement until deselected',async()=>{
  const env=ui(async()=>{},async()=>{});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  const state=view.row('deepseek-flash','Old **bold** paragraph');await view.render(state);
  state.body.innerHTML='<div class="sd-markdown"><p>Old <strong>bold</strong> paragraph</p></div>';
  const text=state.body.querySelector('strong').firstChild,range=env.doc.createRange();range.setStart(text,0);range.setEnd(text,4);
  const selection=env.doc.getSelection();selection.addRange(range);
  const values=new Map(),event=new env.dom.window.Event('copy',{bubbles:true,cancelable:true});
  Object.defineProperty(event,'clipboardData',{value:{setData:(type,value)=>values.set(type,value)}});
  state.body.dispatchEvent(event);assert.equal(event.defaultPrevented,true);assert.equal(values.get('text/plain'),'**bold**');
  view.update(state,'New reply',true,false);await view.render(state);
  assert.equal(state.body.textContent,'Old bold paragraph');assert.equal(view.selectionDeferredRows.has(state),true);
  selection.removeAllRanges();env.doc.dispatchEvent(new env.dom.window.Event('selectionchange'));await new Promise(setImmediate);
  assert.equal(state.body.textContent,'New reply');assert.equal(view.selectionDeferredRows.size,0);
  await view.onClose();assert.equal(view.copySelectionListener,null);assert.equal(view.selectionChangeListener,null);
});
test('selection started during an asynchronous Markdown render survives the pending replacement',async()=>{
  let pause=false,release;const env=ui(async()=>{},async()=>{}, {render:async()=>{if(pause){pause=false;await new Promise(resolve=>release=resolve);}}});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  const state=view.row('deepseek-flash','Old paragraph');await view.render(state);
  view.update(state,'New paragraph',true,false);pause=true;const drawing=view.render(state);
  const text=state.body.querySelector('p').firstChild,range=env.doc.createRange();range.setStart(text,0);range.setEnd(text,3);env.doc.getSelection().addRange(range);
  release();await drawing;assert.equal(state.body.textContent,'Old paragraph');
  env.doc.getSelection().removeAllRanges();env.doc.dispatchEvent(new env.dom.window.Event('selectionchange'));await new Promise(setImmediate);
  assert.equal(state.body.textContent,'New paragraph');await view.onClose();
});
test('private settings: load credentials and keep them out of shared data',async()=>{
  const{plugin,doc,saved}=ui(async()=>{},async()=>'',{keyState:{deepseek:'ds-old',mineru:'mu-old',libraryPath:'C:/local-lib'},saved:{messages:['should not load'],libraryPath:'shared-leak'}});
  await plugin.onload();const view=plugin.factory({});await view.onOpen();assert.equal(doc.querySelector('input').value,'ds-old');assert.equal(view.messages.length,0);
  assert.equal(plugin.libraryPath,'C:/local-lib');assert.equal(saved.length,0);plugin.keys.deepseek='ds-new';plugin.keys.unwanted='never save';await plugin.saveKeys();assert.deepEqual(saved.at(-1),{displayTokensPerSecond:0,model:'deepseek-flash',reasoningEffort:'low',webEnabled:true,uiLanguage:'en'});assert.ok(!JSON.stringify(saved).includes('local-lib'));await view.clear();assert.equal(plugin.keys.deepseek,'ds-new');await view.onClose();
});
test('keys: input change autosaves and survives a fresh plugin instance',async()=>{
  const{plugin,doc,dom,saved,keyState}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();
  const input=doc.querySelector('input');input.value='Bearer new-key';input.dispatchEvent(new dom.window.Event('input'));input.dispatchEvent(new dom.window.Event('change'));await plugin.saveQueue;
  assert.equal(keyState.deepseek,'new-key');assert.equal(saved.at(-1).keys,undefined);const reloaded=ui(async()=>{},async()=> '',{saved:saved.at(-1),keyState});await reloaded.plugin.onload();assert.equal(reloaded.plugin.keys.deepseek,'new-key');await view.onClose();
});
test('keys: serialized writes keep newest value; failed save can recover',async()=>{
  let release;let writes=0;const{plugin,saved,keyState}=ui(async()=>{},async()=>'',{save:async()=>{if(++writes===1)await new Promise(r=>release=r);}});await plugin.onload();plugin.keys.deepseek='first';const first=plugin.saveKeys();await new Promise(setImmediate);plugin.keys.deepseek='second';const second=plugin.saveKeys();release();await first;await second;assert.equal(keyState.deepseek,'second');
  let fail=true;const env=ui(async()=>{},async()=>'',{save:async()=>{if(fail){fail=false;throw Error('disk');}}});await env.plugin.onload();await assert.rejects(env.plugin.saveKeys());await env.plugin.saveKeys();assert.equal(env.saved.length,1);
});
test('UI: clearing during streaming prevents late text or stale controls',async()=>{
  let resolveChat,delta;const{plugin,doc}=ui(async(k,m,s,onDelta)=>{delta=onDelta;await new Promise(r=>resolveChat=r);},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();plugin.keys.deepseek='fake';view.input.value='hi';const pending=view.send();await new Promise(setImmediate);assert.equal(view.notebookAttach.disabled,true);await view.clear();assert.equal(view.notebookAttach.disabled,false);delta('late');resolveChat();await pending;assert.equal(doc.querySelectorAll('.sd-message').length,0);assert.equal(view.messages.length,0);assert.equal(view.sendButton.disabled,false);await view.onClose();
});
test('UI: clear during native rendering unloads component and discards DOM',async()=>{
  let release;const{plugin,doc}=ui(async()=>{},async()=>'',{render:async()=>new Promise(r=>release=r)});await plugin.onload();const view=plugin.factory({});await view.onOpen();const row=view.row('test','$a$');const drawing=view.render(row);await view.clear();release();await drawing;assert.equal(doc.querySelectorAll('.sd-message').length,0);assert.equal(view.children.size,0);await view.onClose();
});
test('UI: newest stream revision wins over an older delayed render',async()=>{
  let release,first=true;const{plugin,doc}=ui(async()=>{},async()=>'',{render:async()=>{if(first){first=false;await new Promise(r=>release=r);}}});await plugin.onload();const view=plugin.factory({});await view.onOpen();const row=view.row('test','$a$');const drawing=view.render(row);view.update(row,'$b$');release();await drawing;assert.equal(doc.querySelector('.sd-body').textContent,'$b$');assert.equal(view.children.size,1);await view.onClose();assert.equal(view.children.size,0);
});
test('UI: native renderer failure falls back to visible Markdown',async()=>{
  const{plugin,doc}=ui(async()=>{},async()=>'',{render:async()=>{throw Error('renderer');}});await plugin.onload();const view=plugin.factory({});await view.onOpen();const row=view.row('test','$x$');await view.render(row);assert.equal(doc.querySelector('.sd-render-fallback').textContent,'$x$');await view.onClose();
});
test('UI: partial chat stays in future context; IME does not send',async()=>{
  let count=0;const{plugin,dom}=ui(async(k,m,s,delta)=>{count++;delta('partial');throw Error('断开');},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();plugin.keys.deepseek='fake';view.input.value='中文';view.input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));assert.equal(count,0);await view.send();assert.equal(view.messages.length,2);assert.equal(view.messages[1].content,'partial');assert.equal(view.status.textContent,'断开');await view.onClose();
});
test('runtime: shared settings use data API while conversation files are isolated in their store',()=>{
  for(const name of ['main','core','markdown','context','pacing']){const source=fs.readFileSync(__dirname+'/src/'+name+'.js','utf8');assert.doesNotMatch(source,/console\.|localStorage|sessionStorage|indexedDB|require\(['"](?:node:)?fs|\.vault\.|writeFile|appendFile|createWriteStream/);if(name!=='main')assert.doesNotMatch(source,/saveData|loadData/);}
  const main=fs.readFileSync(__dirname+'/src/main.js','utf8'),store=fs.readFileSync(__dirname+'/src/conversations.js','utf8');assert.doesNotMatch(main,/snapshot\.conversations/);assert.match(store,/conversations/);assert.match(store,/writeFile/);
});
test('math: nested protected code in links is restored and numeric formulas convert',()=>{
  assert.equal(normalizeMath('[`$x$`](https://example.com)'), '[`$x$`](https://example.com)');
  assert.equal(normalizeMath('$2$ and $x_1$'), '$2$ and $x_1$');
  assert.equal(normalizeMath('plain x + y = z'), 'plain x + y = z');
});
test('math: mixed inline and display stays distinct through rendering and copying',async()=>{
  const{plugin,doc,renders,copies}=ui(async()=>{},async()=> '正文 \\(x+1\\) 然后\n\\[x^2+y^2=z^2\\]');await plugin.onload();const view=plugin.factory({});await view.onOpen();plugin.keys.mineru='fake';await view.upload(pdfFile);
  const expected='正文 $x+1$ 然后\n$$x^2+y^2=z^2$$';assert.ok(renders.some(r=>r.text===expected));doc.querySelector('.sd-message-head button').click();await Promise.resolve();assert.equal(copies[0],expected);await view.onClose();
});
test('chat prompt keeps reference trust boundary without formatting instructions',async()=>{
  let prompt;const{plugin}=ui(async(k,m,s,delta)=>{prompt=m[0].content;delta('ok');},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();plugin.keys.deepseek='fake';view.input.value='hello';await view.send();assert.equal(prompt,require('./src/context').SYSTEM_PROMPT);assert.ok(!prompt.includes('$'));await view.onClose();
});
test('chat: official 393216 token output cap, full context, no short total timeout',async()=>{
  const messages=[{role:'user',content:'old'},{role:'assistant',content:'old answer'},{role:'user',content:'new'}];
  await core.chat('fake',messages,signal(),()=>{},async(url,opts)=>{const body=JSON.parse(opts.body);assert.equal(body.max_tokens,393216);assert.deepEqual(body.messages,messages);assert.equal(opts.timeoutMs,0);assert.equal(opts.idleTimeoutMs,600000);opts.onChunk(Buffer.from(event('done')+stopEvent+'data: [DONE]\n\n'));});
});
test('context: reopen restores all messages, attachments and transcript, clear resets session',async()=>{
  const calls=[];const{plugin,doc}=ui(async(k,m,s,delta)=>{calls.push(m);delta('');delta('answer');},async()=> '# Document');await plugin.onload();plugin.keys={deepseek:'fake',mineru:'fake'};
  const first=plugin.factory({});await first.onOpen();await first.upload(pdfFile);first.input.value='first question';await first.send();assert.equal(first.messages.length,3);await first.onClose();
  const second=plugin.factory({});await second.onOpen();assert.equal(second.messages.length,3);assert.equal(doc.querySelectorAll('.sd-message').length,3);second.input.value='follow up';await second.send();assert.ok(calls[1].some(m=>m.content.includes('# Document')));assert.ok(calls[1].some(m=>m.content==='first question'));assert.ok(calls[1].some(m=>m.content==='answer'));assert.equal(second.messages.length,5);
  await second.clear();assert.equal(plugin.session.messages.length,0);assert.equal(plugin.session.entries.length,0);await second.onClose();
});
test('context: interrupted answer is available for a follow-up after reopening',async()=>{
  let count=0,seen;const{plugin}=ui(async(k,m,s,delta)=>{if(++count===1){delta('partial text');throw Error('network');}seen=m;delta('continued');},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const first=plugin.factory({});await first.onOpen();first.input.value='question';await first.send();await first.onClose();const next=plugin.factory({});await next.onOpen();next.input.value='continue';await next.send();assert.ok(seen.some(m=>m.content==='partial text'));await next.onClose();
});
const ctx=require('./src/context');
function largeSession(tokens=800000){return{messages:[{role:'user',content:'original question'},{role:'assistant',content:'original answer'}],entries:[{label:'you',raw:'original question'}],meter:{tokens,count:2},compactions:0};}
test('usage: final SSE usage is returned and chat requests usage',async()=>{
  const expected={prompt_tokens:799999,completion_tokens:2,total_tokens:800001};
  const usage=await core.chat('fake',[],signal(),()=>{},async(url,opts)=>{assert.equal(JSON.parse(opts.body).stream_options.include_usage,true);opts.onChunk(Buffer.from(event('answer')+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:expected})+'\n\ndata: [DONE]\n\n'));});assert.deepEqual(usage,expected);
});
test('compression: below 800000 no call, exactly 800000 sends full context plus prompt',async()=>{
  const below=largeSession(799999);assert.equal(await ctx.compactContext(below,'fake',signal(),()=>{},async()=>assert.fail('must not call')),null);
  const session=largeSession();const original=JSON.parse(JSON.stringify(session.messages));let sent;
  const result=await ctx.compactContext(session,'fake',signal(),()=>{},async(k,m,s,delta,http,opts)=>{sent=m;assert.equal(opts.maxOutputTokens,65536);delta('# summary');return{completion_tokens:100};});
  assert.deepEqual(sent.slice(1,-2),original);assert.equal(sent.at(-1).content,ctx.COMPRESSION_PROMPT);assert.equal(session.messages.length,1);assert.ok(session.messages[0].content.includes('# summary'));assert.equal(session.entries[0].raw,'original question');assert.equal(result.before,800000);assert.ok(result.after<800000);
});
test('compression: server token usage outranks estimates and appended messages are included',()=>{
  const session=largeSession(100);session.messages.push({role:'user',content:'new question'});assert.equal(ctx.contextTokens(session),100+ctx.estimateMessages(session.messages.slice(2)));ctx.rememberUsage(session,{prompt_tokens:799000,completion_tokens:1000});assert.equal(ctx.contextTokens(session),800000);
});
test('compression: network error, empty output and oversized summary preserve original',async()=>{
  for(const scenario of ['network','empty','large']){
    const session=largeSession();const original=JSON.stringify(session.messages);
    await assert.rejects(ctx.compactContext(session,'fake',signal(),()=>{},async(k,m,s,delta)=>{if(scenario==='network')throw Error('network');if(scenario==='large'){delta('中'.repeat(1400000));return{completion_tokens:800001};}}));
    assert.equal(JSON.stringify(session.messages),original);assert.equal(session.compactions,0);
  }
});
test('compression: stop preserves full context; stale completion cannot overwrite changed messages',async()=>{
  let session=largeSession();const original=JSON.stringify(session.messages);const controller=new AbortController();
  await assert.rejects(ctx.compactContext(session,'fake',controller.signal,()=>{},async(k,m,s,delta)=>{delta('partial summary');controller.abort();}),{name:'AbortError'});assert.equal(JSON.stringify(session.messages),original);
  session=largeSession();await assert.rejects(ctx.compactContext(session,'fake',signal(),()=>{},async(k,m,s,delta)=>{delta('summary');session.messages.length=0;return{completion_tokens:100};}),/会话已变化/);assert.equal(session.messages.length,0);
});
test('compression: oversized single context fails without dropping messages or paid retry',async()=>{
  const session=largeSession(ctx.CONTEXT_WINDOW);await assert.rejects(ctx.compactContext(session,'fake',signal(),()=>{},async()=>assert.fail('must not call')),/可用空间/);assert.equal(session.messages.length,2);
});
test('compression: repeated cycles summarize prior summary and new conversation',async()=>{
  const session=largeSession();await ctx.compactContext(session,'fake',signal(),()=>{},async(k,m,s,d)=>{d('summary one');return{completion_tokens:100};});session.messages.push({role:'user',content:'new details'});session.meter={tokens:800000,count:2};
  await ctx.compactContext(session,'fake',signal(),()=>{},async(k,m,s,d)=>{assert.ok(m.some(x=>x.content.includes('summary one')));assert.ok(m.some(x=>x.content==='new details'));d('summary two');return{completion_tokens:100};});assert.equal(session.compactions,2);assert.ok(session.messages[0].content.includes('summary two'));
});
test('compression: reply budget fits remaining context and stays below official max',()=>{
  assert.equal(ctx.outputBudget(largeSession(100)),393216);assert.equal(ctx.outputBudget(largeSession(800000)),ctx.CONTEXT_WINDOW-800000-4096);
});
test('UI: crossing threshold makes one model compression call; transcript stays and next turn uses summary',async()=>{
  let count=0;const calls=[];const{plugin,doc}=ui(async(k,m,s,d)=>{calls.push(m);count++;if(count===1){d('full answer');return{prompt_tokens:799999,completion_tokens:2};}if(count===2){assert.equal(m.at(-1).content,ctx.COMPRESSION_PROMPT);d('compressed memory');return{prompt_tokens:800001,completion_tokens:100};}d('followup answer');return{prompt_tokens:200,completion_tokens:50};},async()=> '');
  await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='question';await view.send();assert.equal(count,2);assert.equal(plugin.session.messages.length,1);assert.ok(doc.body.textContent.includes('full answer'));assert.ok(!doc.body.textContent.includes('compressed memory'));assert.equal(plugin.session.entries.length,2);
  view.input.value='followup';await view.send();assert.ok(calls[2].some(m=>m.content.includes('compressed memory')));assert.ok(!calls[2].some(m=>m.content==='full answer'));await view.onClose();
});
test('UI: compression before send keeps pending text if compression fails',async()=>{
  const{plugin}=ui(async()=>{throw Error('network');},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();plugin.session.messages.push({role:'user',content:'old'});plugin.session.meter={tokens:800000,count:1,model:plugin.model,systemPrompt:ctx.SYSTEM_PROMPT};view.input.value='pending';await view.send();assert.equal(view.input.value,'pending');assert.equal(plugin.session.messages[0].content,'old');await view.onClose();
});
test('UI: oversized context is rejected before the API request and keeps the draft',async()=>{
  let calls=0;const{plugin}=ui(async()=>{calls++;},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();
  plugin.session.messages.push({role:'user',content:'old'});plugin.session.meter={tokens:ctx.CONTEXT_WINDOW-1000,count:1,model:plugin.model,systemPrompt:ctx.SYSTEM_PROMPT};view.compress=async()=>null;
  view.input.value='pending question';await view.send();assert.equal(calls,0);assert.equal(view.input.value,'pending question');assert.equal(plugin.session.messages.length,1);assert.match(view.status.textContent,/超过可用空间/);await view.onClose();
});
test('UI: clearing during compression prevents late summary and resets token meter',async()=>{
  let release;const{plugin,doc}=ui(async(k,m,s,d)=>{d('summary');await new Promise(r=>release=r);return{completion_tokens:100};},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();plugin.session.messages.push({role:'user',content:'old'});plugin.session.meter={tokens:800000,count:1,model:plugin.model,systemPrompt:ctx.SYSTEM_PROMPT};view.input.value='pending';const pending=view.send();await new Promise(setImmediate);await view.clear();release();await pending;assert.equal(plugin.session.messages.length,0);assert.equal(plugin.session.meter,null);assert.equal(doc.querySelectorAll('.sd-message').length,0);await view.onClose();
});
test('usage: length-limited completion carries measured usage for the next compression check',async()=>{
  await assert.rejects(core.chat('fake',[],signal(),()=>{},async(url,opts)=>{opts.onChunk(Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:'length'}],usage:{prompt_tokens:799999,completion_tokens:2}})+'\n\ndata: [DONE]\n\n'));}),error=>error.usage.prompt_tokens===799999&&error.usage.completion_tokens===2);
});
test('UI: usage from a truncated answer is retained for compression on the next send',async()=>{
  const{plugin}=ui(async(k,m,s,d)=>{d('partial');const error=Error('length');error.usage={prompt_tokens:799999,completion_tokens:2};throw error;},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='question';await view.send();assert.equal(ctx.contextTokens(plugin.session),800001);await view.onClose();
});
test('cache: ordinary turns preserve exact message prefix and original formula text',async()=>{
  const requests=[];const answers=['first\n\n\\(x^2\\)  ', 'second\n```js\nx=1\n```', 'third'];
  const{plugin}=ui(async(k,m,s,d)=>{requests.push(JSON.parse(JSON.stringify(m)));d(answers[requests.length-1]);return{prompt_tokens:100,completion_tokens:10,prompt_cache_hit_tokens:80,prompt_cache_miss_tokens:20};},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();
  for(const q of ['user 1\nnext line','user 2','user 3']){view.input.value=q;await view.send();}
  assert.deepEqual(requests[1].slice(0,requests[0].length),requests[0]);assert.deepEqual(requests[2].slice(0,requests[1].length),requests[1]);assert.equal(requests[1][2].content,answers[0]);assert.equal(requests[2][4].content,answers[1]);assert.equal(requests[0][0].content,ctx.SYSTEM_PROMPT);await view.onClose();
});
test('cache: hit tokens still occupy context and missing usage is not reported as zero',()=>{
  const session=largeSession(10);ctx.rememberUsage(session,{prompt_tokens:799990,prompt_cache_hit_tokens:799990,prompt_cache_miss_tokens:0,completion_tokens:10});assert.equal(ctx.contextTokens(session),800000);
  assert.match(ctx.formatUsage({prompt_tokens:100,completion_tokens:5}),/缓存命中 未返回/);assert.match(ctx.formatUsage({prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:100}),/缓存命中 0/);assert.equal(ctx.formatUsage(null),'服务端未返回用量');
});
test('cache: compression request extends old prefix, summary starts a new prefix then appends',async()=>{
  const requests=[];let n=0;const{plugin}=ui(async(k,m,s,d)=>{requests.push(JSON.parse(JSON.stringify(m)));if(++n===1){d('old answer');return{prompt_tokens:799999,completion_tokens:1};}if(n===2){d('summary');return{prompt_tokens:800100,completion_tokens:10};}d('new answer');return{prompt_tokens:100,completion_tokens:10};},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='original';await view.send();
  assert.deepEqual(requests[1].slice(0,requests[0].length),requests[0]);assert.equal(requests[1][requests[0].length].content,'old answer');assert.equal(requests[1].at(-1).content,ctx.COMPRESSION_PROMPT);
  view.input.value='followup';await view.send();assert.equal(requests[2][0].content,requests[0][0].content);assert.ok(requests[2][1].content.includes('summary'));assert.notEqual(requests[2][1].content,requests[0][1].content);
  view.input.value='again';await view.send();assert.deepEqual(requests[3].slice(0,requests[2].length),requests[2]);await view.onClose();
});
test('cache: actual usage appears per answer, survives reopen and never enters model context',async()=>{
  const requests=[];const{plugin,doc}=ui(async(k,m,s,d)=>{requests.push(m);d('answer');return{prompt_tokens:10000,prompt_cache_hit_tokens:8000,prompt_cache_miss_tokens:2000,completion_tokens:500};},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';let view=plugin.factory({});await view.onOpen();view.input.value='question';await view.send();assert.ok(doc.body.textContent.includes('缓存命中 8,000'));assert.ok(doc.body.textContent.includes('未命中 2,000'));await view.onClose();view=plugin.factory({});await view.onOpen();assert.ok(doc.body.textContent.includes('缓存命中 8,000'));view.input.value='next';await view.send();assert.ok(requests[1].every(m=>!m.content.includes('缓存命中')));await view.onClose();
});
test('metrics: context percentage uses exactly one million and marks estimates',()=>{
  const session=largeSession(800000);session.meter.estimated=false;assert.match(ctx.sessionStats(session).text,/上下文 80\.0%/);session.meter.estimated=true;assert.match(ctx.sessionStats(session).text,/上下文 约 80\.0%/);assert.match(ctx.sessionStats({messages:[]}).text,/上下文 0\.0%/);
});
test('metrics: cumulative cache ratio is token-weighted, not average of turn percentages',()=>{
  const session={messages:[]};ctx.recordCacheUsage(session,{prompt_cache_hit_tokens:900,prompt_cache_miss_tokens:100});ctx.recordCacheUsage(session,{prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:100});assert.match(ctx.sessionStats(session).text,/缓存总命中率 81\.8%/);assert.equal(session.cache.hit,900);assert.equal(session.cache.miss,200);
});
test('metrics: missing statistics do not fabricate a zero and zero-token requests avoid division by zero',()=>{
  const session={messages:[]};ctx.recordCacheUsage(session,null);assert.match(ctx.sessionStats(session).text,/暂无数据/);ctx.recordCacheUsage(session,{prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:0});assert.match(ctx.sessionStats(session).text,/暂无数据/);ctx.recordCacheUsage(session,{prompt_cache_hit_tokens:80,prompt_cache_miss_tokens:20});assert.match(ctx.sessionStats(session).text,/80\.0%（仅已返回统计的请求）/);
});
test('metrics: compression contributes cache usage without resetting cumulative counters',async()=>{
  const session=largeSession();ctx.recordCacheUsage(session,{prompt_cache_hit_tokens:900,prompt_cache_miss_tokens:100});await ctx.compactContext(session,'fake',signal(),()=>{},async(k,m,s,d)=>{d('summary');return{completion_tokens:100,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:100};});assert.equal(session.cache.measured,2);assert.match(ctx.sessionStats(session).text,/81\.8%/);assert.ok(ctx.contextTokens(session)<800000);
});
test('metrics UI: current percentage and cumulative ratio restore on reopen and reset on clear',async()=>{
  const{plugin,doc}=ui(async(k,m,s,d)=>{d('answer');return{prompt_tokens:10000,completion_tokens:500,prompt_cache_hit_tokens:8000,prompt_cache_miss_tokens:2000};},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';let view=plugin.factory({});await view.onOpen();assert.equal(doc.querySelector('.sd-metrics').parentElement,doc.querySelector('.sd-history'));view.input.value='question';await view.send();assert.match(doc.querySelector('.sd-metrics').textContent,/上下文 1\.1% · 缓存总命中率 80\.0%/);assert.ok(doc.querySelector('.sd-metrics').title.includes('10,500 / 1,000,000'));
  await view.onClose();view=plugin.factory({});await view.onOpen();assert.match(doc.querySelector('.sd-metrics').textContent,/80\.0%/);await view.clear();assert.match(doc.querySelector('.sd-metrics').textContent,/上下文 0\.0% · 缓存总命中率 暂无数据/);assert.equal(plugin.session.cache,null);await view.onClose();
});
test('metrics UI: ordinary and compression cache usage are each counted once',async()=>{
  let count=0;const{plugin,doc}=ui(async(k,m,s,d)=>{if(++count===1){d('answer');return{prompt_tokens:799999,completion_tokens:1,prompt_cache_hit_tokens:700000,prompt_cache_miss_tokens:99999};}d('summary');return{prompt_tokens:800100,completion_tokens:100,prompt_cache_hit_tokens:700000,prompt_cache_miss_tokens:100100};},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='question';await view.send();assert.equal(plugin.session.cache.measured,2);assert.equal(plugin.session.cache.hit,1400000);assert.equal(plugin.session.cache.miss,200099);assert.match(doc.querySelector('.sd-metrics').textContent,/87\.5%/);await view.onClose();
});
const {TextPacer,advance,charCost}=require('./src/pacing');
test('pacing: virtual clock enforces about 50 tokens/s on a burst without truncation',async()=>{
  let time=0;const frames=[];const text='a'.repeat(1000);const pacer=new TextPacer({getRate:()=>50,signal:signal(),now:()=>time,sleep:async ms=>{time+=ms;},onFrame:async s=>frames.push({s,time})});pacer.push(text);pacer.finish();await pacer.run();assert.equal(frames.at(-1).s,text);assert.ok(frames.length>1);for(const frame of frames)assert.ok(frame.s.length*0.3<=50*frame.time/1000+0.00001);assert.ok(time>=6000);
});
test('pacing: slow rendering is awaited and does not accumulate a catch-up burst',async()=>{
  let time=0,inflight=0,peak=0,lastLength=0;const deltas=[];const pacer=new TextPacer({getRate:()=>50,signal:signal(),now:()=>time,sleep:async ms=>{time+=ms;},onFrame:async s=>{inflight++;peak=Math.max(peak,inflight);deltas.push((s.length-lastLength)*0.3);lastLength=s.length;await Promise.resolve();time+=2000;inflight--;}});pacer.push('x'.repeat(300));pacer.finish();await pacer.run();assert.equal(peak,1);assert.ok(deltas.every(n=>n<=0.8+0.3+0.00001));
});
test('pacing: Unicode code points and split surrogate pairs are never cut in half',async()=>{
  assert.equal(advance('🌱',0,0.5,true).end,0);assert.equal(advance('🌱',0,0.6,true).end,2);let time=0;const frames=[];const pacer=new TextPacer({getRate:()=>50,signal:signal(),now:()=>time,sleep:async ms=>{time+=ms;if(!pacer.ended){pacer.push('\udf31中文');pacer.finish();}},onFrame:async text=>frames.push(text)});pacer.push('\ud83c');await pacer.run();assert.equal(frames.at(-1),'🌱中文');assert.ok(frames.every(s=>!/[\ud800-\udbff]$/.test(s)));
});
test('pacing: skip and unlimited drain full received text without waiting for token credits',async()=>{
  for(const mode of ['skip','unlimited']){const frames=[];const pacer=new TextPacer({getRate:()=>mode==='unlimited'?0:50,signal:signal(),sleep:async()=>assert.fail('no sleep needed'),onFrame:async s=>frames.push(s)});pacer.push('full text');pacer.finish();if(mode==='skip')pacer.skip();await pacer.run();assert.deepEqual(frames,['full text']);}
});
test('pacing: cancellation wakes both an empty queue and a queue waiting to display',async()=>{
  for(const hasText of [false,true]){const controller=new AbortController();const pacer=new TextPacer({getRate:()=>50,signal:controller.signal,onFrame:async()=>assert.fail('no late frame')});if(hasText)pacer.push('queued');const running=pacer.run();controller.abort();await assert.rejects(running,{name:'AbortError'});}
});
test('pacing UI: entire reply is received and retained before stopping slow local display',async()=>{
  const full='中文'.repeat(1000);const{plugin,doc,copies}=ui(async(k,m,s,d)=>{d(full);return{prompt_tokens:100,completion_tokens:1000,prompt_cache_hit_tokens:80,prompt_cache_miss_tokens:20};},async()=>'',{pacingRate:50});await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='question';const pending=view.send();await new Promise(setImmediate);
  assert.equal(plugin.session.messages[1].content,full);assert.equal(plugin.session.meter.tokens,1100);assert.ok(doc.querySelectorAll('.sd-body')[1].textContent.length<full.length);assert.ok(view.status.textContent.includes('回复已接收完毕'));assert.equal(doc.querySelector('[aria-label="立即显示"]'),null);doc.querySelectorAll('.sd-message-head button')[1].click();await Promise.resolve();assert.equal(copies.at(-1),full);assert.equal(view.sendButton.textContent,'停止');view.sendButton.click();await pending;assert.equal(view.sendButton.textContent,'发送');assert.equal(plugin.session.messages[1].content,full);await view.onClose();
});
test('pacing UI: clearing during local drain discards queue and cannot recreate messages',async()=>{
  const{plugin,doc}=ui(async(k,m,s,d)=>d('中文'.repeat(1000)),async()=>'',{pacingRate:50});await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='question';const pending=view.send();await new Promise(setImmediate);await view.clear();await pending;assert.equal(doc.querySelectorAll('.sd-message').length,0);assert.equal(plugin.session.messages.length,0);assert.equal(view.controller,null);await view.onClose();
});
test('pacing UI: closing mid-display retains all received text for reopening',async()=>{
  const full='中文'.repeat(1000);const{plugin,doc}=ui(async(k,m,s,d)=>d(full),async()=>'',{pacingRate:50});await plugin.onload();plugin.keys.deepseek='fake';let view=plugin.factory({});await view.onOpen();view.input.value='question';const pending=view.send();await new Promise(setImmediate);await view.onClose();await pending;assert.equal(plugin.session.entries[1].raw,full);view=plugin.factory({});await view.onOpen();assert.equal(doc.querySelectorAll('.sd-body')[1].textContent,full);await view.onClose();
});
test('pacing setting: default unlimited, selectable rate persists without conversation data',async()=>{
  const{plugin,doc,dom,saved}=ui(async()=>{},async()=> '');await plugin.onload();assert.equal(plugin.displayTokensPerSecond,0);const view=plugin.factory({});await view.onOpen();const select=doc.querySelector('input[type="range"]');select.value='100';select.dispatchEvent(new dom.window.Event('change'));await plugin.saveQueue;assert.equal(saved.at(-1).displayTokensPerSecond,100);assert.deepEqual(Object.keys(saved.at(-1)).sort(),['displayTokensPerSecond','model','reasoningEffort','uiLanguage','webEnabled']);const next=ui(async()=>{},async()=>'',{saved:saved.at(-1)});await next.plugin.onload();assert.equal(next.plugin.displayTokensPerSecond,100);await view.onClose();
});

test('smooth UI: speed shares actions and frame text does not call native renderer',async()=>{
 const {plugin,doc,renders}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();
 assert.ok(doc.querySelector('.sd-actions .sd-speed input[type="range"]'));assert.equal(doc.querySelectorAll('.simple-deepseek > .sd-speed').length,0);
 const row=view.row('DeepSeek');clearTimeout(row.timer);row.timer=null;row.streaming=true;
 const before=renders.length;
 for(let i=1;i<=80;i++)view.revealDelta(row,'中文');
 assert.equal(renders.length,before);assert.equal(row.body.textContent,'中文'.repeat(80));
 row.streaming=false;row.version++;await view.render(row);assert.equal(row.body.textContent,'中文'.repeat(80));await view.onClose();
});
test('smooth UI: native snapshot can finish while newer frame text stays visible',async()=>{
 let release;const {plugin}=ui(async()=>{},async()=>'',{render:async()=>new Promise(r=>release=r)});await plugin.onload();const view=plugin.factory({});await view.onOpen();
 const row=view.row('DeepSeek');clearTimeout(row.timer);row.timer=null;row.streaming=true;
 view.revealDelta(row,'first\n\nnext');const pending=view.render(row);await Promise.resolve();
 view.revealDelta(row,' added');release();await pending;
 assert.equal(row.body.textContent,'first\n\nnext added');assert.equal(row.tailText.data,' added');await view.onClose();
});
test('smooth pacing: 50 tokens/s releases small steps every animation-sized interval',async()=>{
 let time=0,last=0;const steps=[];const p=new TextPacer({getRate:()=>50,now:()=>time,sleep:async ms=>{assert.equal(ms,16);time+=ms;},signal:signal(),onFrame:text=>{steps.push(text.length-last);last=text.length;}});
 p.push('中'.repeat(50));p.finish();await p.run();assert.ok(steps.length>=30);assert.ok(steps.every(n=>n<=2));
});
test('incremental pacing sends only newly visible text instead of reallocating each full prefix',async()=>{
  const frames=[];let pacer;
  pacer=new TextPacer({incremental:true,getRate:()=>0,signal:signal(),onFrame:chunk=>{frames.push(chunk);if(frames.length===1)pacer.push(' world');else pacer.finish();}});
  pacer.push('hello');await pacer.run();assert.deepEqual(frames,['hello',' world']);
});
test('streaming Markdown snapshots are throttled to one second while text appears immediately',async()=>{
  const {plugin}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();
  const row=view.row('DeepSeek');clearTimeout(row.timer);row.timer=null;row.streaming=true;view.revealDelta(row,'visible now');
  assert.equal(row.body.textContent,'visible now');assert.equal(row.timer._idleTimeout,1000);
  await view.render(row);assert.equal(row.body.textContent,'visible now');await view.onClose();
});
test('long Markdown keeps identical chunk boundaries with linear-time token counting',async()=>{
  const text=(('α🙂abc').repeat(2500)+'\n\n').repeat(4)+'```text\n'+('x'.repeat(2000))+'\n```\n\n';
  const baseline=()=>{const lines=text.split(/(?<=\n)/),chunks=[];let current='',inFence=false,inMath=false;for(const line of lines){current+=line;if(/^\s*(?:`{3,}|~{3,})/.test(line))inFence=!inFence;if(!inFence&&(line.match(/\$\$/g)||[]).length%2)inMath=!inMath;if(!inFence&&!inMath&&/^\s*$/.test(line)&&ctx.estimateText(current)>=8000){chunks.push(current);current='';}}if(current)chunks.push(current);return chunks;};
  const {plugin,renders}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();const row=view.row('你',text);await view.render(row);
  assert.deepEqual(renders.map(item=>item.text),baseline());assert.equal(renders.map(item=>item.text).join(''),text);await view.onClose();
});
test('message token estimates stay exact when cached messages are edited during streaming',()=>{
  const message={role:'assistant',content:'a'.repeat(1000)};
  assert.equal(ctx.estimateMessages([message]),3+ctx.estimateText(message.content)+8);
  message.content+='中文';
  assert.equal(ctx.estimateMessages([message]),3+ctx.estimateText(message.content)+8);
});
test('local pacing can reduce frame cadence without changing configured tokens per second',async()=>{
  let time=0,frames=0,sleeps=0;
  const pacer=new TextPacer({frameMs:48,getRate:()=>50,now:()=>time,sleep:async ms=>{assert.equal(ms,48);time+=ms;sleeps++;},signal:signal(),onFrame:()=>{frames++;}});
  pacer.push('中'.repeat(50));pacer.finish();await pacer.run();
  assert.ok(frames>5&&frames<30);assert.ok(sleeps>=frames);
});

test('smooth UI: timed pacing updates text and stops promptly without animation-frame polling',async()=>{
 const {plugin,dom}=ui(async(k,m,s,d)=>d('中'.repeat(1000)),async()=>'',{pacingRate:50});let requested=0;
 dom.window.requestAnimationFrame=()=>{requested++;throw Error('animation frame polling is unnecessary');};
 await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='hello';const pending=view.send();await new Promise(r=>setTimeout(r,60));
 assert.ok([...view.rows].at(-1).body.textContent.length>0);assert.equal(requested,0);const stopped=Date.now();await view.clear();await pending;assert.ok(Date.now()-stopped<1000);await view.onClose();
});

test('stream tail: appends within final paragraph without a separate block',async()=>{
 const {plugin}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();
 const row=view.row('DeepSeek');clearTimeout(row.timer);row.timer=null;row.streaming=true;
 view.revealDelta(row,'hello');await view.render(row);view.revealDelta(row,' world');
 assert.equal(row.tail.tagName,'SPAN');assert.equal(row.tail.parentElement.tagName,'P');
 assert.equal(row.body.children.length,1);assert.equal(row.body.querySelector('p').textContent,'hello world');
 await view.render(row);assert.equal(row.body.textContent,'hello world');assert.equal(row.tail.parentElement.tagName,'P');await view.onClose();
});
test('stream tail: semantic endings keep text outside links and math internals',async()=>{
 const {plugin,doc}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();
 for(const [html,raw,selector] of [
  ['<p>text <a>link</a></p>','text [link](url)','p'],
  ['<p>text <span class="math"><mjx-container>x</mjx-container></span></p>','text $x$','p'],
  ['<ul><li>first</li><li><p>last</p></li></ul>','- first\n- last','li:last-child p'],
  ['<blockquote><p>quote</p></blockquote>','> quote','blockquote p'],
  ['<pre><code>code</code></pre>','~~~js\ncode','code'],
  ['<pre><code>code</code></pre>','~~~js\ncode\n~~~',null],
  ['<div class="math-block"><mjx-container>x</mjx-container></div>','$$x$$',null],
  ['<p>ended</p>','ended\n\n',null]
 ]){
  const stage=doc.createElement('div');stage.innerHTML=html;const tail=doc.createElement('span');tail.textContent='new';view.attachTail(stage,tail,raw);
  assert.equal(tail.parentElement,selector?stage.querySelector(selector):stage);
 }
 await view.onClose();
});

test('slider: linear integer speeds update live and far-right unlimited persists',async()=>{
 const {plugin,doc,dom,saved}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();const slider=doc.querySelector('input[type="range"]');
 assert.equal(slider.min,'20');assert.equal(slider.max,'301');assert.equal(slider.step,'1');
 for(const value of [20,21,73,110,199,200,299,300,301]){slider.value=String(value);slider.dispatchEvent(new dom.window.Event('input'));assert.equal(plugin.displayTokensPerSecond,value===301?0:value);assert.equal(slider.getAttribute('aria-valuetext'),value===301?'不限速':value+' t/s');}
 slider.dispatchEvent(new dom.window.Event('change'));await plugin.saveQueue;
 const restored=ui(async()=>{},async()=>'',{saved:saved.at(-1)});await restored.plugin.onload();assert.equal(restored.plugin.displayTokensPerSecond,0);
 for(const value of [20,73,200,300]){const env=ui(async()=>{},async()=>'',{saved:{displayTokensPerSecond:value}});await env.plugin.onload();assert.equal(env.plugin.displayTokensPerSecond,value);}
 await view.onClose();
});
test('copy: bottom button copies full received Markdown and survives reopen',async()=>{
 const {plugin,doc,copies}=ui(async()=>{},async()=> '');await plugin.onload();let view=plugin.factory({});await view.onOpen();
 const row=view.row('DeepSeek','visible');row.entry.raw='full **answer**';
 doc.querySelector('.sd-message-footer button').click();await Promise.resolve();assert.equal(copies.at(-1),'full **answer**');
 await view.onClose();view=plugin.factory({});await view.onOpen();doc.querySelector('.sd-message-footer button').click();await Promise.resolve();assert.equal(copies.at(-1),'full **answer**');await view.onClose();
});

test('model: editable name persists and reaches chat and compression requests',async()=>{
 const models=[];const {plugin,doc,dom,saved}=ui(async(k,m,s,d,h,o)=>{models.push(o.model);d('answer');return {prompt_tokens:10,completion_tokens:2};},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();plugin.keys.deepseek='fake';
 const input=doc.querySelector('.sd-model');input.value=' custom-model ';input.dispatchEvent(new dom.window.Event('change'));await plugin.saveQueue;assert.equal(saved.at(-1).model,'custom-model');
 view.input.value='hi';await view.send();plugin.session.meter={tokens:800000,count:plugin.session.messages.length,model:plugin.model,systemPrompt:ctx.SYSTEM_PROMPT};await view.compress('fake',signal());assert.deepEqual(models,['custom-model','custom-model']);
 const restored=ui(async()=>{},async()=>'',{saved:saved.at(-1)});await restored.plugin.onload();assert.equal(restored.plugin.model,'custom-model');await view.onClose();
});
test('model metadata pins per-turn limits, stays out of saved settings, and is reused for the next turn',async()=>{
  const requests=[];let release,lookups=0;
  const env=ui(async(_key,_messages,_signal,delta,_http,options)=>{requests.push(options);delta('answer');return{prompt_tokens:100,completion_tokens:2};},async()=>{}, {listModels:async()=>{lookups++;return new Promise(resolve=>release=()=>resolve({data:[{id:'model-a',context_window:32768,max_output_tokens:2048},{id:'model-b',context_window:65536,max_output_tokens:8192}]}));}});
  await env.plugin.onload();env.plugin.keys.deepseek='key';env.plugin.model='model-a';const view=env.plugin.factory({});await view.onOpen();
  view.input.value='First';const first=view.send();await new Promise(setImmediate);env.plugin.model='model-b';release();await first;
  assert.equal(requests[0].model,'model-a');assert.equal(requests[0].maxOutputTokens,2048);assert.equal(env.plugin.session.meter.model,'model-a');assert.match(view.metrics.textContent,/约/);
  view.input.value='Second';await view.send();assert.equal(requests[1].model,'model-b');assert.equal(requests[1].maxOutputTokens,8192);assert.equal(lookups,1);
  assert.ok(!JSON.stringify(env.saved).includes('context_window'));assert.equal(view.session.cache.measured,0);assert.equal(view.session.cache.unknown,2);
  await view.onClose();
});
test('stopping, clearing or closing during model discovery cannot send a later generation',async()=>{
  for(const action of ['stop','clear','close']){
    let release,calls=0;const env=ui(async()=>{calls++;},async()=>{}, {listModels:async()=>new Promise(resolve=>release=()=>resolve({data:[]}))});
    await env.plugin.onload();env.plugin.keys.deepseek='key';const view=env.plugin.factory({});await view.onOpen();view.input.value='Draft';
    const pending=view.send();await new Promise(setImmediate);
    if(action==='stop')view.controller.abort();else if(action==='clear')await view.clear();else await view.onClose();
    release();await pending;assert.equal(calls,0);assert.equal(view.messages.length,0);
    if(action==='stop')assert.equal(view.input.value,'Draft');
    if(action!=='close')await view.onClose();
  }
});
test('model-specific capacity rejects oversized drafts and caps forced compression output',async()=>{
  const requests=[];const env=ui(async(_key,_messages,_signal,delta,_http,options)=>{requests.push(options);delta('short checkpoint');return{completion_tokens:3};},async()=>{}, {listModels:async()=>({data:[{id:'small',context_window:32768,max_output_tokens:512}]})});
  await env.plugin.onload();env.plugin.keys.deepseek='key';env.plugin.model='small';const view=env.plugin.factory({});await view.onOpen();
  const draft='a'.repeat(110000);view.input.value=draft;await view.send();assert.equal(requests.length,0);assert.equal(view.input.value,draft);assert.match(view.status.textContent,/单次输入超过/);
  view.messages.push({role:'user',content:'Long text '.repeat(1000)});await view.manualCompress();assert.equal(requests.length,1);assert.equal(requests[0].maxOutputTokens,512);assert.equal(view.session.compactions,1);
  await view.onClose();
});
test('changing a model or system prompt invalidates another context meter without changing conversation history',()=>{
  const session={messages:[{role:'user',content:'Text'}],meter:{tokens:9000,count:1,estimated:false,model:'old',systemPrompt:ctx.SYSTEM_PROMPT}};
  const original=JSON.stringify(session.messages);assert.equal(ctx.contextTokens(session,{model:'old',systemPrompt:ctx.SYSTEM_PROMPT}),9000);
  assert.equal(ctx.contextTokens(session,{model:'new',systemPrompt:ctx.SYSTEM_PROMPT}),ctx.estimateMessages([{role:'system',content:ctx.SYSTEM_PROMPT},...session.messages]));assert.match(ctx.sessionStats(session,'en',{model:'new'}).text,/Context ~/);
  assert.ok(ctx.contextTokens(session,{model:'old',systemPrompt:'Different system'})<100);assert.equal(JSON.stringify(session.messages),original);
});
test('small supported windows retain usable space and unsupported reasoning effort preserves the draft',async()=>{
  const requests=[];const env=ui(async(_k,_m,_s,delta,_http,opts)=>{requests.push(opts);delta('OK');return{prompt_tokens:10,completion_tokens:1};},async()=>{}, {listModels:async()=>({data:[{id:'tiny',context_window:4096,max_output_tokens:256,effort:{supported_levels:['high'],default_level:'high'}}]})});
  await env.plugin.onload();env.plugin.model='tiny';env.plugin.keys.deepseek='key';const view=env.plugin.factory({});await view.onOpen();
  view.input.value='hi';await view.send();assert.equal(requests.length,0);assert.equal(view.input.value,'hi');assert.match(view.status.textContent,/不支持所选思考强度/);
  env.plugin.reasoningEffort='high';await view.send();assert.equal(requests.length,1);assert.equal(requests[0].maxOutputTokens,256);await view.onClose();
});
test('vision uses discovered Flash output limits independently of the chat model',async()=>{
  let visionOptions;const env=ui(async()=>{},async()=>{}, {listModels:async()=>({data:[{id:'deepseek-flash',context_window:32768,max_output_tokens:1024,input_modalities:['text','image']}]}),describeImage:async(_file,_key,_signal,_progress,_send,opts)=>{visionOptions=opts;return 'Image text';}});
  await env.plugin.onload();env.plugin.keys.deepseek='key';env.plugin.model='deepseek-v4-pro';const view=env.plugin.factory({});await view.onOpen();
  await view.upload({name:'figure.png',size:8,arrayBuffer:async()=>Buffer.from([137,80,78,71,13,10,26,10])});assert.equal(visionOptions,undefined);view.input.value='Read this';await view.send();assert.equal(visionOptions.maxOutputTokens,1024);assert.equal(env.plugin.model,'deepseek-v4-pro');await view.onClose();
});
test('vision reserves question and multi-image input before allocating output tokens',async()=>{
  let visionOptions,visionCalls=0;
  const env=ui(async(_k,_m,_s,onText)=>onText('Answer'),async()=>'',{listModels:async()=>({data:[{id:'deepseek-flash',context_window:5000,max_output_tokens:5000,input_modalities:['text','image']}]}),visionSend:async(_k,_m,_s,onText,_h,options)=>{visionOptions=options;visionCalls++;onText('Two plots.');}});
  await env.plugin.onload();env.plugin.keys.deepseek='key';const view=env.plugin.factory({});await view.onOpen();
  const png=value=>{const bytes=Buffer.from([137,80,78,71,13,10,26,10,value]);return{name:value+'.png',size:bytes.length,arrayBuffer:async()=>bytes};};
  await view.uploadFiles([png(1),png(2)]);view.input.value='Compare both curves.';await view.send();
  assert.equal(visionCalls,1);assert.ok(visionOptions.maxOutputTokens>0);assert.ok(visionOptions.maxOutputTokens<5000-250-2048);
  await view.upload(png(3));const draft='x'.repeat(30000);view.input.value=draft;await view.send();
  assert.equal(visionCalls,1);assert.equal(view.input.value,draft);assert.equal(view.pendingImages.length,1);assert.match(view.status.textContent,/上下文空间不足/);await view.onClose();
});
test('image-only archived questions retain their visible prefix and deduplicate when history is rebuilt',async()=>{
  const env=ui(async(_k,_m,_s,onText)=>onText('Answer'),async()=>'',{describeImage:async()=> 'ONE UNIQUE IMAGE DESCRIPTION'});
  await env.plugin.onload();env.plugin.keys.deepseek='key';const view=env.plugin.factory({});await view.onOpen();
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1]),image={name:'figure.png',size:bytes.length,arrayBuffer:async()=>bytes};
  await view.upload(image);await view.send();await view.upload(image);await view.send();
  const users=env.plugin.session.entries.filter(entry=>entry.label==='你');assert.equal(users.length,2);
  assert.ok(users.every(entry=>entry.contextText.startsWith(entry.raw)));
  const {rebuildEntryMessages}=require('./src/history');
  assert.equal((JSON.stringify(rebuildEntryMessages(env.plugin.session.entries)).match(/ONE UNIQUE IMAGE DESCRIPTION/g)||[]).length,1);
  assert.equal((JSON.stringify(rebuildEntryMessages(env.plugin.session.entries.slice(2))).match(/ONE UNIQUE IMAGE DESCRIPTION/g)||[]).length,1);await view.onClose();
});
test('model: core sends configured name',async()=>{
 await core.chat('fake',[],signal(),()=>{},async(url,opts)=>{assert.equal(JSON.parse(opts.body).model,'custom-model');opts.onChunk(Buffer.from(event('done')+stopEvent+'data: [DONE]\n\n'));},{model:'custom-model'});
});
test('thinking effort: low high max selector persists and reaches chat plus compression',async()=>{
 const efforts=[];const {plugin,doc,dom,saved}=ui(async(k,m,s,d,h,o)=>{efforts.push(o.reasoningEffort);d(efforts.length===1?'answer':'summary');return{prompt_tokens:10,completion_tokens:2};},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();const select=doc.querySelector('.sd-thinking-effort select');assert.deepEqual([...select.options].map(option=>option.value),['low','high','max']);assert.equal(select.value,'low');select.value='high';select.dispatchEvent(new dom.window.Event('change'));await plugin.saveQueue;assert.equal(saved.at(-1).reasoningEffort,'high');plugin.keys.deepseek='fake';view.input.value='question';await view.send();await view.manualCompress();assert.deepEqual(efforts,['high','high']);const next=ui(async()=>{},async()=>'',{saved:saved.at(-1)});await next.plugin.onload();assert.equal(next.plugin.reasoningEffort,'high');await view.onClose();
});

test('conversation archive: restart restores exact context, transcript and usage; clear removes its file',async()=>{
 const {plugin,saved,conversationState}=ui(async(k,m,s,d)=>{d('answer');return{prompt_tokens:100,completion_tokens:2,prompt_cache_hit_tokens:80,prompt_cache_miss_tokens:20};},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='hello';await view.send();
 const snapshot=saved.at(-1),archived=conversationState.get(plugin.activeConversationId).session;assert.deepEqual(archived.messages,JSON.parse(JSON.stringify(plugin.session.messages)));assert.equal(archived.entries[1].raw,'answer');assert.equal(snapshot.conversations,undefined);
 const next=ui(async()=>{},async()=>'',{saved:snapshot,conversationState,keyState:{...plugin.keys,libraryPath:plugin.libraryPath}});await next.plugin.onload();assert.deepEqual(JSON.parse(JSON.stringify(next.plugin.session)),archived);
 const reopened=next.plugin.factory({});await reopened.onOpen();await reopened.clear();await next.plugin.saveQueue;assert.equal(conversationState.size,0);assert.equal(next.keyState.deepseek,'fake');assert.equal(next.saved.at(-1).keys,undefined);await reopened.onClose();await view.onClose();
});
test('conversation archive: late stream cannot restore cleared log',async()=>{
 let release;const {plugin,saved,conversationState}=ui(async(k,m,s,d)=>{d('partial');await new Promise(r=>release=r);d('late');},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='hello';const pending=view.send();await new Promise(setImmediate);await plugin.saveSession();assert.equal(conversationState.get(plugin.activeConversationId).session.entries[1].raw,'partial');await view.clear();release();await pending;await plugin.saveQueue;assert.equal(conversationState.size,0);assert.equal(saved.at(-1).conversations,undefined);await view.onClose();
});
test('conversation archive: create, name, select, persist and delete multiple histories',async()=>{
 const calls=[];const {plugin,doc,saved,conversationState}=ui(async(k,m,s,d)=>{calls.push(m);d('answer '+m.at(-1).content);},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();
 view.input.value='Alpha question';await view.send();const first=plugin.activeConversationId;await view.newConversation();const second=plugin.activeConversationId;assert.notEqual(second,first);view.input.value='Beta question';await view.send();
 assert.equal(plugin.conversations.length,2);assert.deepEqual([...doc.querySelectorAll('.sd-history option')].map(option=>option.textContent),['Alpha question','Beta question']);
 await view.switchConversation(first);assert.equal(plugin.session.messages[0].content,'Alpha question');assert.ok(!view.feed.textContent.includes('Beta question'));assert.equal(calls.length,2);
 await plugin.saveSession();const snapshot=saved.at(-1);assert.equal(snapshot.conversations,undefined);assert.equal(snapshot.activeConversationId,first);assert.equal(conversationState.size,2);assert.ok(!JSON.stringify(snapshot).includes('libraryPath'));
 const restored=ui(async()=>{},async()=>'',{saved:snapshot,conversationState});await restored.plugin.onload();assert.equal(restored.plugin.conversations.length,2);assert.equal(restored.plugin.activeConversationId,first);const reopened=restored.plugin.factory({});await reopened.onOpen();await reopened.clear();await restored.plugin.saveQueue;assert.equal(restored.plugin.conversations.length,1);assert.equal(restored.plugin.session.messages[0].content,'Beta question');assert.equal(conversationState.size,1);assert.equal(restored.saved.at(-1).conversations,undefined);await reopened.onClose();await view.onClose();
});
test('conversation UI name is stored in shared settings and archived for recovery without changing its record id',async()=>{
 const {plugin,doc,dom,saved,conversationState}=ui(async()=>{},async()=>'',{saved:null});await plugin.onload();const view=plugin.factory({});await view.onOpen();const id=plugin.activeConversationId;
 view.renameConversationButton.click();const input=doc.querySelector('.sd-conversation-name-input');assert.ok(input);assert.equal(view.conversationSelect.hidden,true);
 input.value='Research notes';input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await plugin.saveQueue;
 assert.equal(view.conversationSelect.hidden,false);assert.equal(view.conversationSelect.selectedOptions[0].textContent,'Research notes');assert.equal(saved.at(-1).conversationNames[id],'Research notes');
 const record=conversationState.get(id);assert.equal(record.id,id);assert.equal(record.name,'Research notes');assert.deepEqual(Object.keys(record).sort(),['createdAt','id','name','session']);assert.equal(record.session.entries.length,0);
 const reopened=ui(async()=>{},async()=>'',{saved:saved.at(-1),conversationState});await reopened.plugin.onload();const next=reopened.plugin.factory({});await next.onOpen();assert.equal(next.conversationSelect.selectedOptions[0].textContent,'Research notes');
 await next.clear();await reopened.plugin.saveQueue;assert.equal(reopened.plugin.conversationNames[id],undefined);assert.equal(conversationState.has(id),false);await next.onClose();await view.onClose();
});

test('thinking SSE: reasoning and answer are delivered separately in order',async()=>{
 const seen=[];await core.chat('fake',[],signal(),s=>seen.push(['answer',s]),async(url,opts)=>{
 const body=JSON.parse(opts.body);assert.equal(body.reasoning_effort,'low');assert.equal(body.thinking.type,'enabled');
 for(const delta of [{reasoning_content:'思考'},{reasoning_content:'继续'},{content:'正文'}])opts.onChunk(Buffer.from('data: '+JSON.stringify({choices:[{delta}]})+'\n\n'));
 opts.onChunk(Buffer.from(stopEvent+'data: [DONE]\n\n'));
 },{onThinking:s=>seen.push(['thinking',s])});assert.deepEqual(seen,[['thinking','思考'],['thinking','继续'],['answer','正文']]);
});
test('thinking UI: starts collapsed, can close after opening, and persists separately',async()=>{
 let answerNow;const calls=[];const {plugin,doc,dom,saved,conversationState}=ui(async(k,m,s,d,h,o)=>{calls.push(m);o.onThinking('reasoning text');await new Promise(r=>answerNow=()=>{d('answer text');r();});return{prompt_tokens:100,completion_tokens:20};},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='question';const pending=view.send();await new Promise(setImmediate);
 const box=doc.querySelectorAll('.sd-thinking')[1];assert.equal(box.hidden,false);assert.equal(box.open,false);assert.equal(box.querySelector('.sd-thinking-body').textContent,'');box.open=true;box.dispatchEvent(new dom.window.Event('toggle'));await uiEventually(()=>box.querySelector('.sd-thinking-body').textContent==='reasoning text');box.open=false;box.dispatchEvent(new dom.window.Event('toggle'));assert.equal(box.querySelector('.sd-thinking-body').textContent,'');assert.equal(view.sendButton.textContent,'停止');
 answerNow();assert.equal(box.open,false);await pending;assert.equal(view.sendButton.textContent,'发送');assert.equal([...doc.querySelectorAll('.sd-actions button')].some(button=>button.textContent==='立即显示'||button.textContent==='停止'),false);assert.equal(plugin.session.messages[1].content,'answer text');assert.equal(plugin.session.entries[1].thinking,'reasoning text');assert.equal(plugin.session.meter.estimated,false);assert.equal(plugin.session.meter.tokens,120);assert.equal(plugin.session.messages[1].reasoning_content,'reasoning text');
 const next=ui(async()=>{},async()=>'',{saved:saved.at(-1),conversationState});await next.plugin.onload();const reopened=next.plugin.factory({});await reopened.onOpen();const restoredBox=next.doc.querySelectorAll('.sd-thinking')[1];assert.equal(restoredBox.open,false);assert.equal(next.doc.querySelectorAll('.sd-thinking-body')[1].textContent,'');restoredBox.open=true;restoredBox.dispatchEvent(new next.dom.window.Event('toggle'));await uiEventually(()=>restoredBox.querySelector('.sd-thinking-body').textContent==='reasoning text');await reopened.onClose();await view.onClose();
});
test('context meter includes reasoning tokens retained for tool-enabled requests',async()=>{
 const {plugin}=ui(async(k,m,s,d,h,o)=>{o.onThinking('private reasoning');d('visible answer');return{prompt_tokens:100,completion_tokens:20,completion_tokens_details:{reasoning_tokens:15}};},async()=> '');
 await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='question';await view.send();
 assert.deepEqual(JSON.parse(JSON.stringify(plugin.session.meter)),{tokens:120,count:2,estimated:false,model:plugin.model,systemPrompt:ctx.SYSTEM_PROMPT,includeReasoning:true});await view.onClose();
});
test('manual compression: below threshold, status only and no thinking or summary row',async()=>{
 let release;const {plugin,doc}=ui(async(k,m,s,d,h,o)=>{assert.equal(o.onThinking,undefined);d('short summary');await new Promise(r=>release=r);return{prompt_tokens:1000,completion_tokens:50000};},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();plugin.session.messages.push({role:'user',content:'long text '.repeat(500)});view.row('user','original');
 const pending=view.manualCompress();await new Promise(setImmediate);assert.equal(view.status.textContent,'正在压缩上下文');assert.equal(view.compressButton.disabled,true);assert.equal(doc.querySelectorAll('.sd-message').length,1);release();await pending;assert.equal(plugin.session.messages.length,1);assert.ok(plugin.session.messages[0].content.includes('short summary'));assert.equal(view.status.textContent,'');assert.equal(view.compressButton.disabled,false);assert.equal(doc.querySelectorAll('.sd-message').length,1);assert.ok(plugin.session.meter.tokens<1000);await view.onClose();
});
test('manual compression: stop preserves context and re-enables button',async()=>{
 const {plugin}=ui(async(k,m,s,d)=>{d('partial summary');await new Promise((r,reject)=>s.addEventListener('abort',()=>reject(Object.assign(Error('stop'),{name:'AbortError'})),{once:true}));},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();plugin.session.messages.push({role:'user',content:'original '.repeat(100)});const before=JSON.stringify(plugin.session.messages);const pending=view.manualCompress();await new Promise(setImmediate);assert.equal(view.sendButton.textContent,'停止');view.sendButton.click();await pending;assert.equal(view.sendButton.textContent,'发送');assert.equal(JSON.stringify(plugin.session.messages),before);assert.equal(view.compressButton.disabled,false);await view.onClose();
});

test('keys: plaintext shared settings are ignored; unavailable secure storage never persists keys',async()=>{
 const {plugin,saved,notices,conversationState}=ui(async()=>{},async()=>'',{noSecure:true,saved:{keys:{deepseek:'plaintext-secret',mineru:'plaintext-token'},libraryPath:'plaintext-path'}});await plugin.onload();assert.equal(plugin.keys.deepseek,'');assert.equal(plugin.libraryPath,'');plugin.keys.deepseek='memory-only-secret';plugin.libraryPath='memory-only-path';await assert.rejects(plugin.saveKeys());assert.ok(!JSON.stringify(saved).includes('memory-only'));assert.ok(notices.length);plugin.session.messages.push({role:'user',content:'chat'});await plugin.saveSession();assert.equal([...conversationState.values()][0].session.messages[0].content,'chat');assert.equal(saved.at(-1).conversations,undefined);assert.equal(saved.at(-1).keys,undefined);assert.equal(saved.at(-1).libraryPath,undefined);
});

test('reply navigation: skips user and attachment rows; follows previous/next and clears',async()=>{
 const {plugin,doc,dom}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();
 const a=view.row('model','a');view.row('你','question');view.row('MinerU · file','file');const b=view.row('model','b');const c=view.row('model','c');
 view.feed.getBoundingClientRect=()=>({top:0});for(const [state,y]of [[a,100],[b,500],[c,900]])state.element.getBoundingClientRect=()=>({top:y-view.feed.scrollTop});
 assert.ok(doc.querySelector('.sd-feed-shell > .sd-reply-nav'));view.feed.scrollTop=600;view.replyAnchor=null;
 doc.querySelector('[aria-label="上一条回复"]').click();assert.equal(view.feed.scrollTop,100);
 doc.querySelector('[aria-label="下一条回复"]').click();assert.equal(view.feed.scrollTop,500);view.jumpReply(1);assert.equal(view.feed.scrollTop,900);view.jumpReply(1);assert.equal(view.feed.scrollTop,900);
 view.feed.dispatchEvent(new dom.window.Event('wheel'));assert.equal(view.replyAnchor,null);Object.defineProperty(view.feed,'scrollHeight',{value:1500,configurable:true});doc.querySelector('[aria-label="置底"]').click();assert.equal(view.feed.scrollTop,1500);assert.equal(view.replyAnchor,null);assert.equal(doc.querySelectorAll('.sd-reply-nav button svg').length,3);await view.clear();view.jumpReply(-1);assert.equal(view.rows.size,0);await view.onClose();
});

test('@ UI: keyboard selection inserts id, sends extracted text, keeps references hidden including restored rows',async()=>{
 const library=require('./src/library');let received;const records=[{id:'2109.09723',aliases:[],title:'A paper',authors:'Bose'}];
 const {plugin,doc,dom}=ui(async(k,m,s,d)=>{received=m;d('answer');},async()=>'',{libraryApi:{...library,scanLibrary:async()=>records,expandMentions:async text=>text+'\n\nSOURCE MATERIAL'}});await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='Explain @2109';view.input.setSelectionRange(view.input.value.length,view.input.value.length);await view.updateMentions();assert.equal(view.mentionPopup.hidden,false);
 view.input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));assert.equal(view.input.value,'Explain @[2109.09723] ');assert.equal(received,undefined);await view.send();assert.ok(received.at(-1).content.includes('SOURCE MATERIAL'));assert.equal(plugin.session.entries[0].references,'SOURCE MATERIAL');assert.equal(doc.querySelector('.sd-references'),null);assert.ok(!view.feed.textContent.includes('SOURCE MATERIAL'));view.row('你',plugin.session.entries[0].raw,plugin.session.entries[0]);assert.ok(!view.feed.textContent.includes('SOURCE MATERIAL'));await view.onClose();
});
test('@ UI: unknown arXiv appears as import option; Escape cancels suggestion',async()=>{
 const library=require('./src/library');const {plugin,dom}=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'},libraryApi:{...library,scanLibrary:async()=>[]}});await plugin.onload();const view=plugin.factory({});await view.onOpen();view.input.value='@2608.12345';view.input.setSelectionRange(11,11);await view.updateMentions();assert.equal(view.mentionItems[0].id,'2608.12345');assert.match(view.mentionItems[0].title,/入库/);assert.match(view.mentionPopup.textContent,/Not in library · import on send/);plugin.uiLanguage='zh';view.refreshLanguage();assert.match(view.mentionPopup.textContent,/本地未收录 · 发送时下载入库/);view.input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape'}));assert.equal(view.mentionPopup.hidden,true);await view.onClose();
});

test('library setting: path is encrypted local state and never enters shared data',async()=>{
 const {plugin,doc,dom,saved,keyState}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();const input=doc.querySelector('.sd-library-path');assert.equal(input.value,'');assert.ok(input.closest('details'));assert.equal(plugin.libraryPath,'');input.value=' /my/library ';input.dispatchEvent(new dom.window.Event('change'));await plugin.saveQueue;assert.equal(keyState.libraryPath,'/my/library');assert.equal(saved.at(-1).libraryPath,undefined);assert.ok(!JSON.stringify(saved.at(-1)).includes('/my/library'));const next=ui(async()=>{},async()=>'',{saved:saved.at(-1),keyState});await next.plugin.onload();assert.equal(next.plugin.libraryPath,'/my/library');await view.onClose();
});

test('delete turn: icon-only copy, remove selected pair and hidden context, restore prompt with draft',async()=>{
 const {plugin,doc}=ui(async(k,m,s,d)=>d('answer '+m.at(-1).content),async()=>'',{libraryApi:{...require('./src/library'),expandMentions:async t=>t+'\n\nSECRET REFERENCE'}});await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='first @[2101.12345]';await view.send();view.input.value='second';await view.send();
 const copies=[...doc.querySelectorAll('.sd-message-head button,.sd-message-footer button:not(.sd-delete-turn)')];assert.ok(copies.every(b=>b.querySelector('svg')&&!b.textContent));assert.equal(doc.querySelectorAll('.sd-delete-turn').length,2);
 view.input.value='draft';await view.deleteTurn(plugin.session.entries[1]);assert.equal(view.input.value,'first @[2101.12345]\n\ndraft');assert.equal(plugin.session.entries.length,2);assert.equal(plugin.session.messages.length,2);assert.equal(plugin.session.messages[0].content,'second\n\nSECRET REFERENCE');assert.ok(!JSON.stringify(plugin.session.messages).includes('first'));assert.equal(doc.querySelectorAll('.sd-message').length,2);await view.onClose();
});
test('delete turn: removes stale compressed summary and survives saved-session reload',async()=>{
 const {plugin,saved,conversationState}=ui(async(k,m,s,d)=>d('answer'),async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='keep';await view.send();view.input.value='delete me';await view.send();plugin.session.messages.splice(0,4,{role:'user',content:'summary including delete me'});plugin.session.compactions=1;await view.deleteTurn(plugin.session.entries[3]);assert.deepEqual(JSON.parse(JSON.stringify(plugin.session.messages)),[{role:'user',content:'keep'},{role:'assistant',content:'answer',reasoning_content:''}]);assert.equal(plugin.session.compactions,0);await view.onClose();const next=ui(async()=>{},async()=>'',{saved:saved.at(-1),conversationState});await next.plugin.onload();assert.equal(next.plugin.session.entries.length,2);assert.ok(!JSON.stringify(next.plugin.session).includes('delete me'));
});
test('delete turn: ignored during generation and buttons reenable on completion',async()=>{
 let release;const {plugin,doc}=ui(async(k,m,s,d)=>{d('answer');await new Promise(r=>release=r);},async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='question';const pending=view.send();await new Promise(setImmediate);const button=doc.querySelector('.sd-delete-turn');assert.ok(button.disabled);await view.deleteTurn(plugin.session.entries[1]);assert.equal(plugin.session.entries.length,2);release();await pending;assert.ok(!button.disabled);await view.deleteTurn(plugin.session.entries[1]);assert.equal(plugin.session.messages.length,0);assert.equal(view.input.value,'question');await view.onClose();
});

test('delete turn: removing post-compression round preserves existing summary prefix',async()=>{
 const {plugin}=ui(async(k,m,s,d)=>d('answer'),async()=> '');await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();plugin.session.messages.push({role:'user',content:'previous summary'});plugin.session.compactions=1;view.input.value='new question';await view.send();await view.deleteTurn(plugin.session.entries[1]);assert.equal(plugin.session.messages.length,1);assert.equal(plugin.session.messages[0].content,'previous summary');assert.equal(plugin.session.compactions,1);await view.onClose();
});

test('dedup UI: repeated references omitted, changed content reattached, saved original hidden',async()=>{
 const lib=require('./src/library');let block='REFERENCE VERSION ONE';const sent=[];
 const {plugin,doc,saved,conversationState}=ui(async(k,m,s,d)=>{sent.push(m.map(x=>({...x})));d('answer');},async()=>'',{libraryApi:{...lib,expandMentions:async(t,r,k,s,n,p,o)=>{o.materials.push(block);return t+'\n\n'+block;}}});await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();
 view.input.value='first @[2101.12345]';await view.send();view.input.value='second @[2101.12345]';await view.send();assert.equal(sent[1].at(-1).content,'second @[2101.12345]');assert.ok(sent[1][1].content.includes(block));assert.ok(plugin.session.entries[2].contextText.includes(block));assert.ok(!doc.querySelector('.sd-references'));
 block='REFERENCE VERSION TWO';view.input.value='third @[2101.12345]';await view.send();assert.ok(sent[2].at(-1).content.includes(block));await view.onClose();const next=ui(async()=>{},async()=>'',{saved:saved.at(-1),conversationState});await next.plugin.onload();assert.equal(lib.deduplicateMentions('next',[block],next.plugin.session.messages),'next');
});
test('dedup UI: preflight compression reattaches reference without fetching twice',async()=>{
 const lib=require('./src/library');const block='FULL REFERENCE';let reads=0,last;
 const {plugin}=ui(async(k,m,s,d)=>{last=m;d('answer');},async()=>'',{libraryApi:{...lib,expandMentions:async(t,r,k,s,n,p,o)=>{reads++;o.materials.push(block);return t+'\n\n'+block;}}});await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();plugin.session.messages.push({role:'user',content:'old\n\n'+block});let compressed=false;view.compress=async()=>{if(!compressed){compressed=true;plugin.session.messages.splice(0,1,{role:'user',content:'summary'});return {}; }return null;};view.input.value='again';await view.send();assert.equal(reads,1);assert.ok(last.at(-1).content.includes(block));await view.onClose();
});
test('dedup UI: deleting original reference round restores needed text in remaining context',async()=>{
 const lib=require('./src/library');const block='FULL REFERENCE';const {plugin}=ui(async(k,m,s,d)=>d('answer'),async()=>'',{libraryApi:{...lib,expandMentions:async(t,r,k,s,n,p,o)=>{o.materials.push(block);return t+'\n\n'+block;}}});await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='first';await view.send();view.input.value='second';await view.send();assert.equal(plugin.session.messages[2].content,'second');await view.deleteTurn(plugin.session.entries[1]);assert.equal(plugin.session.messages[0].content,'second\n\n'+block);await view.onClose();
});

test('range picker: threshold, two endpoints and exact selected text',async()=>{
 const {plugin,doc,dom}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();const c=new AbortController();assert.equal(await view.selectTextRange('a'.repeat(333333),'small',c.signal),'a'.repeat(333333));assert.equal(doc.querySelector('.sd-range-picker'),null);
 const text='a'.repeat(360000),pending=view.selectTextRange(text,'long paper',c.signal);const start=doc.querySelector('.sd-range-start'),end=doc.querySelector('.sd-range-end');start.value='10000';start.dispatchEvent(new dom.window.Event('input'));end.value='20000';end.dispatchEvent(new dom.window.Event('input'));assert.ok(doc.querySelector('.sd-range-count').textContent.includes('3,000'));assert.ok(doc.querySelector('.sd-range-preview').textContent.length<1200);[...doc.querySelectorAll('.sd-range-actions button')].find(b=>b.textContent==='使用所选范围').click();assert.equal(await pending,text.slice(10000,20000));assert.equal(doc.querySelector('.sd-range-picker'),null);await view.onClose();
});
test('range picker: abort dismisses window, full reset and Unicode boundary preserved',async()=>{
 const {plugin,doc,dom}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();const c=new AbortController();const p=view.selectTextRange('😀'+'a'.repeat(360000),'unicode',c.signal);const start=doc.querySelector('.sd-range-start');start.value='1';start.dispatchEvent(new dom.window.Event('input'));assert.equal(start.value,'0');[...doc.querySelectorAll('.sd-range-actions button')].find(b=>b.textContent==='全文').click();assert.equal(doc.querySelector('.sd-range-end').value,'360002');c.abort();await assert.rejects(p,{name:'AbortError'});assert.equal(doc.querySelector('.sd-range-picker'),null);await view.onClose();
});
test('range picker: attachment only adds selected text to session after confirmation',async()=>{
 const {plugin,doc,dom}=ui(async()=>{},async()=> 'x'.repeat(360000));await plugin.onload();plugin.keys.mineru='fake';const view=plugin.factory({});await view.onOpen();const pending=view.upload({name:'long.pdf',size:10});await new Promise(setImmediate);assert.equal(plugin.session.messages.length,0);const end=doc.querySelector('.sd-range-end');end.value='100';end.dispatchEvent(new dom.window.Event('input'));[...doc.querySelectorAll('.sd-range-actions button')].find(b=>b.textContent==='使用所选范围').click();await pending;assert.equal(plugin.session.entries[0].raw,'x'.repeat(100));assert.ok(plugin.session.messages[0].content.endsWith('x'.repeat(100)));assert.ok(plugin.session.messages[0].content.length<300);await view.onClose();
});

test('outline: LaTeX hierarchy, starred/short/nested titles and ignored comments/code',()=>{
 const {texOutline,headingAt,mergeRanges}=require('./src/outline');const text='\\documentclass{article}\n% \\section{Fake}\n\\begin{verbatim}\\section{Code}\\end{verbatim}\n\\section[Short]{Real \\textbf{Title}}\nA\n\\subsection*{Child}\nB\n\\section{Next}\nC';const o=texOutline(text);assert.ok(o.reliable);assert.deepEqual(o.headings.map(h=>h.title),['Real Title','Child','Next']);assert.equal(o.headings[0].end,o.headings[2].start);assert.equal(headingAt(o.headings,text.indexOf('\nB')+1),'Real Title / Child');assert.equal(mergeRanges([o.headings[0],o.headings[1]]).length,1);
});
test('outline: dynamic or malformed LaTeX falls back while retaining known headings',()=>{
 const {texOutline}=require('./src/outline');for(const text of ['\\section{Good}\n\\input{missing}','\\newcommand{\\custom}[1]{\\section{#1}}\n\\section{Good}','\\section{Good}\n\\iftrue X\\fi','\\section{Good}\n\\section{Broken']){const o=texOutline(text);assert.equal(o.reliable,false);assert.ok(o.headings.some(h=>h.title==='Good'));}assert.equal(texOutline('No sections').reliable,false);
});
test('outline: Markdown ATX/setext heading paths ignore code and comments',()=>{
 const {markdownOutline,headingAt}=require('./src/outline');const text='# Top\nIntro\n```tex\n# Fake\n```\n<!--\n# Hidden\n-->\n## Child\nBody\nOther\n=====\nTail';const o=markdownOutline(text);assert.deepEqual(o.headings.map(h=>h.title),['Top','Child','Other']);assert.equal(headingAt(o.headings,text.indexOf('Body')),'Top / Child');assert.equal(headingAt(o.headings,text.indexOf('Tail')),'Other');
});
test('outline UI: parsed TeX uses checkboxes with token counts and deduplicated parent selection',async()=>{
 const {plugin,doc,dom}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();const text='\\section{One}\n'+'a'.repeat(180000)+'\n\\subsection{Child}\nCHILD\n\\section{Two}\n'+'b'.repeat(180000);const pending=view.selectTextRange(text,'paper',new AbortController().signal,'tex');assert.ok(doc.querySelector('.sd-range-track').hidden);assert.ok(!doc.querySelector('.sd-outline-list').hidden);assert.equal(doc.querySelectorAll('.sd-outline-item').length,3);assert.ok(doc.querySelector('.sd-outline-tokens').textContent.includes('tokens'));const two=doc.querySelector('input[aria-label="Two"]');two.checked=false;two.dispatchEvent(new dom.window.Event('change'));assert.equal(doc.querySelector('.sd-range-preview'),null);[...doc.querySelectorAll('.sd-range-actions button')].find(b=>b.textContent==='使用所选范围').click();const result=await pending;assert.equal(result.split('[Included reference text]\n\n')[1],text.slice(0,text.indexOf('\\section{Two}')));assert.ok(result.includes('Two (body omitted'));assert.equal(result.split('CHILD').length,2);await view.onClose();
});
test('generated TeX preamble heading follows the interface language without translating source headings',async()=>{
 const {plugin,doc}=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await plugin.onload();const view=plugin.factory({});await view.onOpen();
 const controller=new AbortController(),text='Preamble text\n\\section{思考过程}\n'+'a'.repeat(360000);
 const pending=view.selectTextRange(text,'paper',controller.signal,'tex');
 const headings=[...doc.querySelectorAll('.sd-outline-heading')];
 assert.equal(headings[0].textContent,'Preamble / introduction');assert.equal(headings[1].textContent,'思考过程');
 plugin.uiLanguage='zh';view.refreshLanguage();assert.equal(headings[0].textContent,'前言 / 导言区');assert.equal(headings[1].textContent,'思考过程');
 controller.abort();await assert.rejects(pending);await view.onClose();
});
test('outline UI: Markdown sliders show both endpoint headings and broken TeX falls back',async()=>{
 const {plugin,doc,dom}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();const text='# First\n'+'a'.repeat(180000)+'\n# Last\n'+'b'.repeat(180000);const c=new AbortController(),pending=view.selectTextRange(text,'md',c.signal,'md');assert.ok(!doc.querySelector('.sd-range-track').hidden);assert.ok(doc.querySelector('.sd-range-preview').textContent.includes('起点所在标题：First'));assert.ok(doc.querySelector('.sd-range-preview').textContent.includes('终点所在标题：Last'));c.abort();await assert.rejects(pending);const c2=new AbortController(),p2=view.selectTextRange('\\section{Known}\n'+'x'.repeat(360000)+'\\input{missing}','tex',c2.signal,'tex');assert.ok(!doc.querySelector('.sd-range-track').hidden);assert.ok(doc.querySelector('.sd-range-preview').textContent.includes('Known'));c2.abort();await assert.rejects(p2);await view.onClose();
});

test('outline context: short TeX includes background chapters without showing picker; md stays unchanged',async()=>{
 const {plugin,doc}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();const text='\\section{Intro}\nINTRO\n\\subsection{Detail}\nDETAIL';const result=await view.selectTextRange(text,'paper',new AbortController().signal,'tex');assert.ok(result.includes('Reference outline'));assert.ok(result.includes('Intro (full text included'));assert.ok(result.endsWith(text));assert.equal(doc.querySelector('.sd-range-picker'),null);assert.ok(!view.feed.textContent.includes('Reference outline'));assert.equal(await view.selectTextRange('# Intro\nMD','md',new AbortController().signal,'md'),'# Intro\nMD');await view.onClose();
});
test('outline context: describes partial selection and omitted body without leaking unselected text',()=>{
 const {texOutline,withOutlineContext}=require('./src/outline');const text='\\section{One}\nSECRET ONE\n\\section{Two}\nSELECT TWO';const parsed=texOutline(text),range={start:parsed.headings[1].start,end:text.length};const result=withOutlineContext(text,text.slice(range.start),[range],parsed);assert.ok(result.includes('One (body omitted'));assert.ok(result.includes('Two (full text included'));assert.ok(!result.includes('SECRET ONE'));assert.ok(result.includes('Included ranges'));assert.equal(withOutlineContext(text,text.slice(range.start),[range],parsed),result);
});

test('outline: skips literal disabled iffalse block without losing later sections or source positions',()=>{
 const {texOutline}=require('./src/outline');const text='\\section{Before}\n\\iffalse\n{ unbalanced discarded braces\n\\section{Hidden}\n\\ifnum 1=2 \\section{Nested}\\fi\n\\fi\n\\section{After}\nTEXT';const o=texOutline(text);assert.ok(o.reliable);assert.deepEqual(o.headings.map(h=>h.title),['Before','After']);assert.equal(o.headings[1].start,text.indexOf('\\section{After}'));
});
test('outline: conditional alternatives or incomplete disabled blocks still fall back',()=>{
 const {texOutline}=require('./src/outline');for(const tail of ['\\iffalse Hidden','\\iffalse Hidden\\else Visible\\fi','\\iffalse \\ifcustom Hidden\\fi\\fi'])assert.equal(texOutline('\\section{Known}\n'+tail).reliable,false);
});

test('outline UI: select all and clear selection update all checkboxes and confirm availability',async()=>{
 const {plugin,doc}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();const c=new AbortController();const pending=view.selectTextRange('\\section{One}\n'+'a'.repeat(180000)+'\\subsection{Child}\n'+'b'.repeat(180000),'tex',c.signal,'tex');const buttons=[...doc.querySelectorAll('.sd-range-actions button')],confirm=buttons.find(b=>b.textContent==='使用所选范围');buttons.find(b=>b.textContent==='全不选').click();assert.ok(confirm.disabled);assert.ok([...doc.querySelectorAll('.sd-outline-item input')].every(b=>!b.checked&&!b.indeterminate));assert.ok(doc.querySelector('.sd-range-count').textContent.includes('已选约 0'));buttons.find(b=>b.textContent==='全选').click();assert.ok(!confirm.disabled);assert.ok([...doc.querySelectorAll('.sd-outline-item input')].every(b=>b.checked));assert.equal(doc.querySelector('.sd-range-preview'),null);c.abort();await assert.rejects(pending);await view.onClose();
});

test('first-release UI defaults to English and switches language without changing conversation data',async()=>{
 const {plugin,doc,dom,saved}=ui(async()=>{},async()=>'',{saved:null});await plugin.onload();assert.equal(plugin.uiLanguage,'en');assert.equal(plugin.displayTokensPerSecond,0);assert.equal(plugin.reasoningEffort,'low');
 const view=plugin.factory({});await view.onOpen();assert.equal(doc.querySelector('details > summary').textContent,'Keys and model settings');assert.equal(view.sendButton.textContent,'Send');assert.equal(view.runAllButton.textContent,'Run all');
 const language=doc.querySelector('.sd-language-select');plugin.session.messages.push({role:'user',content:'原文保持不变'});language.value='zh';language.dispatchEvent(new dom.window.Event('change'));await plugin.saveQueue;
 assert.equal(view.sendButton.textContent,'发送');assert.equal(plugin.session.messages[0].content,'原文保持不变');assert.equal(saved.at(-1).uiLanguage,'zh');
 language.value='en';language.dispatchEvent(new dom.window.Event('change'));await plugin.saveQueue;assert.equal(view.sendButton.textContent,'Send');assert.equal(plugin.session.messages[0].content,'原文保持不变');await view.onClose();
});

test('English default has no untranslated Chinese in its initial controls',async()=>{
 const {plugin,doc}=ui(async()=>{},async()=>'',{saved:null});await plugin.onload();const view=plugin.factory({});await view.onOpen();
 const walker=doc.createTreeWalker(view.contentEl,doc.defaultView.NodeFilter.SHOW_TEXT);const untranslated=[];
 while(walker.nextNode()){const node=walker.currentNode;if(node.parentElement.closest('.sd-language-select,.sd-body,.sd-thinking-body,.sd-notebook-cell-body'))continue;if(/[\u3400-\u9fff]/.test(node.data))untranslated.push(node.data.trim());}
 assert.deepEqual(untranslated,[]);await view.onClose();
});

test('English status and range controls remain localized during interaction',async()=>{
 const {plugin,doc}=ui(async()=>{},async()=>'',{saved:null});await plugin.onload();const view=plugin.factory({});await view.onOpen();
 view.input.value='hello';await view.send();await Promise.resolve();assert.equal(view.status.textContent,'Enter a DeepSeek API key first');
 view.toggleNotebookMode();await view.connectNotebook();await Promise.resolve();assert.equal(view.notebookStatus.textContent,'Enter the Jupyter executable and Notebook paths in settings');
 const controller=new AbortController(),pending=view.selectTextRange('x'.repeat(360000),'sample',controller.signal,'md');await Promise.resolve();
 const walker=doc.createTreeWalker(view.contentEl,doc.defaultView.NodeFilter.SHOW_TEXT);const untranslated=[];
 while(walker.nextNode()){const node=walker.currentNode;if(node.parentElement.closest('.sd-language-select,.sd-body,.sd-thinking-body,.sd-notebook-cell-body,.sd-range-preview-text'))continue;if(/[\u3400-\u9fff]/.test(node.data))untranslated.push(node.data.trim());}
 controller.abort();await assert.rejects(pending);assert.deepEqual(untranslated,[]);await view.onClose();
});

test('completed reply keeps measured generation speed after reopening',async()=>{
 const {plugin,doc,conversationState}=ui(async(k,m,s,d)=>{d('answer');return{prompt_tokens:100,completion_tokens:50,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:100};},async()=>'',{saved:null});await plugin.onload();plugin.keys.deepseek='fake';let view=plugin.factory({});await view.onOpen();view.input.value='hello';await view.send();
 const entry=plugin.session.entries[1];assert.equal(entry.usage.completion_tokens,50);assert.ok(entry.durationMs>0);assert.match(doc.querySelectorAll('.sd-usage')[1].textContent,/tokens\/s/);await view.onClose();
 view=plugin.factory({});await view.onOpen();assert.match(doc.querySelectorAll('.sd-usage')[1].textContent,/tokens\/s/);assert.ok(conversationState.size);await view.onClose();
});

test('language switching never translates a Chinese user message or model reply',async()=>{
 const answer='高质量回答：复制原句。';const {plugin,doc,dom}=ui(async(k,m,s,d)=>{d(answer);return{prompt_tokens:10,completion_tokens:5};},async()=>'',{saved:null});await plugin.onload();plugin.keys.deepseek='fake';const view=plugin.factory({});await view.onOpen();view.input.value='请保留中文';await view.send();
 for(const row of view.rows) await view.render(row);const bodies=doc.querySelectorAll('.sd-body');assert.equal(bodies[0].textContent,'请保留中文');assert.equal(bodies[1].textContent,answer);
 const language=doc.querySelector('.sd-language-select');language.value='zh';language.dispatchEvent(new dom.window.Event('change'));language.value='en';language.dispatchEvent(new dom.window.Event('change'));await Promise.resolve();
 assert.equal(bodies[0].textContent,'请保留中文');assert.equal(bodies[1].textContent,answer);await view.onClose();
});
test('English interface preserves user-authored Notebook previews and paper headings',async()=>{
 const {plugin,doc}=ui(async()=>{},async()=>'',{saved:null});await plugin.onload();const view=plugin.factory({});await view.onOpen();
 view.notebookPreview.open=true;view.renderNotebookPreview({cells:[{id:'one',cell_type:'code',source:'思考过程',outputs:[]}]});await Promise.resolve();
 assert.match(doc.querySelector('.sd-notebook-cell-summary').textContent,/思考过程/);
 const controller=new AbortController(),pending=view.selectTextRange('\\section{思考过程}\n'+'x'.repeat(360000),'paper',controller.signal,'tex');await Promise.resolve();
 assert.equal(doc.querySelector('.sd-outline-heading').textContent,'思考过程');
 controller.abort();await assert.rejects(pending);await view.onClose();
});

test('collapsed live Notebook preview reads no cell text or outputs and schedules no preview timer',async()=>{
  const api=require('./src/notebook');let sources=0,outputs=0,projections=0;const notebook={cells:Array.from({length:100},(_,index)=>({id:'cell-'+index,cell_type:'code',get source(){sources++;return'print('+index+')\n';},get outputs(){outputs++;return[];}}))};
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'},notebookApi:{...api,safeNotebook:value=>{projections++;return api.safeNotebook(value);}}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();view.notebookClient={read:()=>notebook,close(){}};view.notebookPreview.hidden=false;
  for(let index=0;index<20;index++)view.scheduleNotebookPreview(notebook);
  assert.equal(view.notebookPreview.open,false);assert.equal(sources,0);assert.equal(outputs,0);assert.equal(projections,0);assert.equal(view.notebookPreviewTimer,null);assert.equal(view.notebookPreviewBody.childNodes.length,0);assert.equal(view.notebookPreviewCells.size,0);assert.match(view.notebookPreviewTitle.textContent,/100 cells/);
  view.notebookPreview.open=true;await new Promise(resolve=>setTimeout(resolve,0));assert.equal(projections,1);assert.equal(sources,100);assert.equal(outputs,100);assert.equal(view.notebookPreviewBody.querySelectorAll('details').length,100);assert.equal(view.notebookPreviewBody.querySelector('details').open,true);
  await view.onClose();assert.equal(view.notebookPreviewCells.size,0);assert.equal(view.notebookPreviewOpenIds.size,0);assert.equal(view.notebookPreviewToggleListener,null);
});

test('live Notebook preview reuses cell and source nodes through output edits moves and deliberate collapse',async()=>{
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();const notebook={cells:[{id:'first',cell_type:'code',source:'value = 1\nprint(value)',execution_count:1,outputs:[{output_type:'stream',name:'stdout',text:'1\n'}]},{id:'second',cell_type:'markdown',source:'# Original',outputs:[]},{id:'third',cell_type:'raw',source:'plain',outputs:[]}]};
  view.notebookPreview.hidden=false;view.renderNotebookPreview(notebook);view.notebookPreview.open=true;await new Promise(resolve=>setTimeout(resolve,0));const first=view.notebookPreviewCells.get('first'),second=view.notebookPreviewCells.get('second'),source=first.sourceNode,sourceText=source.firstChild,output=first.outputNodes[0];view.notebookPreviewBody.scrollTop=60;
  notebook.cells[0].execution_count=2;notebook.cells[0].outputs[0].text='2\n';notebook.cells[1].source='# Updated';view.renderNotebookPreview(notebook);
  assert.equal(view.notebookPreviewCells.get('first'),first);assert.equal(first.sourceNode,source);assert.equal(source.firstChild,sourceText);assert.equal(first.outputNodes[0],output);assert.equal(output.textContent,'2\n');assert.equal(view.notebookPreviewCells.get('second'),second);assert.equal(second.body.childNodes.length,0);assert.match(second.summary.textContent,/# Updated/);
  notebook.cells=[notebook.cells[2],notebook.cells[0],notebook.cells[1]];view.renderNotebookPreview(notebook);assert.deepEqual([...view.notebookPreviewBody.querySelectorAll('details')].map(node=>node.dataset.cellId),['third','first','second']);assert.equal(first.sourceNode,source);assert.match(first.summary.textContent,/^2\. code \[2\]/);assert.equal(view.notebookPreviewBody.scrollTop,60);
  first.item.open=false;first.item.dispatchEvent(new env.dom.window.Event('toggle'));view.renderNotebookPreview(notebook);assert.equal(first.item.open,false);assert.equal(first.body.childNodes.length,0);assert.equal(view.notebookPreviewBody.querySelector('details[open]'),null);
  view.notebookPreview.open=false;await new Promise(resolve=>setTimeout(resolve,0));assert.equal(view.notebookPreviewBody.childNodes.length,0);assert.equal(view.notebookPreviewCells.size,0);view.notebookPreview.open=true;await new Promise(resolve=>setTimeout(resolve,0));assert.equal(view.notebookPreviewBody.querySelector('details[open]'),null);await view.onClose();
});

test('live Notebook preview defers selected source changes and collapse then applies only the latest filtered state',async()=>{
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();let notebook={cells:[{id:'one',cell_type:'code',source:'selected original\nnext',outputs:[]}]};view.notebookClient={read:()=>notebook,close(){}};view.notebookPreview.hidden=false;view.renderNotebookPreview(notebook);view.notebookPreview.open=true;await new Promise(resolve=>setTimeout(resolve,0));const state=view.notebookPreviewCells.get('one'),pre=state.sourceNode,range=env.doc.createRange(),selection=env.doc.getSelection();range.setStart(pre.firstChild,0);range.setEnd(pre.firstChild,8);selection.addRange(range);
  notebook={cells:[{id:'one',cell_type:'code',source:'intermediate\n',outputs:[]}]};view.renderNotebookPreview(notebook);notebook={cells:[{id:'one',cell_type:'code',source:'final text\nimage = "data:image/png;base64,QUJDRA=="',outputs:[{output_type:'display_data',data:{'text/plain':'safe result','image/png':'A'.repeat(1000)}}]}]};view.renderNotebookPreview(notebook);
  assert.equal(view.notebookPreviewSelectionDeferred,true);assert.equal(state.sourceNode,pre);assert.equal(selection.toString(),'selected');assert.equal(pre.textContent,'selected original\nnext');selection.removeAllRanges();env.doc.dispatchEvent(new env.dom.window.Event('selectionchange'));
  assert.equal(view.notebookPreviewCells.get('one'),state);assert.equal(state.sourceNode,pre);assert.match(pre.textContent,/final text/);assert.ok(!view.notebookPreviewBody.textContent.includes('intermediate'));assert.ok(!view.notebookPreviewBody.textContent.includes('data:image/'));assert.ok(!view.notebookPreviewBody.textContent.includes('image/png'));assert.match(view.notebookPreviewBody.textContent,/safe result/);
  const selected=env.doc.createRange();selected.setStart(pre.firstChild,0);selected.setEnd(pre.firstChild,5);selection.addRange(selected);view.scheduleNotebookPreview(notebook);assert.ok(view.notebookPreviewTimer);view.notebookPreview.open=false;view.notebookPreview.dispatchEvent(new env.dom.window.Event('toggle'));assert.equal(view.notebookPreviewTimer,null);assert.equal(view.notebookPreviewCells.size,1);assert.equal(selection.toString(),'final');selection.removeAllRanges();env.doc.dispatchEvent(new env.dom.window.Event('selectionchange'));assert.equal(view.notebookPreviewCells.size,0);assert.equal(view.notebookPreviewBody.childNodes.length,0);await view.onClose();
});

test('live Notebook preview disconnect releases selected DOM cell listeners and cached state',async()=>{
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();const notebook={cells:[{id:'one',cell_type:'code',source:'selected source',outputs:[]}]};let closes=0;view.notebookClient={read:()=>notebook,close(){closes++;}};view.notebookPreview.hidden=false;view.renderNotebookPreview(notebook);view.notebookPreview.open=true;await new Promise(resolve=>setTimeout(resolve,0));const state=view.notebookPreviewCells.get('one'),range=env.doc.createRange(),selection=env.doc.getSelection();range.selectNodeContents(state.sourceNode);selection.addRange(range);view.notebookPreview.open=false;view.notebookPreview.dispatchEvent(new env.dom.window.Event('toggle'));assert.equal(view.notebookPreviewSelectionDeferred,true);
  await view.disconnectNotebook();assert.equal(closes,1);assert.equal(view.notebookLatest,null);assert.equal(view.notebookPreviewCells.size,0);assert.equal(view.notebookPreviewOpenIds.size,0);assert.equal(view.notebookPreviewBody.childNodes.length,0);assert.equal(view.notebookPreviewSelectionDeferred,false);assert.equal(view.notebookPreviewInitialized,false);state.item.open=true;state.item.dispatchEvent(new env.dom.window.Event('toggle'));view.scheduleNotebookPreview(notebook);assert.equal(view.notebookLatest,null);assert.equal(view.notebookPreviewTimer,null);selection.removeAllRanges();env.doc.dispatchEvent(new env.dom.window.Event('selectionchange'));assert.equal(view.notebookPreviewBody.childNodes.length,0);await view.onClose();assert.equal(closes,1);
});
test('range UI: separate endpoint panes retain titles and independent text previews',async()=>{
 const {plugin,doc}=ui(async()=>{},async()=> '');await plugin.onload();const view=plugin.factory({});await view.onOpen();const c=new AbortController();const pending=view.selectTextRange('# First\n'+'a'.repeat(360000)+'\n# Last\nEND','md',c.signal);const panes=doc.querySelectorAll('.sd-range-preview-pane');assert.equal(panes.length,2);assert.ok(panes[0].querySelector('.sd-range-preview-title').textContent.includes('First'));assert.ok(panes[1].querySelector('.sd-range-preview-title').textContent.includes('Last'));assert.ok(panes[1].querySelector('pre').textContent.endsWith('END'));c.abort();await assert.rejects(pending);await view.onClose();
});

const functionCall = (id,name,args) => ({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
test('web UI: explicit URL references work without a library path, hide body and retain it across deletion',async()=>{
  const requests=[],sent=[];
  const env=ui(async(k,m,s,d)=>{sent.push(JSON.parse(JSON.stringify(m)));d('A supported answer.');return {prompt_tokens:100,completion_tokens:5};},async()=>'',{webHttp:async(url,options)=>{requests.push({url,options});return Buffer.from(JSON.stringify({title:'Reference page',content:'# UNIQUE WEB BODY\nUseful detail.'}));}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();
  view.input.value='Read @[https://example.com/reference]';await view.send();
  assert.match(sent[0].at(-1).content,/UNIQUE WEB BODY/);assert.ok(!env.doc.querySelector('.sd-message .sd-body').textContent.includes('UNIQUE WEB BODY'));
  const sourceBox=env.doc.querySelector('.sd-sources:not([hidden])');assert.equal(sourceBox.open,false);assert.equal(sourceBox.querySelectorAll('a').length,0);assert.match(sourceBox.querySelector('summary').textContent,/1/);sourceBox.open=true;sourceBox.dispatchEvent(new env.dom.window.Event('toggle'));assert.match(sourceBox.textContent,/Reference page/);assert.equal(requests[0].url,'https://api.deepseek.com/v1/tools/fetch');
  view.input.value='Again @[https://example.com/reference]';await view.send();assert.ok(!sent[1].at(-1).content.includes('UNIQUE WEB BODY'));assert.match(sent[1].at(-1).content,/\[Web reference metadata\]/);const metadata=JSON.parse(sent[1].at(-1).content.split('[Web reference metadata]\n')[1]);assert.equal(metadata.url,'https://example.com/reference');assert.match(metadata.retrieved_at,/^\d{4}-\d{2}-\d{2}T/);
  assert.match(env.plugin.session.entries[2].contextText,/UNIQUE WEB BODY/);
  await view.deleteTurn(env.plugin.session.entries[1]);assert.match(env.plugin.session.messages[0].content,/UNIQUE WEB BODY/);await view.onClose();
});

test('web UI: autonomous search and fetch preserve full tool history and count each request once',async()=>{
  let step=0;const sent=[];
  const env=ui(async(k,m,s,d,h,o)=>{
    sent.push(JSON.parse(JSON.stringify(m)));o.onThinking('reason '+step);
    if(step===0)o.onToolCalls([functionCall('search-1','search_web',{query:'reference documentation'})]);
    else if(step===1)o.onToolCalls([functionCall('fetch-1','fetch_page',{url:'https://example.com/reference'})]);
    else d('Result with a source.');step++;
    return {prompt_tokens:100*step,completion_tokens:10,prompt_cache_hit_tokens:50,prompt_cache_miss_tokens:100*step-50};
  },async()=>'',{webHttp:async(url)=>Buffer.from(JSON.stringify(url.endsWith('/search')?{results:[{url:'https://example.com/reference',title:'Reference',summary:'Relevant summary'}]}:{title:'Reference',content:'Fresh full page text'}))});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='Look up the documentation';await view.send();
  assert.equal(step,3);assert.equal(sent[1][2].tool_calls[0].id,'search-1');assert.equal(sent[1][2].reasoning_content,'reason 0');assert.equal(sent[1][3].tool_call_id,'search-1');
  assert.equal(env.plugin.session.cache.measured,3);assert.equal(env.plugin.session.cache.hit,150);assert.equal(env.plugin.session.meter.tokens,310);
  const journal=env.plugin.session.entries[1].modelMessages;assert.equal(journal.filter(m=>m.role==='tool').length,2);
  await view.onClose();const restored=ui(async()=>{},async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState});await restored.plugin.onload();assert.deepEqual(restored.plugin.session.messages,JSON.parse(JSON.stringify(env.plugin.session.messages)));
  const reopened=restored.plugin.factory({});await reopened.onOpen();await reopened.deleteTurn(restored.plugin.session.entries[1]);assert.equal(restored.plugin.session.messages.length,0);await reopened.onClose();
});

test('web UI: preflight compression reattaches previously deduplicated original and reuses one fetch',async()=>{
  let fetches=0,generations=0;const sent=[];
  const env=ui(async(k,m,s,d,h,o)=>{if(o.tools){sent.push(JSON.parse(JSON.stringify(m)));d('answer');generations++;return {prompt_tokens:100,completion_tokens:2};}d('compact checkpoint');return {prompt_tokens:800000,completion_tokens:5};},async()=>'',{webHttp:async()=>{fetches++;return Buffer.from(JSON.stringify({title:'Page',content:'ORIGINAL WEB DETAILS '.repeat(20)}));}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='@[https://example.com/ref] first';await view.send();
  env.plugin.session.meter={tokens:800000,count:env.plugin.session.messages.length,model:env.plugin.model,systemPrompt:ctx.SYSTEM_PROMPT};
  view.input.value='@[https://example.com/ref] second';await view.send();assert.equal(generations,2);assert.equal(fetches,2);assert.match(sent[1].at(-1).content,/ORIGINAL WEB DETAILS/);assert.equal(env.plugin.session.compactions,1);await view.onClose();
});

test('Notebook staged batches require confirmation, send a compact receipt and do not echo applied code next turn',async()=>{
  const notebookApi=require('./src/notebook');let actual={nbformat:4,nbformat_minor:5,metadata:{},cells:[{id:'calc',cell_type:'code',metadata:{},source:'rate = 0.1\nprint(rate)',outputs:[],execution_count:null}]};
  let step=0,applied=0;const sent=[];
  const env=ui(async(k,m,s,d,h,o)=>{
    sent.push(JSON.parse(JSON.stringify(m)));
    if(step===0)o.onToolCalls([functionCall('edit-1','stage_notebook_edits',{baseHash:notebookApi.notebookHash(actual),operations:[{type:'replace_text',cellId:'calc',oldText:'0.1',newText:'0.01'}],done:false})]);
    else if(step===1){const status=JSON.parse(m.at(-1).content);o.onToolCalls([functionCall('edit-2','stage_notebook_edits',{baseHash:status.currentHash,operations:[{type:'insert_cell',cellId:'notes',cellType:'markdown',source:'Ready for review.'}],done:true})]);}
    else d('Prepared changes.');step++;return {prompt_tokens:100,completion_tokens:10};
  },async()=> '');await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookPanel.hidden=false;
  view.notebookClient={read:()=>structuredClone(actual),applyPatch:async patch=>{applied++;actual=notebookApi.validatePatch(actual,patch).notebook;return structuredClone(actual);},close(){}};
  view.input.value='Change the rate and add a note';await view.send();assert.equal(actual.cells.length,1);assert.equal(applied,0);
  const entry=env.plugin.session.entries[1];assert.equal(entry.notebookPatch.operations.length,2);assert.equal(entry.modelMessages.filter(m=>m.role==='tool').length,2);const change=env.doc.querySelector('.sd-notebook-patch-operation[data-operation="replace_text"]');assert.ok(change);assert.deepEqual([...change.querySelectorAll('code')].map(node=>node.textContent),['0.1','0.01']);
  const button=env.doc.querySelector('.sd-notebook-apply');button.click();await new Promise(setImmediate);env.doc.querySelector('.sd-confirm .mod-cta').click();await new Promise(setImmediate);await new Promise(setImmediate);
  assert.equal(applied,1);assert.equal(actual.cells[0].source,'rate = 0.01\nprint(rate)');assert.match(env.plugin.session.messages.at(-1).content,/Notebook edits applied/);assert.ok(!env.plugin.session.messages.at(-1).content.includes('print(rate)'));assert.equal(view.notebookSnapshot.hash,notebookApi.notebookHash(actual));
  view.input.value='Explain the result';await view.send();const newest=sent.at(-1).at(-1).content;assert.match(newest,/"changed":\[\]/);assert.ok(!newest.includes('print(rate)'));
  await view.deleteTurn(entry);assert.ok(!env.plugin.session.messages.some(m=>m.content.startsWith('[Notebook edits applied]')));assert.equal(view.notebookSnapshot,null);await view.onClose();
});

test('old Notebook apply actions are disabled during a tool-enabled reply',async()=>{
  let release,applied=0;const env=ui(async(k,m,s,d)=>{await new Promise(resolve=>release=resolve);d('done');},async()=> '');await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();
  view.row('你','earlier');const row=view.row('AI','```notebook-patch\n'+JSON.stringify({baseHash:'a'.repeat(64),operations:[]})+'\n```');await view.render(row);view.notebookClient={applyPatch:async()=>{applied++;},read:()=>({cells:[]}),close(){}};
  const button=env.doc.querySelector('.sd-notebook-apply');view.input.value='New question';const pending=view.send();await new Promise(setImmediate);assert.equal(button.disabled,true);button.click();assert.equal(applied,0);release();await pending;assert.equal(button.disabled,false);await view.onClose();
});

test('clearing while web fetch is pending cannot populate the new conversation or issue a generation',async()=>{
  let resolveFetch,generations=0;const env=ui(async()=>{generations++;},async()=>'',{webHttp:()=>new Promise(resolve=>resolveFetch=resolve)});await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();
  view.input.value='@[https://example.com/reference]';const pending=view.send();await new Promise(setImmediate);const clearing=view.clear();await new Promise(setImmediate);env.doc.querySelector('.sd-confirm .mod-cta')?.click();await clearing;resolveFetch(Buffer.from('{"title":"Late","content":"late body"}'));await pending;
  assert.equal(generations,0);assert.equal(env.plugin.session.messages.length,0);assert.equal(env.plugin.session.entries.length,0);assert.equal(env.plugin.session.meter,null);await view.onClose();
});

test('reopening an interrupted tool request appends paired unknown results and keeps them after rebuilding',async()=>{
  const call=functionCall('unfinished-call','fetch_page',{url:'https://example.com/reference'}),assistant={role:'assistant',content:'Reading.',reasoning_content:'Need page.',tool_calls:[call]};
  const id='conversation-interruptedtools',session={messages:[{role:'user',content:'Question'},assistant],entries:[{label:'你',raw:'Question'},{label:'deepseek-flash',raw:'Reading.',modelMessages:[assistant]}],meter:null,compactions:0,cache:null};
  const state=new Map([[id,{id,createdAt:1,session}]]);const env=ui(async()=>{},async()=>'',{conversationState:state});await env.plugin.onload();
  assert.equal(env.plugin.session.messages.at(-1).role,'tool');assert.equal(env.plugin.session.messages.at(-1).tool_call_id,'unfinished-call');assert.equal(JSON.parse(env.plugin.session.messages.at(-1).content).executed,null);
  assert.equal(env.plugin.session.entries[1].modelMessages.at(-1).role,'tool');const view=env.plugin.factory({});await view.onOpen();await view.deleteTurn(env.plugin.session.entries[1]);assert.equal(env.plugin.session.messages.length,0);await view.onClose();
});

test('compression sends original tool history and refuses to replace it after an in-flight argument change',async()=>{
  const calls=[functionCall('original-call','fetch_page',{url:'https://example.com/reference'})];
  const session={messages:[{role:'user',content:'Goal'},{role:'assistant',content:'',reasoning_content:'Reasoning',tool_calls:calls},{role:'tool',tool_call_id:'original-call',content:'reference '.repeat(1000)}],compactions:0,meter:null};
  const before=structuredClone(session.messages);
  await assert.rejects(ctx.compactContext(session,'fake',signal(),()=>{},async(k,m,s,d)=>{assert.deepEqual(m.slice(1,-2),before);session.messages[1].tool_calls[0].function.arguments='{"url":"https://example.com/changed"}';d('A short summary');return{prompt_tokens:1000,completion_tokens:5};},0,true),/会话已变化/);
  assert.equal(session.messages.length,3);assert.equal(session.messages[1].reasoning_content,'Reasoning');assert.equal(session.compactions,0);
});

test('confirmed Notebook application locks conversation actions until the verified receipt is saved',async()=>{
  let complete,generations=0;const notebook={nbformat:4,nbformat_minor:5,metadata:{},cells:[]};
  const env=ui(async()=>{generations++;},async()=> '');await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();
  view.row('你','Edit');const state=view.row('AI','Prepared');state.entry.notebookPatch={baseHash:require('./src/notebook').notebookHash(notebook),operations:[]};state.version++;await view.render(state);
  view.notebookClient={read:()=>structuredClone(notebook),applyPatch:()=>new Promise(resolve=>complete=()=>resolve(structuredClone(notebook))),close(){}};
  env.doc.querySelector('.sd-notebook-apply').click();await new Promise(setImmediate);env.doc.querySelector('.sd-confirm .mod-cta').click();await new Promise(setImmediate);
  const active=env.plugin.activeConversationId;assert.equal(view.applyingNotebookPatch,true);assert.equal(view.clearButton.disabled,true);assert.equal(view.conversationSelect.disabled,true);
  await view.newConversation();await view.clear();view.input.value='Keep this draft';await view.send();assert.equal(generations,0);assert.equal(env.plugin.activeConversationId,active);assert.equal(view.input.value,'Keep this draft');
  complete();await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(view.applyingNotebookPatch,false);assert.equal(view.clearButton.disabled,false);assert.equal(env.plugin.session.messages.at(-1).role,'user');assert.ok(state.entry.replyId);await view.onClose();
});

test('source labels escape webpage markup instead of allowing it to load an image',async()=>{
  const env=ui(async(k,m,s,d)=>d('Answer.'),async()=>'',{webHttp:async()=>Buffer.from(JSON.stringify({title:'<img src="https://example.com/image">\n`unsafe`',content:'Text source'}))});await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='@[https://example.com/ref]';await view.send();
  const sourceBox=env.doc.querySelector('.sd-sources:not([hidden])');assert.equal(sourceBox.open,false);sourceBox.open=true;sourceBox.dispatchEvent(new env.dom.window.Event('toggle'));assert.match(sourceBox.querySelector('a').textContent,/<img/);assert.match(sourceBox.querySelector('a').textContent,/`unsafe`/);assert.equal(env.doc.querySelectorAll('.sd-sources-body img').length,0);assert.ok(!env.renders.some(render=>render.text.includes('unsafe')));await view.onClose();
});

test('arXiv URL mentions retain the existing library route instead of being fetched as generic web pages',async()=>{
  let expandedText='';const original='Read @[https://arxiv.org/abs/2601.12345]';
  const libraryApi={...require('./src/library'),expandMentions:async text=>{expandedText=text;return text+'\n\nARXIV SOURCE';}};
  const env=ui(async(k,m,s,d)=>{assert.match(m.at(-1).content,/ARXIV SOURCE/);d('Answer');},async()=>'',{libraryApi,webHttp:async()=>assert.fail('arXiv remains a library reference')});await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value=original;await view.send();assert.equal(expandedText,original);await view.onClose();
});

test('Search Fetch checkbox stays in the action bar, defaults on, and persists its disabled state',async()=>{
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  const checkbox=env.doc.querySelector('.sd-web-toggle input');assert.equal(checkbox.checked,true);assert.equal(checkbox.closest('.sd-actions')!==null,true);assert.equal(checkbox.getAttribute('aria-label'),'Enable Search / Fetch');
  checkbox.checked=false;checkbox.dispatchEvent(new env.dom.window.Event('change'));await env.plugin.saveSession();assert.equal(env.saved.at(-1).webEnabled,false);await view.onClose();
  const next=ui(async()=>{},async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState});await next.plugin.onload();const reopened=next.plugin.factory({});await reopened.onOpen();assert.equal(reopened.searchFetchToggle.checked,false);await reopened.onClose();
});

test('disabled Search Fetch treats public and private explicit URLs as plain text without any web call',async()=>{
  const sent=[];const env=ui(async(k,m,s,d,h,o)=>{sent.push({messages:JSON.parse(JSON.stringify(m)),tools:o.tools});o.onThinking('Not retained as subsequent input');d('Use available context.');return{prompt_tokens:100,completion_tokens:20,completion_tokens_details:{reasoning_tokens:15}};},async()=>'',{saved:{uiLanguage:'en',webEnabled:false},webHttp:async()=>assert.fail('web must be disabled')});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='Read @[http://localhost:8888/test] and @[https://example.com/page]';await view.send();
  assert.deepEqual(sent[0].tools,[]);assert.match(sent[0].messages.at(-1).content,/http:\/\/localhost:8888\/test/);assert.ok(!sent[0].messages.at(-1).content.includes('@['));assert.equal(env.plugin.session.meter.tokens,105);assert.equal(env.plugin.session.meter.includeReasoning,false);
  view.input.value='Follow up';await view.send();assert.ok(!JSON.stringify(sent[1].messages).includes('Not retained as subsequent input'));assert.equal(env.plugin.session.entries[1].thinking,'Not retained as subsequent input');await view.onClose();
});

test('a web toggle change during generation applies to the next message, not the active tool turn',async()=>{
  let release;const modes=[];const env=ui(async(k,m,s,d,h,o)=>{modes.push(o.tools.map(tool=>tool.function.name));if(modes.length===1)await new Promise(resolve=>release=resolve);d('Answer');return{prompt_tokens:10,completion_tokens:2};},async()=> '');
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='First';const pending=view.send();await new Promise(setImmediate);view.searchFetchToggle.checked=false;view.searchFetchToggle.dispatchEvent(new env.dom.window.Event('change'));release();await pending;
  assert.ok(modes[0].includes('search_web'));view.input.value='Second';await view.send();assert.deepEqual(modes[1],[]);await view.onClose();
});

test('reported weather pseudo-call is visibly unexecuted while raw text, thinking and exact usage survive reopening',async()=>{
  const text='<tool_call>\n{"name": "search_web", "arguments": {"query": "Denver weather today current temperature forecast"}}\n</tool_call>';
  const reported={prompt_tokens:87,completion_tokens:103,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:87,total_tokens:190,completion_tokens_details:{reasoning_tokens:69}};
  const env=ui(async(k,m,s,d,h,o)=>{assert.deepEqual(o.tools,[]);assert.doesNotMatch(m[0].content,/search_web|fetch_page|stage_notebook_edits|native tool/);o.onThinking('Need current weather.');d(text);return reported;},async()=>'',{saved:{uiLanguage:'en',webEnabled:false},webHttp:async()=>assert.fail('Search Fetch is off')});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value="How's the weather like in Mile high?";await view.send();
  const entry=env.plugin.session.entries[1];assert.equal(entry.raw,text);assert.equal(entry.modelMessages[0].content,text);assert.equal(entry.toolProtocolError,'web_disabled');assert.equal(env.plugin.session.meter.tokens,121);assert.equal(env.plugin.session.cache.measured,1);
  const displayed=env.doc.querySelectorAll('.sd-body')[1].textContent;assert.match(displayed,/Search \/ Fetch is off/);assert.match(displayed,/not executed/);assert.ok(!displayed.includes('<tool_call>'));assert.ok(!/[\u4e00-\u9fff]/.test(displayed));
  await view.onClose();const next=ui(async()=>{},async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState});await next.plugin.onload();const reopened=next.plugin.factory({});await reopened.onOpen();assert.equal(next.plugin.session.entries[1].raw,text);assert.match(next.doc.querySelectorAll('.sd-body')[1].textContent,/not executed/);await reopened.onClose();
});

test('Notebook mode with no attached content does not advertise absent editing tools',async()=>{
  const env=ui(async(k,m,s,d,h,o)=>{assert.deepEqual(o.tools,[]);assert.doesNotMatch(m[0].content,/search_web|fetch_page|stage_notebook_edits|read_notebook|notebook-patch/);d('A normal Notebook discussion.');return{prompt_tokens:30,completion_tokens:5};},async()=>'',{saved:{uiLanguage:'en',webEnabled:false}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookAttach.value='none';view.input.value='Explain a Python loop';await view.send();assert.equal(env.plugin.session.entries[1].raw,'A normal Notebook discussion.');assert.equal(env.plugin.session.meter.systemPrompt,view.requestPrompt());await view.onClose();
});

const reportedDsml='<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="search_web">\n<｜｜DSML｜｜ parameter name="query" string="true">Washington DC current weather forecast today</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="count" string="false">5</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="need_content" string="false">true</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
test('ordinary chat recovers an unavailable Notebook call and preserves its closed record after reopening',async()=>{
  let requests=0,externalCalls=0;
  const oldCall={id:'prior-notebook',type:'function',function:{name:'stage_notebook_edits',arguments:'{"done":true,"operations":[]}'}};
  const oldMessages=[{role:'user',content:'Edit the notebook.'},{role:'assistant',content:'',reasoning_content:'Earlier reasoning.',tool_calls:[oldCall]},
    {role:'tool',content:'{"status":"staged_for_review","done":true,"applied":false}',tool_call_id:oldCall.id},{role:'assistant',content:'Edits await review.'}];
  const pendingCall={id:'unavailable-read',type:'function',function:{name:'read_notebook',arguments:'{}'}};
  const final='Here is code:\n\n```python\nprint(1 + 1)\n```';
  const http=async(_url,options)=>{
    const request=JSON.parse(options.body),first=requests++===0;
    assert.deepEqual(request.tools.map(tool=>tool.function.name),['search_web','fetch_page']);
    assert.equal(JSON.stringify(request.messages.slice(1,5)),JSON.stringify(oldMessages));
    if(first) options.onChunk(Buffer.from('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'Inspect the earlier notebook.',tool_calls:[{index:0,...pendingCall}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:10,prompt_cache_hit_tokens:60,prompt_cache_miss_tokens:40}})+'\n\n'));
    else {
      assert.deepEqual(request.messages.find(message=>message.tool_calls?.some(call=>call.id===pendingCall.id)).tool_calls,[pendingCall]);
      const result=JSON.parse(request.messages.find(message=>message.tool_call_id===pendingCall.id).content);
      assert.equal(result.executed,false);assert.deepEqual(result.availableTools,['search_web','fetch_page']);
      options.onChunk(Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:final},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:20,prompt_cache_hit_tokens:150,prompt_cache_miss_tokens:50}})+'\n\n'));
    }
    options.onChunk(Buffer.from('data: [DONE]\n\n'));
  };
  const env=ui((key,messages,signal,onText,_http,options)=>core.chat(key,messages,signal,onText,http,options),async()=>'',
    {saved:{uiLanguage:'en',webEnabled:true},webHttp:async()=>{externalCalls++;assert.fail('The rejected batch must never execute');}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();
  const prior=view.row('deepseek-flash','Edits await review.');prior.entry.modelMessages=structuredClone(oldMessages);
  view.messages.push(...structuredClone(oldMessages));view.input.value='Write some code.';await view.send();
  assert.equal(requests,2,view.status.textContent);assert.equal(externalCalls,0);assert.equal(!!view.notebookMode,false);assert.equal(!!view.notebookClient,false);
  assert.equal(JSON.stringify(view.messages.slice(0,4)),JSON.stringify(oldMessages));
  const entry=view.session.entries.at(-1);assert.equal(entry.raw,final);assert.equal(entry.thinking,'Inspect the earlier notebook.');
  assert.equal(entry.failedRequests.length,1);assert.deepEqual(JSON.parse(JSON.stringify(entry.failedRequests[0].rejectedToolCalls)),[pendingCall]);
  assert.equal(entry.failedRequests[0].unfinishedToolCalls,undefined);assert.equal(entry.usage.prompt_tokens,300);assert.equal(entry.usage.completion_tokens,30);
  assert.deepEqual(Array.from(entry.modelMessages.filter(message=>message.role==='tool'),message=>message.tool_call_id),[pendingCall.id]);
  assert.match(env.doc.querySelectorAll('.sd-body')[2].textContent,/print\(1 \+ 1\)/);assert.equal(view.status.textContent,'');
  await view.onClose();
  const next=ui(async()=>assert.fail('Reopening cannot request a model'),async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState});
  await next.plugin.onload();const reopened=next.plugin.factory({});await reopened.onOpen();
  const restored=next.plugin.session.entries.at(-1);assert.equal(JSON.stringify(restored.failedRequests),JSON.stringify(entry.failedRequests));
  assert.deepEqual(JSON.parse(JSON.stringify(restored.modelMessages)),JSON.parse(JSON.stringify(entry.modelMessages)));assert.equal(restored.raw,final);
  assert.match(next.doc.querySelectorAll('.sd-body')[2].textContent,/print\(1 \+ 1\)/);await reopened.onClose();
});

test('unavailable tool recovery and terminal messages support both interface languages',()=>{
  const {translate}=require('./src/i18n');
  for(const text of ['模型请求了本次未提供的工具，未执行任何工具','本次工具调用包含未提供的工具，整批未执行；请仅使用当前可用工具，或直接回答',
    '模型调用了本次未提供的工具，正在按当前可用范围继续…','模型反复调用本次未提供的工具，已停止自动继续；这些工具未执行']) {
    assert.equal(translate(text,'zh'),text);assert.doesNotMatch(translate(text,'en'),/[\u3400-\u9fff]/);
  }
});

test('reported DSML leak is recovered through a native call, hidden on screen and preserved verbatim after reopening',async()=>{
  let step=0,webCalls=0;const final='The source is a dated snapshot; current conditions could not be verified.';
  const env=ui(async(k,m,s,d,h,o)=>{
    if(step===0){for(const character of reportedDsml)d(character);}
    else if(step===1){assert.equal(m[2].content,reportedDsml);assert.match(m[3].content,/not executed/);o.onToolCalls([functionCall('native-recovery','search_web',{query:'Washington DC weather',count:1,need_content:true})]);}
    else {const result=JSON.parse(m.at(-1).content);assert.equal(result.results[0].date,'2026-03-28T07:53:55-04:00');assert.equal(result.results[0].text_kind,'content');assert.match(result.retrieved_at,/^\d{4}-/);d(final);}
    step++;return {prompt_tokens:100*step,completion_tokens:10,prompt_cache_hit_tokens:10,prompt_cache_miss_tokens:100*step-10};
  },async()=>'',{saved:{uiLanguage:'en',webEnabled:true},webHttp:async()=>{webCalls++;return Buffer.from(JSON.stringify({results:[{url:'https://example.com/forecast',title:'Dated forecast',content:'Published 2026-03-28. Old observations.',date:'2026-03-28T07:53:55-04:00'}]}));}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='what about dc';await view.send();
  assert.equal(step,3);assert.equal(webCalls,1);const entry=env.plugin.session.entries[1];assert.equal(entry.raw,reportedDsml+final);assert.equal(entry.displayText,final);assert.equal(entry.modelMessages[0].content,reportedDsml);assert.equal(entry.toolProtocolError,undefined);assert.equal(env.plugin.session.cache.measured,3);assert.equal(entry.usage.prompt_tokens,600);
  const body=env.doc.querySelectorAll('.sd-body')[1].textContent;assert.match(body,/current conditions could not be verified/);assert.ok(!body.includes('DSML'));assert.match(env.doc.querySelector('.sd-sources:not([hidden]) summary').textContent,/Retrieved pages/);assert.equal(env.doc.querySelector('.sd-sources:not([hidden])').open,false);assert.ok(entry.protocolRecovery.some(event=>event.recovered));assert.ok(entry.requestCapabilities.tools.includes('search_web'));
  await view.onClose();const next=ui(async()=>{},async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState});await next.plugin.onload();const reopened=next.plugin.factory({});await reopened.onOpen();assert.equal(next.plugin.session.entries[1].raw,reportedDsml+final);assert.equal(next.plugin.session.entries[1].displayText,final);assert.ok(!next.doc.querySelectorAll('.sd-body')[1].textContent.includes('DSML'));await reopened.onClose();
});

test('repeated DSML stops after one correction, without searching or losing either original response',async()=>{
  let requests=0;const env=ui(async(k,m,s,d)=>{requests++;d(reportedDsml);return{prompt_tokens:100,completion_tokens:10};},async()=>'',{saved:{uiLanguage:'en',webEnabled:true},webHttp:async()=>assert.fail('leaked text cannot execute')});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='Current DC weather';await view.send();assert.equal(requests,2);const entry=env.plugin.session.entries[1];assert.equal(entry.raw,reportedDsml+reportedDsml);assert.equal(entry.toolProtocolError,'invalid_tool_protocol');assert.equal(env.plugin.session.cache.unknown,2);assert.ok(!env.doc.querySelectorAll('.sd-body')[1].textContent.includes('DSML'));assert.match(env.doc.querySelectorAll('.sd-body')[1].textContent,/not executed/);await view.onClose();
});

test('each new human turn supplies trusted request time without changing any earlier message prefix',async()=>{
  let now=Date.UTC(2026,9,17,14,14,10),calls=0;const sent=[];const timeContext=require('./src/request-context').requestTimeContext;
  const env=ui(async(k,m,s,d)=>{sent.push(JSON.parse(JSON.stringify(m)));const user=m.at(-1).content,metadata=JSON.parse(user.split('[Request context]\n')[1]);assert.equal(metadata.local_date,'2026-10-17');assert.equal(metadata.time_zone,'Asia/Shanghai');assert.equal(metadata.current_time,new Date(now).toISOString());d('Answer '+(++calls));return{prompt_tokens:100,completion_tokens:5};},async()=>'',{saved:{uiLanguage:'en',webEnabled:false},requestTimeContext:()=>timeContext({now,timeZone:'Asia/Shanghai'})});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='What is the current date?';await view.send();const before=JSON.stringify(env.plugin.session.messages);now+=60000;view.input.value='And now?';await view.send();assert.deepEqual(sent[1].slice(0,sent[0].length),sent[0]);assert.equal(JSON.stringify(env.plugin.session.messages.slice(0,2)),before);assert.ok(env.plugin.session.entries[0].contextText.includes('[Request context]'));await view.render([...view.rows].find(row=>row.entry===env.plugin.session.entries[0]));assert.equal(env.doc.querySelector('.sd-body').textContent,'What is the current date?');assert.equal((env.plugin.session.messages[2].content.match(/\[Request context\]/g)||[]).length,1);await view.onClose();
});

test('cancelling before a leaked protocol response finishes keeps raw data but never reveals it after reopening',async()=>{
  const partial=reportedDsml.slice(0,125);let requests=0;
  const env=ui(async(k,m,s,d)=>{requests++;d(partial);await new Promise((resolve,reject)=>s.addEventListener('abort',()=>reject(Object.assign(Error('stopped'),{name:'AbortError'})),{once:true}));},async()=>'',{saved:{uiLanguage:'en',webEnabled:true}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='Current DC weather';const pending=view.send();await new Promise(setImmediate);view.sendButton.click();await pending;const entry=env.plugin.session.entries[1];assert.equal(requests,1);assert.equal(entry.raw,partial);assert.equal(entry.displayText,'');await view.onClose();
  const next=ui(async()=>{},async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState});await next.plugin.onload();const reopened=next.plugin.factory({});await reopened.onOpen();assert.equal(next.plugin.session.entries[1].raw,partial);assert.ok(!next.doc.querySelectorAll('.sd-body')[1].textContent.includes('DSML'));await reopened.onClose();
});

function attachedImage(name='figure.png',suffix=0){const bytes=Buffer.from([137,80,78,71,13,10,26,10,suffix]);return{name,size:bytes.length,arrayBuffer:async()=>bytes};}

test('images stage without a key, deduplicate by content, support removal and image-only Send',async()=>{
  let visions=0,generations=0;
  const env=ui(async(k,m,s,d)=>{generations++;d('Overview');},async()=>'',{visionSend:async(k,m,s,d)=>{visions++;assert.match(m[0].content[0].text,/Describe the attached images/);d('A labelled diagram.');}});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();view.input.value='Keep draft';
  await view.uploadFiles([attachedImage('first.png'),attachedImage('renamed.png')]);assert.equal(view.pendingImages.length,1);assert.equal(view.images.metadata().length,1);assert.equal(view.session.messages.length,0);assert.equal(visions,0);assert.equal(view.input.value,'Keep draft');
  const removed=view.pendingImages[0].id;view.pendingImageList.querySelector('button').click();assert.equal(view.pendingImages.length,0);assert.equal(view.images.get(removed),undefined);assert.equal(view.input.value,'Keep draft');
  await view.upload(attachedImage('image-only.png'));env.plugin.keys.deepseek='fake';view.input.value='';await view.send();assert.equal(visions,1);assert.equal(generations,1);assert.equal(view.pendingImages.length,0);assert.equal(view.session.entries[0].raw,'image-only.png');assert.equal(view.session.entries[0].images.length,1);await view.onClose();
});

test('multiple images share the current question in one vision request independently of Search Fetch',async()=>{
  const requests=[];let seen;
  const env=ui(async(k,m,s,d,h,o)=>{seen=JSON.parse(JSON.stringify(m));assert.deepEqual(o.tools.map(tool=>tool.function.name),['read_image']);d('The second curve is steeper.');},async()=>'',{saved:{uiLanguage:'en',webEnabled:false},visionSend:async(k,m,s,d)=>{requests.push(m);d('Image 1 rises slowly; Image 2 rises quickly.');}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();await view.uploadFiles([attachedImage('before.png',1),attachedImage('after.png',2)]);view.input.value='Compare the slopes';await view.send();
  assert.equal(requests.length,1);const content=requests[0][0].content;assert.match(content[0].text,/Compare the slopes/);assert.match(content[0].text,/before\.png/);assert.match(content[0].text,/after\.png/);assert.equal(content.filter(part=>part.type==='image_url').length,2);assert.ok(content.filter(part=>part.type==='image_url').every(part=>part.image_url.detail==='original'));
  assert.ok(seen.every(message=>typeof message.content==='string'));assert.ok(JSON.stringify(seen).includes('Image 2 rises quickly'));assert.ok(!JSON.stringify(seen).includes('base64,'));assert.ok(!view.feed.textContent.includes('Image 1 rises slowly'));
  await env.plugin.saveQueue;const archive=JSON.stringify([...env.conversationState.values()]);assert.ok(!archive.includes('base64,'));assert.ok(!archive.includes('"type":"Buffer"'));assert.equal(view.session.entries[0].images.length,2);await view.onClose();
});

test('read_image returns text-only crop results and counts auxiliary vision usage without replacing the chat meter',async()=>{
  let visions=0,steps=0,cropCalls=0;const visionUsage=[{prompt_tokens:50,completion_tokens:10,prompt_cache_hit_tokens:20,prompt_cache_miss_tokens:30},{prompt_tokens:60,completion_tokens:11,prompt_cache_hit_tokens:25,prompt_cache_miss_tokens:35}];
  const env=ui(async(k,m,s,d,h,o)=>{
    if(steps++===0){o.onToolCalls([functionCall('inspect-region','read_image',{imageIds:[view.session.entries[0].images[0].id],question:'Read the small axis label',region:{x:0.5,y:0.5,width:0.5,height:0.5}})]);return{prompt_tokens:100,completion_tokens:5,prompt_cache_hit_tokens:80,prompt_cache_miss_tokens:20};}
    const result=JSON.parse(m.at(-1).content);assert.equal(result.description,'The small axis label is seconds.');assert.deepEqual(result.region,{x:0.5,y:0.5,width:0.5,height:0.5});assert.ok(!JSON.stringify(result).includes('base64,'));d('The axis shows seconds.');return{prompt_tokens:200,completion_tokens:7,prompt_cache_hit_tokens:150,prompt_cache_miss_tokens:50};
  },async()=>'',{saved:{webEnabled:false},visionSend:async(k,m,s,d)=>{d(visions?'The small axis label is seconds.':'A plot with a small axis label.');return visionUsage[visions++];},imageStoreOptions:{cropImage:async(image,region)=>{cropCalls++;return{...image,region,width:320,height:240};}}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();await view.upload(attachedImage());view.input.value='Read this plot';await view.send();
  assert.equal(visions,2,view.status.textContent+' '+JSON.stringify(view.session.entries.at(-1)));assert.equal(cropCalls,1);assert.equal(view.session.cache.measured,4);assert.equal(view.session.cache.hit,275);assert.equal(view.session.cache.miss,135);assert.equal(view.session.meter.tokens,207);assert.match(view.session.entries[1].usageText,/410/);assert.match(view.session.entries[1].usageText,/33/);assert.equal(view.session.entries[1].modelMessages.filter(message=>message.role==='tool').length,1);await view.onClose();
});

test('failed vision retains pending attachments and draft for retry and exact repeats reuse recognition',async()=>{
  let attempts=0,generations=0;
  const env=ui(async(k,m,s,d)=>{generations++;d('Answer');},async()=>'',{visionSend:async(k,m,s,d)=>{if(++attempts===1)throw Error('temporary vision failure');d('Reusable image evidence');return{prompt_tokens:30,completion_tokens:4,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:30};}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();await view.upload(attachedImage());view.input.value='Read the labels';await view.send();assert.equal(attempts,1);assert.equal(generations,0);assert.equal(view.pendingImages.length,1);assert.equal(view.input.value,'Read the labels');assert.equal(view.session.entries.length,0);
  await view.send();assert.equal(attempts,2);assert.equal(generations,1);await view.upload(attachedImage('renamed.png'));view.input.value='Read the labels';await view.send();assert.equal(attempts,2);assert.equal(generations,2);assert.equal(view.session.entries[2].imageAnalysis.cached,true);assert.equal(view.session.cache.measured,1);await view.onClose();
});

test('Stop Clear and Close cancel the entire attachment batch during reading or decoding',async()=>{
  for(const phase of ['reading','decoding'])for(const action of ['stop','clear','close']){
    let release,secondReads=0,visions=0;
    const env=ui(async()=>assert.fail('no generation while staging'),async()=>'',{visionSend:async()=>{visions++;},...(phase==='decoding'?{imageStoreOptions:{decodeDimensions:()=>new Promise(resolve=>release=()=>resolve({width:640,height:480}))}}:{})});
    await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();const first=attachedImage('first.png',1),second=attachedImage('second.png',2);if(phase==='reading')first.arrayBuffer=()=>new Promise(resolve=>release=()=>resolve(Buffer.from([137,80,78,71,13,10,26,10,1])));second.arrayBuffer=async()=>{secondReads++;return Buffer.from([137,80,78,71,13,10,26,10,2]);};
    const pending=view.uploadFiles([first,second]);await new Promise(setImmediate);assert.equal(typeof release,'function');if(action==='stop')view.sendButton.click();else if(action==='clear')await view.clear();else await view.onClose();release();await pending;
    assert.equal(secondReads,0,phase+' '+action);assert.equal(visions,0);assert.equal(view.pendingImages.length,0);assert.equal(view.images.metadata().length,0);assert.equal(view.session.messages.length,0);assert.equal(view.session.entries.length,0);if(!view.closed)await view.onClose();
  }
});

test('Stop Clear and Close ignore late vision completion and never create a partial user turn',async()=>{
  for(const action of ['stop','clear','close']){
    let release,generations=0;
    const env=ui(async()=>{generations++;},async()=>'',{visionSend:async(k,m,s,d)=>{await new Promise(resolve=>release=resolve);d('Late image description');return{prompt_tokens:10,completion_tokens:2,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:10};}});
    await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();await view.upload(attachedImage());view.input.value='Inspect';const pending=view.send();await new Promise(setImmediate);assert.equal(typeof release,'function');if(action==='stop')view.sendButton.click();else if(action==='clear')await view.clear();else await view.onClose();await pending;release();await new Promise(setImmediate);
    assert.equal(generations,0);assert.equal(view.session.messages.length,0);assert.equal(view.session.entries.length,0);assert.equal(view.pendingImages.length,action==='stop'?1:0);if(!view.closed)await view.onClose();
  }
});

test('switching conversations releases originals while saved image references return an honest unavailable result',async()=>{
  let steps=0,visions=0;
  const env=ui(async(k,m,s,d,h,o)=>{if(steps++===1){o.onToolCalls([functionCall('reread-missing','read_image',{imageIds:[view.session.entries[0].images[0].id],question:'Read more detail'})]);return;}if(steps===3){assert.match(m.at(-1).content,/重新上传|reattach|released/);d('Please attach the image again.');}else d('First answer');},async()=>'',{saved:{webEnabled:false},visionSend:async(k,m,s,d)=>{visions++;d('Saved text evidence');}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();await view.upload(attachedImage());view.input.value='Inspect';await view.send();const id=env.plugin.activeConversationId,imageId=view.session.entries[0].images[0].id;await view.newConversation();assert.equal(view.images.get(imageId),undefined);await view.switchConversation(id);assert.equal(view.session.entries[0].images[0].id,imageId);assert.match(view.messages[0].content,/Saved text evidence/);view.input.value='Look again';await view.send();assert.equal(visions,1);assert.match(view.session.entries.at(-1).raw,/attach the image again/);await view.onClose();
});

test('deleting an image turn restores available attachments and the original question for an unchanged retry',async()=>{
  let visions=0;
  const env=ui(async(k,m,s,d)=>d('Answer'),async()=>'',{visionSend:async(k,m,s,d)=>{visions++;d('Same original evidence');}});await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();await view.upload(attachedImage());view.input.value='Read these labels';await view.send();const entry=view.session.entries[1],imageId=view.session.entries[0].images[0].id;await view.deleteTurn(entry);assert.equal(view.input.value,'Read these labels');assert.equal(view.pendingImages.length,1);assert.equal(view.pendingImages[0].id,imageId);assert.equal(view.session.messages.length,0);await view.send();assert.equal(visions,1);assert.match(view.session.messages[0].content,/Same original evidence/);await view.onClose();
});

function notebookUiFixture(){return{nbformat:4,nbformat_minor:5,metadata:{},cells:[{id:'calc',cell_type:'code',metadata:{},source:'rate = 0.1\nlabel = "old"\nprint(rate)',outputs:[],execution_count:null},{id:'notes',cell_type:'markdown',metadata:{},source:'Original note'}]};}
async function uiEventually(predicate){for(let i=0;i<80;i++){if(predicate())return;await new Promise(setImmediate);}assert.ok(predicate(),'asynchronous UI state did not settle');}
async function pausedNotebookUi(interrupt='stop'){
  const actual=notebookUiFixture(),api=require('./src/notebook');let calls=0,waiting=false;
  const env=ui(async(k,m,s,d,h,o)=>{if(calls++===0){o.onToolCalls([functionCall('first-source','stage_notebook_edits',{baseHash:api.notebookHash(actual),operations:[{type:'source_chunk',chunkId:'long-cell',part:0,source:'print("',operation:{type:'insert_cell',cellType:'code',cellId:'generated'}}],done:false})]);return{prompt_tokens:100,completion_tokens:8};}waiting=true;await new Promise((resolve,reject)=>{const abort=()=>reject(Object.assign(Error('stopped'),{name:'AbortError'}));s.addEventListener('abort',abort,{once:true});if(s.aborted)abort();});},async()=>'',{saved:{uiLanguage:'en',webEnabled:false}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';env.plugin.notebookFilePath='C:/local/notebooks/research.ipynb';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookPanel.hidden=false;view.notebookClient={read:()=>structuredClone(actual),close(){}};view.input.value='Create a long code cell';const pending=view.send();await uiEventually(()=>waiting);
  if(interrupt==='close')await view.onClose();else view.sendButton.click();await pending;return{env,view,actual,api};
}

test('Notebook source checkpoints survive Stop Close and reload with verified state and a hashed notebook binding',async()=>{
  for(const interrupt of ['stop','close']){
    const {env,view,actual,api}=await pausedNotebookUi(interrupt);const taskId=view.session.activeNotebookTaskId,envelope=view.session.notebookTasks[taskId];assert.ok(taskId);assert.equal(envelope.state.revision,1);assert.equal(api.NotebookEditBuffer.restore(envelope.state).readPending().source,'print("');assert.match(envelope.identity,/^[0-9a-f]{64}$/);assert.equal(envelope.state.batches[0].operations[0].part,0);assert.equal(actual.cells.length,2);if(!view.closed)await view.onClose();
    const persisted=JSON.stringify([...env.conversationState.values()]);assert.ok(!persisted.includes('C:/local/notebooks/research.ipynb'));assert.ok(!persisted.includes('data:image/'));assert.ok(!persisted.includes('"type":"Buffer"'));
    const next=ui(async()=>{},async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState,keyState:{deepseek:'fake',mineru:'',libraryPath:'',notebookFilePath:'C:/local/notebooks/research.ipynb'}});await next.plugin.onload();const reopened=next.plugin.factory({});await reopened.onOpen();assert.equal(reopened.session.activeNotebookTaskId,taskId);assert.equal(reopened.notebookTask(taskId).readPending().source,'print("');next.plugin.notebookFilePath='C:/different/notebook.ipynb';assert.equal(reopened.notebookTask(taskId),null);await reopened.onClose();
    const corrupt=new Map([...env.conversationState].map(([id,item])=>{const copy=structuredClone(item);copy.session.notebookTasks[taskId].state.batches[0].operations[0].source='tampered';return[id,copy];}));const rejected=ui(async()=>{},async()=>'',{saved:env.saved.at(-1),conversationState:corrupt});await rejected.plugin.onload();assert.equal(rejected.plugin.session.activeNotebookTaskId,undefined);
  }
});

test('Notebook pending tasks resume only through Continue and expose the accepted source before the next chunk',async()=>{
  const paused=await pausedNotebookUi();const taskId=paused.view.session.activeNotebookTaskId;await paused.view.onClose();let calls=0,normal=0;
  const env=ui(async(k,m,s,d,h,o)=>{
    if(normal++===0){assert.ok(!m.at(-1).content.includes('[Notebook edit task]'));assert.equal(o.tools.length,0);d('An ordinary answer');return;}
    if(calls++===0){assert.match(m.at(-1).content,/"resumed":true/);assert.match(m.at(-1).content,new RegExp(taskId));o.onToolCalls([functionCall('read-partial','read_notebook',{pendingSource:{offset:0,limit:12000}})]);}
    else if(calls===2){const partial=JSON.parse(m.at(-1).content);assert.equal(partial.source,'print("');assert.equal(partial.nextPart,1);o.onToolCalls([functionCall('finish-source','stage_notebook_edits',{baseHash:partial.currentHash,operations:[{type:'source_chunk',chunkId:'long-cell',part:1,source:'ready")',final:true}],done:true})]);}
    else d('The complete edit is ready for review.');return{prompt_tokens:100,completion_tokens:10};
  },async()=>'',{saved:paused.env.saved.at(-1),conversationState:paused.env.conversationState,keyState:{deepseek:'fake',mineru:'',libraryPath:'',notebookFilePath:'C:/local/notebooks/research.ipynb'}});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();view.input.value='Explain a concept';await view.send();assert.equal(view.session.activeNotebookTaskId,taskId);assert.equal(view.notebookTask(taskId).revision,1);assert.equal(calls,0);
  view.notebookClient={read:()=>structuredClone(paused.actual),close(){}};view.refreshNotebookTaskStatus();view.input.value='';view.resumeNotebookButton.click();await uiEventually(()=>calls>=3&&!view.controller);const entry=view.session.entries.at(-1);assert.equal(entry.notebookTaskId,taskId);assert.equal(entry.notebookPatch.operations[0].source,'print("ready")');assert.equal(entry.notebookPatch.operations.length,1);assert.equal(view.notebookTask(taskId).done,true);assert.equal(view.session.activeNotebookTaskId,undefined);assert.equal(paused.actual.cells.length,2);await view.onClose();
});

test('manual Notebook edits made during generation enter the next model request as a delta without changing the staging base',async()=>{
  const api=require('./src/notebook');const actual=notebookUiFixture(),baseHash=api.notebookHash(actual);let calls=0;
  const env=ui(async(k,m,s,d,h,o)=>{if(calls++===0){actual.cells[1].source='Manually revised note';o.onToolCalls([functionCall('read-after-manual-change','read_notebook',{cellIds:['calc']})]);}
    else{const update=m.find(message=>message.content.includes('[Notebook changed during generation]'));assert.ok(update);assert.match(update.content,/Manually revised note/);assert.match(update.content,/Preserve those changes/);assert.ok(!update.content.includes('rate = 0.1'));const task=JSON.parse(m[1].content.split('[Notebook edit task]\n')[1].split('\n')[0]);assert.equal(task.baseHash,baseHash);d('I will preserve your edits.');}return{prompt_tokens:100,completion_tokens:5};},async()=>'',{saved:{webEnabled:false}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient={read:()=>structuredClone(actual),close(){}};view.input.value='Inspect the notebook';await view.send();assert.equal(calls,2);assert.equal(actual.cells[1].source,'Manually revised note');assert.ok(view.session.entries.at(-1).modelMessages.some(message=>message.role==='user'&&message.content.includes('[Notebook changed during generation]')));assert.equal(view.notebookSnapshot.hash,api.notebookHash(actual));await view.onClose();
});

async function completedNotebookUi(operations=[{type:'replace_text',cellId:'calc',oldText:'0.1',newText:'0.01'}]){
  const api=require('./src/notebook'),state={actual:notebookUiFixture(),applied:0,patch:null,requests:[]};let calls=0;
  const env=ui(async(k,m,s,d,h,o)=>{state.requests.push(structuredClone(m));if(calls++===0)o.onToolCalls([functionCall('complete-edits','stage_notebook_edits',{baseHash:api.notebookHash(state.actual),operations,done:true})]);else d('The edits are ready for review.');return{prompt_tokens:100,completion_tokens:5};},async()=>'',{saved:{uiLanguage:'en',webEnabled:false}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';env.plugin.notebookFilePath='C:/local/notebooks/research.ipynb';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient={read:()=>structuredClone(state.actual),applyPatch:async patch=>{state.applied++;state.patch=structuredClone(patch);state.actual=api.validatePatch(state.actual,patch).notebook;return structuredClone(state.actual);},close(){}};view.input.value='Update the rate';await view.send();return{env,view,state,api,entry:view.session.entries[1]};
}

test('Notebook review rebases independent-cell and disjoint same-cell edits while preserving manual changes',async()=>{
  for(const edit of ['other-cell','same-cell']){
    const {env,view,state,api,entry}=await completedNotebookUi();const originalPatch=structuredClone(entry.notebookPatch);if(edit==='other-cell')state.actual.cells[1].source='My independent manual note';else state.actual.cells[0].source=state.actual.cells[0].source.replace('"old"','"manual"');const liveHash=api.notebookHash(state.actual);
    env.doc.querySelector('.sd-notebook-apply').click();await uiEventually(()=>env.doc.querySelector('.sd-confirm'));assert.match(env.doc.querySelector('.sd-confirm').textContent,/preserved|Preserved/);assert.equal(state.applied,0);env.doc.querySelector('.sd-confirm .mod-cta').click();await uiEventually(()=>state.applied===1&&!view.applyingNotebookPatch);
    assert.equal(state.patch.baseHash,liveHash);assert.match(state.actual.cells[0].source,/rate = 0\.01/);if(edit==='other-cell')assert.equal(state.actual.cells[1].source,'My independent manual note');else assert.match(state.actual.cells[0].source,/label = "manual"/);assert.deepEqual(entry.notebookPatch,originalPatch);assert.equal(entry.notebookApplied,true);const receipt=JSON.parse(view.session.messages.at(-1).content.split('\n')[1]);assert.equal(receipt.rebasedFrom,originalPatch.baseHash);assert.equal(receipt.verified,true);assert.ok(view.session.messages.some(message=>message.content.includes('[Notebook live state before applying edits]')));await view.onClose();
  }
});

test('overlapping Notebook edits never reach RTC and Regenerate prepares a fresh task against the latest live state',async()=>{
  const {env,view,state,api,entry}=await completedNotebookUi();state.actual.cells[0].source=state.actual.cells[0].source.replace('0.1','0.2');env.doc.querySelector('.sd-notebook-apply').click();await uiEventually(()=>env.doc.querySelector('.sd-notebook-regenerate'));assert.equal(state.applied,0);assert.equal(env.doc.querySelector('.sd-confirm'),null);assert.match(view.notebookStatus.textContent,/conflict|manual|Notebook/i);assert.match(state.actual.cells[0].source,/rate = 0\.2/);assert.equal(entry.notebookApplied,undefined);
  const before=state.requests.length;env.doc.querySelector('.sd-notebook-regenerate').click();assert.equal(state.requests.length,before);assert.match(view.input.value,/Update the rate/);assert.match(view.input.value,/latest Notebook/);assert.match(view.input.value,/manual/);await view.send();const newest=state.requests.at(-1).at(-1).content;assert.match(newest,/rate = 0\.2/);const task=JSON.parse(newest.split('[Notebook edit task]\n')[1].split('\n')[0]);assert.equal(task.resumed,false);assert.equal(task.baseHash,api.notebookHash(state.actual));assert.notEqual(task.taskId,entry.notebookTaskId);assert.equal(state.applied,0);await view.onClose();
});

test('Notebook confirmation rechecks live edits and refuses an overlapping change made while the dialog is open',async()=>{
  const {env,view,state,entry}=await completedNotebookUi();env.doc.querySelector('.sd-notebook-apply').click();await uiEventually(()=>env.doc.querySelector('.sd-confirm'));state.actual.cells[0].source=state.actual.cells[0].source.replace('0.1','0.3');env.doc.querySelector('.sd-confirm .mod-cta').click();await uiEventually(()=>env.doc.querySelector('.sd-notebook-regenerate')&&!view.applyingNotebookPatch);assert.equal(state.applied,0);assert.match(state.actual.cells[0].source,/rate = 0\.3/);assert.equal(entry.notebookApplied,undefined);assert.equal(env.doc.querySelector('.sd-confirm'),null);await view.onClose();
});

test('changing a notebook path prevents applying a saved task to the replacement notebook',async()=>{
  const {env,view,state}=await completedNotebookUi();env.plugin.notebookFilePath='C:/local/notebooks/another.ipynb';env.doc.querySelector('.sd-notebook-apply').click();await uiEventually(()=>env.doc.querySelector('.sd-notebook-regenerate'));assert.equal(state.applied,0);assert.equal(env.doc.querySelector('.sd-confirm'),null);assert.match(state.actual.cells[0].source,/rate = 0\.1/);await view.onClose();
});

test('discarding an unfinished Notebook task disables continuation while preserving original tool history',async()=>{
  const {env,view}=await pausedNotebookUi();const taskId=view.session.activeNotebookTaskId,before=JSON.stringify(view.session.entries);await view.discardNotebookTask(taskId);assert.equal(view.session.activeNotebookTaskId,undefined);assert.equal(view.notebookTask(taskId),null);assert.equal(view.session.notebookTasks[taskId].discarded,true);assert.equal(JSON.stringify(view.session.entries),before);await view.onClose();const reopened=ui(async()=>{},async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState});await reopened.plugin.onload();assert.equal(reopened.plugin.session.activeNotebookTaskId,undefined);assert.equal(reopened.plugin.session.notebookTasks[taskId].discarded,true);
});

test('deleting the only Notebook staging turn removes its resumable task from memory and saved state',async()=>{
  const {env,view}=await pausedNotebookUi();const taskId=view.session.activeNotebookTaskId,entry=view.session.entries[1];assert.ok(view.notebookTask(taskId));await view.deleteTurn(entry);assert.equal(view.session.activeNotebookTaskId,undefined);assert.equal(view.notebookTask(taskId),null);assert.equal(view.session.notebookTasks?.[taskId],undefined);assert.equal(view.session.entries.length,0);assert.equal(view.input.value,'Create a long code cell');await view.onClose();const saved=env.conversationState.get(env.plugin.activeConversationId).session;assert.equal(saved.notebookTasks?.[taskId],undefined);assert.equal(saved.activeNotebookTaskId,undefined);
});

test('deleting a resumed Notebook turn rewinds its checkpoint to the last retained revision',async()=>{
  const paused=await pausedNotebookUi();const taskId=paused.view.session.activeNotebookTaskId;await paused.view.onClose();let calls=0;
  const env=ui(async(k,m,s,d,h,o)=>{if(calls++===0){const task=JSON.parse(m.at(-1).content.split('[Notebook edit task]\n')[1].split('\n')[0]);o.onToolCalls([functionCall('last-source','stage_notebook_edits',{baseHash:task.currentHash,operations:[{type:'source_chunk',chunkId:'long-cell',part:1,source:'done")',final:true}],done:true})]);}else d('Ready');return{prompt_tokens:100,completion_tokens:5};},async()=>'',{saved:paused.env.saved.at(-1),conversationState:paused.env.conversationState,keyState:{deepseek:'fake',mineru:'',libraryPath:'',notebookFilePath:'C:/local/notebooks/research.ipynb'}});
  await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();view.notebookClient={read:()=>structuredClone(paused.actual),close(){}};await view.resumeNotebookTask(taskId);assert.equal(view.notebookTask(taskId).revision,2);assert.equal(view.notebookTask(taskId).done,true);const last=view.session.entries.at(-1);assert.equal(last.notebookTaskRevision,2);await view.deleteTurn(last);const restored=view.notebookTask(taskId);assert.ok(restored);assert.equal(restored.revision,1);assert.equal(restored.done,false);assert.equal(restored.readPending().source,'print("');assert.equal(view.session.activeNotebookTaskId,taskId);await view.onClose();
});

async function dependentNotebookTurns({done=true,ramOnly=false,sameRevision=false}={}){
  const api=require('./src/notebook'),history=require('./src/history'),state={actual:notebookUiFixture(),applied:0,generations:0};
  const env=ui(async(k,m,s,d)=>{state.generations++;d('A fresh answer');return{prompt_tokens:100,completion_tokens:4};},async()=>'',{saved:{uiLanguage:'en',webEnabled:false}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';env.plugin.notebookFilePath='C:/local/notebooks/research.ipynb';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;
  view.notebookClient={read:()=>structuredClone(state.actual),applyPatch:async patch=>{state.applied++;state.actual=api.validatePatch(state.actual,patch).notebook;return structuredClone(state.actual);},close(){}};
  const buffer=new api.NotebookEditBuffer(state.actual),firstBatch={baseHash:buffer.currentHash,operations:[{type:'replace_text',cellId:'calc',oldText:'0.1',newText:'0.01'}],done:false};buffer.stage(firstBatch);
  const firstUser=view.row('你','Change the rate').entry;firstUser.notebookAttached=true;firstUser.contextText=firstUser.raw+api.notebookContext(api.notebookDelta(state.actual,null));
  const first=view.row('deepseek-flash','Collected the rate edit.').entry;Object.assign(first,{replyId:'dependency-first',notebookTaskId:buffer.taskId,notebookTaskRevision:buffer.revision,modelMessages:[{role:'assistant',content:'',tool_calls:[functionCall('dependency-one','stage_notebook_edits',firstBatch)]},{role:'tool',tool_call_id:'dependency-one',content:JSON.stringify(buffer.status())}]});
  const secondBatch={baseHash:buffer.currentHash,operations:[{type:'insert_cell',cellId:'generated',cellType:'code',source:'extra = 2'}],done};if(!sameRevision)buffer.stage(secondBatch);
  view.row('你','Continue the pending edits');const patch=done&&!sameRevision?buffer.result():null;
  const second=view.row('deepseek-flash',patch?'Ready\n```notebook-patch\n'+JSON.stringify(patch)+'\n```':'More edits remain pending.').entry;
  Object.assign(second,{replyId:'dependency-second',notebookTaskId:buffer.taskId,notebookTaskRevision:buffer.revision,notebookTaskIdentity:view.notebookIdentity(),modelMessages:[{role:'assistant',content:'Collected next edits',tool_calls:[functionCall('dependency-two','stage_notebook_edits',sameRevision?firstBatch:secondBatch)]},{role:'tool',tool_call_id:'dependency-two',content:JSON.stringify(buffer.status())}],...(patch?{notebookPatch:patch}:{})});
  const identity=view.notebookIdentity();if(!ramOnly)view.session.notebookTasks={[buffer.taskId]:{state:buffer.exportState(),identity}};
  if(!buffer.done)view.session.activeNotebookTaskId=buffer.taskId;view.notebookTaskBuffers.set(buffer.taskId,{buffer,identity});
  view.messages.push(...history.rebuildEntryMessages(view.session.entries));view.notebookSnapshot=api.notebookSnapshot(state.actual);view.session.notebookSnapshot=view.notebookSnapshot;view.refreshNotebookTaskStatus();
  for(const row of view.rows)await view.render(row);
  return{env,view,state,api,first,second,buffer};
}

test('deleting an earlier Notebook dependency invalidates later unsubmitted edits and blocks raw-patch fallback after reload',async()=>{
  for(const ramOnly of [false,true]){
    const {env,view,state,api,first,second,buffer}=await dependentNotebookTurns({ramOnly});const taskId=buffer.taskId,raw=second.raw,journal=JSON.stringify(second.modelMessages),patch=structuredClone(second.notebookPatch);
    assert.ok(env.doc.querySelector('.sd-notebook-apply'));await view.deleteTurn(first);for(const row of view.rows)await view.render(row);
    assert.equal(view.session.entries.length,2);assert.equal(second.notebookTaskInvalidated,true);assert.equal(second.raw,raw);assert.equal(JSON.stringify(second.modelMessages),journal);assert.equal(view.notebookTask(taskId),null);assert.equal(view.session.activeNotebookTaskId,undefined);
    if(!ramOnly)assert.equal(view.session.notebookTasks[taskId].invalidated,true);
    assert.equal(env.doc.querySelector('.sd-notebook-apply'),null);assert.ok(env.doc.querySelector('.sd-notebook-regenerate'));assert.throws(()=>view.prepareNotebookPatch({entry:second},patch,state.actual),/latest Notebook|最新 Notebook/);assert.equal(state.applied,0);
    delete second.notebookPatch;assert.ok(api.parsePatch(second.raw));await view.plugin.saveSession();await view.onClose();
    const next=ui(async()=>assert.fail('invalidated task cannot resume'),async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState,keyState:{deepseek:'fake',mineru:'',libraryPath:'',notebookFilePath:'C:/local/notebooks/research.ipynb'}});await next.plugin.onload();const reopened=next.plugin.factory({});await reopened.onOpen();
    reopened.notebookClient={read:()=>structuredClone(state.actual),applyPatch:async()=>assert.fail('invalidated task cannot apply'),close(){}};
    assert.equal(reopened.session.entries[1].notebookTaskInvalidated,true);assert.equal(reopened.session.entries[1].raw,raw);assert.deepEqual(JSON.parse(JSON.stringify(reopened.session.entries[1].modelMessages)),JSON.parse(journal));assert.equal(reopened.notebookTask(taskId),null);assert.equal(next.doc.querySelector('.sd-notebook-apply'),null);assert.ok(next.doc.querySelector('.sd-notebook-regenerate'));
    assert.throws(()=>reopened.prepareNotebookPatch({entry:reopened.session.entries[1]},api.parsePatch(raw),state.actual),/latest Notebook|最新 Notebook/);await reopened.resumeNotebookTask(taskId);assert.equal(reopened.controller,null);await reopened.onClose();
  }
});

test('deleting an earlier Notebook dependency blocks continuation even when the retained round has the same revision',async()=>{
  const {env,view,state,first,second,buffer}=await dependentNotebookTurns({done:false,sameRevision:true});const taskId=buffer.taskId,journal=JSON.stringify(second.modelMessages);
  assert.equal(first.notebookTaskRevision,second.notebookTaskRevision);assert.equal(view.notebookTask(taskId).done,false);await view.deleteTurn(first);for(const row of view.rows)await view.render(row);
  assert.equal(second.notebookTaskInvalidated,true);assert.equal(view.notebookTask(taskId),null);assert.equal(view.session.activeNotebookTaskId,undefined);assert.equal(view.notebookTaskBar.hidden,true);assert.equal(env.doc.querySelector('.sd-notebook-resume'),null);assert.ok(env.doc.querySelector('.sd-notebook-regenerate'));assert.equal(JSON.stringify(second.modelMessages),journal);
  await view.resumeNotebookTask(taskId);assert.equal(state.generations,0);assert.match(view.status.textContent,/latest Notebook|最新 Notebook/);await view.onClose();
});

test('deleting a Notebook dependency never pretends an already applied patch was undone',async()=>{
  const {env,view,state,first,second,buffer}=await dependentNotebookTurns();env.doc.querySelector('.sd-notebook-apply').click();await uiEventually(()=>env.doc.querySelector('.sd-confirm'));env.doc.querySelector('.sd-confirm .mod-cta').click();await uiEventually(()=>state.applied===1&&!view.applyingNotebookPatch);
  const applied=JSON.stringify(state.actual),receipt=view.session.entries.find(entry=>entry.sourceReplyId===second.replyId),receiptRaw=receipt.raw;assert.equal(second.notebookApplied,true);
  await view.deleteTurn(first);for(const row of view.rows)await view.render(row);assert.equal(JSON.stringify(state.actual),applied);assert.equal(second.notebookApplied,true);assert.equal(second.notebookTaskInvalidated,undefined);assert.equal(receipt.raw,receiptRaw);assert.ok(view.session.entries.includes(receipt));assert.equal(view.notebookTask(buffer.taskId),null);
  const button=env.doc.querySelector('.sd-notebook-apply');assert.ok(button);assert.equal(button.disabled,true);assert.match(button.textContent,/synced|同步/i);assert.equal(env.doc.querySelector('.sd-notebook-regenerate'),null);assert.equal(state.applied,1);await view.onClose();
});

test('a completed Notebook checkpoint interrupted before the final answer remains reviewable after reload',async()=>{
  const api=require('./src/notebook');let actual=notebookUiFixture(),calls=0,waiting=false,applied=0;
  const env=ui(async(k,m,s,d,h,o)=>{if(calls++===0){o.onToolCalls([functionCall('complete-before-stop','stage_notebook_edits',{baseHash:api.notebookHash(actual),operations:[{type:'replace_text',cellId:'calc',oldText:'0.1',newText:'0.01'}],done:true})]);return{prompt_tokens:100,completion_tokens:8};}waiting=true;await new Promise((resolve,reject)=>s.addEventListener('abort',()=>reject(Object.assign(Error('stopped'),{name:'AbortError'})),{once:true}));},async()=>'',{saved:{uiLanguage:'en',webEnabled:false}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';env.plugin.notebookFilePath='C:/local/notebooks/research.ipynb';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient={read:()=>structuredClone(actual),close(){}};view.input.value='Update the rate';const pending=view.send();await uiEventually(()=>waiting);assert.equal(view.session.entries[1].notebookPatch.operations.length,1);view.sendButton.click();await pending;assert.equal(view.session.entries[1].raw,'');assert.ok(env.doc.querySelector('.sd-notebook-apply'));assert.match(actual.cells[0].source,/rate = 0\.1/);await view.onClose();
  const next=ui(async()=>{},async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState,keyState:{deepseek:'fake',mineru:'',libraryPath:'',notebookFilePath:'C:/local/notebooks/research.ipynb'}});await next.plugin.onload();const reopened=next.plugin.factory({});await reopened.onOpen();assert.ok(next.doc.querySelector('.sd-notebook-apply'));assert.equal(next.doc.querySelector('.sd-notebook-resume'),null);reopened.notebookClient={read:()=>structuredClone(actual),applyPatch:async patch=>{applied++;actual=api.validatePatch(actual,patch).notebook;return structuredClone(actual);},close(){}};next.doc.querySelector('.sd-notebook-apply').click();await uiEventually(()=>next.doc.querySelector('.sd-confirm'));assert.equal(applied,0);next.doc.querySelector('.sd-confirm .mod-cta').click();await uiEventually(()=>applied===1&&!reopened.applyingNotebookPatch);assert.match(actual.cells[0].source,/rate = 0\.01/);assert.equal(reopened.session.entries[1].notebookApplied,true);await reopened.onClose();
});

test('an applied Notebook patch with failed server verification is marked unverified and cannot be applied twice',async()=>{
  const {env,view,state,api,entry}=await completedNotebookUi();const baseline=structuredClone(view.notebookSnapshot);view.notebookClient.applyPatch=async patch=>{state.applied++;state.actual=api.validatePatch(state.actual,patch).notebook;throw Object.assign(Error('server verification unavailable'),{applied:true,notebook:structuredClone(state.actual)});};env.doc.querySelector('.sd-notebook-apply').click();await uiEventually(()=>env.doc.querySelector('.sd-confirm'));env.doc.querySelector('.sd-confirm .mod-cta').click();await uiEventually(()=>state.applied===1&&!view.applyingNotebookPatch);
  assert.equal(entry.notebookApplied,true);assert.equal(entry.notebookUnverified,true);assert.deepEqual(view.notebookSnapshot,baseline);assert.deepEqual(view.session.notebookSnapshot,baseline);const button=env.doc.querySelector('.sd-notebook-apply');assert.equal(button.disabled,true);assert.match(button.textContent,/synchronization unconfirmed/);button.click();assert.equal(state.applied,1);const receipt=JSON.parse(view.session.messages.at(-1).content.split('\n')[1]);assert.equal(receipt.verified,false);assert.match(view.notebookStatus.textContent,/verify|verification|confirm|Jupyter/i);await view.onClose();
  const next=ui(async()=>{},async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState});await next.plugin.onload();const reopened=next.plugin.factory({});await reopened.onOpen();assert.equal(reopened.session.entries[1].notebookUnverified,true);assert.equal(next.doc.querySelector('.sd-notebook-apply').disabled,true);await reopened.onClose();
});

test('a RAM-only Notebook task remains bound to its original path before confirmation and after reload',async()=>{
  const api=require('./src/notebook'),actual=notebookUiFixture(),imageData='data:image/png;base64,QUJDRA==';actual.cells[0].source+='\nfigure = "'+imageData+'"';let calls=0,applied=0;
  const env=ui(async(k,m,s,d,h,o)=>{assert.ok(!JSON.stringify(m).includes(imageData));if(calls++===0){const task=JSON.parse(m.at(-1).content.split('[Notebook edit task]\n')[1].split('\n')[0]);o.onToolCalls([functionCall('safe-addition','stage_notebook_edits',{baseHash:task.currentHash,operations:[{type:'insert_cell',cellType:'code',cellId:'safe-new-cell',source:'print(42)'}],done:true})]);}else d('Ready for review.');return{prompt_tokens:100,completion_tokens:8};},async()=>'',{saved:{uiLanguage:'en',webEnabled:false}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';env.plugin.notebookFilePath='C:/local/notebooks/original.ipynb';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient={read:()=>structuredClone(actual),applyPatch:async()=>{applied++;return structuredClone(actual);},close(){}};view.input.value='Append a cell';await view.send();const entry=view.session.entries[1],taskId=entry.notebookTaskId,identity=entry.notebookTaskIdentity;
  assert.match(identity,/^[0-9a-f]{64}$/);assert.equal(view.notebookTask(taskId).exportState(),null);assert.equal(view.session.notebookTasks?.[taskId],undefined);assert.equal(entry.notebookPatch.baseHash,api.notebookHash(actual));env.plugin.notebookFilePath='C:/local/notebooks/identical-copy.ipynb';env.doc.querySelector('.sd-notebook-apply').click();await uiEventually(()=>env.doc.querySelector('.sd-notebook-regenerate'));assert.equal(applied,0);assert.equal(env.doc.querySelector('.sd-confirm'),null);await view.onClose();const persisted=JSON.stringify([...env.conversationState.values()]);assert.ok(!persisted.includes(imageData));assert.ok(!persisted.includes('original.ipynb'));
  const next=ui(async()=>{},async()=>'',{saved:env.saved.at(-1),conversationState:env.conversationState,keyState:{deepseek:'fake',mineru:'',libraryPath:'',notebookFilePath:'C:/local/notebooks/identical-copy.ipynb'}});await next.plugin.onload();const reopened=next.plugin.factory({});await reopened.onOpen();assert.equal(reopened.session.entries[1].notebookTaskIdentity,identity);assert.equal(reopened.notebookTask(taskId),null);reopened.notebookClient={read:()=>structuredClone(actual),applyPatch:async()=>{applied++;return structuredClone(actual);},close(){}};next.doc.querySelector('.sd-notebook-apply').click();await uiEventually(()=>next.doc.querySelector('.sd-notebook-regenerate'));assert.equal(applied,0);assert.equal(next.doc.querySelector('.sd-confirm'),null);await reopened.onClose();
});

test('large archived thinking stays out of the DOM until expanded and never uses the Markdown renderer',async()=>{
  const thought='  First **literal** $x$\n\n'+'Long reasoning paragraph. '.repeat(6000)+'\n\nFinal line.  ',id='conversation-lazythinking';
  const session={messages:[{role:'user',content:'Question'},{role:'assistant',content:'Answer',reasoning_content:thought}],entries:[{label:'你',raw:'Question'},{label:'deepseek-flash',raw:'Answer',thinking:thought}],meter:null,compactions:0,cache:null};
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en',activeConversationId:id},conversationState:new Map([[id,{id,createdAt:1,session}]])});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();const box=env.doc.querySelectorAll('.sd-thinking')[1],body=box.querySelector('.sd-thinking-body');assert.equal(box.open,false);assert.equal(body.childNodes.length,0);assert.equal(body.textContent,'');assert.ok(!env.renders.some(render=>render.text.includes('Long reasoning paragraph')));
  box.open=true;box.dispatchEvent(new env.dom.window.Event('toggle'));await uiEventually(()=>body.textContent===thought);assert.ok(body.childNodes.length>1);assert.ok(!env.renders.some(render=>render.text.includes('Long reasoning paragraph')));box.open=false;box.dispatchEvent(new env.dom.window.Event('toggle'));assert.equal(body.childNodes.length,0);assert.equal(view.session.entries[1].thinking,thought);assert.equal(view.messages[1].reasoning_content,thought);await view.onClose();assert.equal(env.conversationState.get(id).session.entries[1].thinking,thought);
});

test('retrieved pages are lazy collapsed links with stable toggle state and complete Markdown copying',async()=>{
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();const state=view.row('deepseek-flash','Answer');state.entry.sources=[{url:'https://example.com/ref',title:'<img src="unsafe"> `Title`'},{url:'https://example.com/ref',title:'Duplicate'},{url:'javascript:alert(1)',title:'unsafe scheme'},{url:'http://127.0.0.1/private',title:'private URL'}];state.version++;await view.render(state);
  const box=state.element.querySelector('.sd-sources'),body=box.querySelector('.sd-sources-body');assert.equal(box.hidden,false);assert.equal(box.open,false);assert.match(box.querySelector('summary').textContent,/Retrieved pages \(1\)/);assert.equal(body.childNodes.length,0);assert.equal(state.body.textContent,'Answer');box.open=true;box.dispatchEvent(new env.dom.window.Event('toggle'));assert.equal(body.querySelectorAll('a').length,1);assert.match(body.querySelector('a').textContent,/<img/);assert.equal(body.querySelector('img'),null);assert.equal(body.querySelector('a').href,'https://example.com/ref');
  view.update(state,'Updated answer');await view.render(state);assert.equal(box.open,true);assert.equal(body.querySelectorAll('a').length,1);assert.equal(state.body.textContent,'Updated answer');env.plugin.uiLanguage='zh';view.refreshLanguage();await new Promise(setImmediate);assert.equal(box.open,true);assert.match(box.querySelector('summary').textContent,/已检索网页 \(1\)/);assert.equal(body.querySelector('a').textContent,'<img src="unsafe"> `Title`');
  state.element.querySelector('.sd-message-footer .sd-icon-button').click();await new Promise(setImmediate);assert.match(env.copies.at(-1),/Updated answer/);assert.match(env.copies.at(-1),/https:\/\/example\.com\/ref/);assert.ok(!env.copies.at(-1).includes('javascript:'));assert.ok(!env.copies.at(-1).includes('127.0.0.1'));assert.ok(!env.renders.some(render=>render.text.includes('example.com/ref')));box.open=false;box.dispatchEvent(new env.dom.window.Event('toggle'));assert.equal(body.childNodes.length,0);await view.onClose();
});

test('chat selection copies expanded thinking literally and rendered answer and retrieved links as Markdown',async()=>{
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();const entry={label:'deepseek-flash',raw:'Answer',thinking:'Reason **literally**\n\nNext line.',sources:[{url:'https://example.com/reference',title:'Reference title'}]};view.session.entries.push(entry);const state=view.row(entry.label,entry.raw,entry);await view.render(state);const sourceBox=state.element.querySelector('.sd-sources');state.thinkingBox.open=true;state.thinkingBox.dispatchEvent(new env.dom.window.Event('toggle'));sourceBox.open=true;sourceBox.dispatchEvent(new env.dom.window.Event('toggle'));await uiEventually(()=>state.thinkingBody.textContent===entry.thinking);
  const range=env.doc.createRange();range.setStart(state.thinkingBody,0);range.setEnd(sourceBox.querySelector('.sd-sources-body'),sourceBox.querySelector('.sd-sources-body').childNodes.length);const selection=env.doc.getSelection();selection.removeAllRanges();selection.addRange(range);const data=new Map();const event=new env.dom.window.Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{clearData:()=>data.clear(),setData:(type,value)=>data.set(type,value)}});state.thinkingBody.dispatchEvent(event);assert.equal(event.defaultPrevented,true);assert.equal(data.get('text/plain'),'Reason **literally**\n\nNext line.\n\nAnswer\n\n- [Reference title](https://example.com/reference "https://example.com/reference")');selection.removeAllRanges();await view.onClose();
});

test('offscreen expanded thinking and retrieved pages release DOM and restore it without reopening disposed rows',async()=>{
  let onVisibility;class Observer{constructor(callback){onVisibility=callback;}observe(){}unobserve(){}disconnect(){}}
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'},IntersectionObserver:Observer});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();const entry={label:'deepseek-flash',raw:'Answer',thinking:'First thought.\n\nSecond thought.',sources:[{url:'https://example.com/ref',title:'Reference'}]};view.session.entries.push(entry);const state=view.row(entry.label,entry.raw,entry);onVisibility([{target:state.element,isIntersecting:true}]);await uiEventually(()=>state.body.textContent==='Answer');const sourceBox=state.element.querySelector('.sd-sources'),sourceBody=sourceBox.querySelector('.sd-sources-body');state.thinkingBox.open=true;state.thinkingBox.dispatchEvent(new env.dom.window.Event('toggle'));sourceBox.open=true;sourceBox.dispatchEvent(new env.dom.window.Event('toggle'));await uiEventually(()=>state.thinkingBody.textContent===entry.thinking);assert.equal(sourceBody.querySelectorAll('a').length,1);
  state.thinkingBody.getBoundingClientRect=()=>({height:160});sourceBody.getBoundingClientRect=()=>({height:80});onVisibility([{target:state.element,isIntersecting:false}]);assert.equal(state.thinkingBody.childNodes.length,0);assert.equal(sourceBody.childNodes.length,0);assert.equal(state.thinkingBody.style.minHeight,'160px');assert.equal(sourceBody.style.minHeight,'80px');assert.equal(state.thinkingBox.open,true);assert.equal(sourceBox.open,true);
  onVisibility([{target:state.element,isIntersecting:true}]);assert.equal(state.thinkingBody.textContent,entry.thinking);assert.equal(sourceBody.querySelectorAll('a').length,1);assert.equal(state.thinkingBody.style.minHeight,'');assert.equal(sourceBody.style.minHeight,'');await new Promise(setImmediate);view.disposeRows();assert.equal(state.thinkingBody.childNodes.length,0);assert.equal(sourceBody.childNodes.length,0);state.thinkingBox.dispatchEvent(new env.dom.window.Event('toggle'));sourceBox.dispatchEvent(new env.dom.window.Event('toggle'));state.thinkingView.setVisible(true);state.sourceList.setVisible(true);assert.equal(state.thinkingBody.childNodes.length,0);assert.equal(sourceBody.childNodes.length,0);assert.equal(entry.thinking,'First thought.\n\nSecond thought.');await view.onClose();
});

test('stopping after a web tool refreshes collapsed sources without revealing queued text or hidden protocol markup',async()=>{
  for(const withAnswer of [false,true]){
    let calls=0,waiting=false,releaseRender;const answer='Safe answer with evidence. '.repeat(60);
    const env=ui(async(k,m,s,d,h,o)=>{if(calls++===0){d(reportedDsml);return{prompt_tokens:100,completion_tokens:5};}if(calls===2){o.onToolCalls([functionCall('search-before-stop','search_web',{query:'reference'})]);return{prompt_tokens:150,completion_tokens:5};}if(withAnswer)d(answer);waiting=true;await new Promise((resolve,reject)=>s.addEventListener('abort',()=>reject(Object.assign(Error('stopped'),{name:'AbortError'})),{once:true}));},async()=>'',{saved:{uiLanguage:'en'},pacingRate:20,render:async text=>{if(withAnswer&&text&&answer.startsWith(text))await new Promise(resolve=>releaseRender=resolve);},webHttp:async()=>Buffer.from(JSON.stringify({results:[{url:'https://example.com/ref',title:'Reference page',content:'Verified reference text'}]}))});
    await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='Search for evidence';const pending=view.send();await uiEventually(()=>waiting);if(withAnswer)await new Promise(resolve=>setTimeout(resolve,100));const state=[...view.rows].at(-1);let rendering;if(withAnswer){rendering=view.render(state);await uiEventually(()=>releaseRender);}const shown=state.body.textContent,history=JSON.stringify(view.messages);assert.ok(shown.length<answer.length);view.sendButton.click();await pending;if(releaseRender){releaseRender();await rendering;}assert.equal(state.streaming,false);assert.equal(state.timer,null);assert.equal(state.body.textContent,shown);assert.ok(!state.body.textContent.includes('DSML'));assert.equal(state.entry.raw,reportedDsml+(withAnswer?answer:''));assert.equal(state.entry.displayText,withAnswer?answer:'');assert.equal(JSON.stringify(view.messages),history);
    assert.equal(state.sourcesBox.hidden,false);assert.equal(state.sourcesBox.open,false);assert.equal(state.sourcesBox.querySelector('summary').textContent,'Retrieved pages (1)');assert.equal(state.sourcesBox.querySelectorAll('a').length,0);state.sourcesBox.open=true;state.sourcesBox.dispatchEvent(new env.dom.window.Event('toggle'));assert.equal(state.sourcesBox.querySelector('a').href,'https://example.com/ref');assert.equal(state.sourcesBox.querySelector('a').textContent,'Reference page');await view.onClose();assert.equal(env.conversationState.get(env.plugin.activeConversationId).session.entries[1].sources[0].url,'https://example.com/ref');
  }
});

test('static virtualized replies keep their measured height during async rehydration and never scroll the feed',async()=>{
  let onVisibility,hold=false,release;class Observer{constructor(callback){onVisibility=callback;}observe(){}unobserve(){}disconnect(){}}
  const env=ui(async()=>{},async()=>'',{IntersectionObserver:Observer,render:async()=>{if(hold)await new Promise(resolve=>release=resolve);}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();const row=view.row('deepseek-flash','A completed answer');onVisibility([{target:row.element,isIntersecting:true}]);await uiEventually(()=>row.body.textContent==='A completed answer');row.body.getBoundingClientRect=()=>({height:row.body.childNodes.length?300:Number.parseFloat(row.body.style.minHeight)||0});Object.defineProperty(view.feed,'scrollHeight',{value:5000,configurable:true});Object.defineProperty(view.feed,'clientHeight',{value:500,configurable:true});let scrolls=0;view.scroll=()=>{scrolls++;};
  for(const top of [700,4470]){view.feed.scrollTop=top;onVisibility([{target:row.element,isIntersecting:false}]);assert.equal(row.body.childNodes.length,0);assert.equal(row.body.style.minHeight,'300px');hold=true;release=null;onVisibility([{target:row.element,isIntersecting:true}]);await uiEventually(()=>release);assert.equal(row.body.childNodes.length,0);assert.equal(row.body.style.minHeight,'300px');assert.equal(row.body.getBoundingClientRect().height,300);assert.equal(view.feed.scrollTop,top);assert.equal(scrolls,0);hold=false;release();await uiEventually(()=>row.body.textContent==='A completed answer'&&!row.running);assert.equal(row.body.style.minHeight,'');assert.equal(view.feed.scrollTop,top);assert.equal(scrolls,0);row.version++;await view.render(row);assert.equal(scrolls,0);}
  await view.onClose();
});

test('live reply following pauses on manual navigation even near the bottom and resumes only on return to bottom',async()=>{
  let emit,finish;const env=ui(async(k,m,s,d)=>{emit=d;await new Promise(resolve=>finish=resolve);return{prompt_tokens:100,completion_tokens:5};},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();Object.defineProperty(view.feed,'scrollHeight',{value:1000,configurable:true});Object.defineProperty(view.feed,'clientHeight',{value:500,configurable:true});const scrolls=[];view.feed.scrollTo=options=>{scrolls.push(options);view.feed.scrollTop=Math.min(options.top,500);};view.input.value='Answer';const pending=view.send();await uiEventually(()=>emit);scrolls.length=0;const row=[...view.rows].at(-1);emit('First');await uiEventually(()=>row.raw==='First');assert.ok(scrolls.length>0);assert.equal(view.feed.scrollTop,500);
  view.feed.scrollTop=460;view.feed.dispatchEvent(new env.dom.window.WheelEvent('wheel',{deltaY:-20,bubbles:true}));scrolls.length=0;row.lastScrollSet=0;emit(' second');await uiEventually(()=>row.raw==='First second');assert.equal(scrolls.length,0);assert.equal(view.feed.scrollTop,460);assert.equal(view.followPaused,true);await view.render(row);assert.equal(scrolls.length,0);
  row.lastScrollCheck=Date.now();env.doc.querySelector('.sd-reply-nav button:last-child').click();assert.equal(view.feed.scrollTop,500);assert.equal(view.followPaused,false);scrolls.length=0;row.lastScrollSet=0;emit(' third');await uiEventually(()=>row.raw==='First second third');assert.ok(scrolls.length>0);
  view.feed.scrollTop=450;view.feed.dispatchEvent(new env.dom.window.Event('scroll'));assert.equal(view.followPaused,true);scrolls.length=0;row.lastScrollSet=0;emit(' fourth');await uiEventually(()=>row.raw==='First second third fourth');assert.equal(scrolls.length,0);view.feed.scrollTop=500;view.feed.dispatchEvent(new env.dom.window.Event('scroll'));assert.equal(view.followPaused,false);
  view.feed.dispatchEvent(new env.dom.window.KeyboardEvent('keydown',{key:'PageUp',bubbles:true}));assert.equal(view.followPaused,true);scrolls.length=0;row.lastScrollSet=0;emit(' fifth');await uiEventually(()=>row.raw==='First second third fourth fifth');assert.equal(scrolls.length,0);finish();await pending;assert.equal(view.followingReply,null);assert.equal(view.followPaused,true);scrolls.length=0;row.version++;await view.render(row);assert.equal(scrolls.length,0);await view.onClose();
});

test('opening live thinking by pointer and keyboard keeps following through layout growth and later reasoning',async()=>{
  let reason,finish,baseHeight=1000;
  const env=ui(async(k,m,s,d,h,o)=>{reason=o.onThinking;await new Promise(resolve=>finish=()=>{d('Finished.');resolve();});return{prompt_tokens:100,completion_tokens:10};},async()=>'',{saved:{uiLanguage:'en',webEnabled:false}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();
  Object.defineProperty(view.feed,'scrollHeight',{get:()=>baseHeight+([...view.rows].at(-1)?.thinkingBody.textContent.length||0)*2,configurable:true});
  Object.defineProperty(view.feed,'clientHeight',{value:500,configurable:true});
  const scrolls=[];view.feed.scrollTo=options=>{scrolls.push(options);view.feed.scrollTop=Math.max(0,view.feed.scrollHeight-500);view.feed.dispatchEvent(new env.dom.window.Event('scroll'));};
  view.input.value='Think through the code';const pending=view.send();await uiEventually(()=>reason);const row=[...view.rows].at(-1),summary=row.thinkingBox.querySelector('summary');
  reason('First reasoning line.\n');await new Promise(setImmediate);scrolls.length=0;
  summary.dispatchEvent(new env.dom.window.Event('pointerdown',{bubbles:true}));row.thinkingBox.open=true;row.thinkingBox.dispatchEvent(new env.dom.window.Event('toggle'));await new Promise(resolve=>setTimeout(resolve,140));
  assert.equal(view.followPaused,false);assert.equal(row.thinkingBody.textContent,row.entry.thinking);assert.ok(scrolls.length>0);assert.equal(view.feed.scrollTop,view.feed.scrollHeight-500);
  baseHeight+=200;view.feed.dispatchEvent(new env.dom.window.Event('scroll'));assert.equal(view.followPaused,false,'layout growth at an unchanged scroll position must not count as manual navigation');
  reason('Later line.\n'.repeat(40));await new Promise(resolve=>setTimeout(resolve,140));assert.equal(row.thinkingBody.textContent,row.entry.thinking);assert.equal(view.feed.scrollTop,view.feed.scrollHeight-500);
  summary.dispatchEvent(new env.dom.window.Event('pointerdown',{bubbles:true}));row.thinkingBox.open=false;row.thinkingBox.dispatchEvent(new env.dom.window.Event('toggle'));assert.equal(view.followPaused,false);reason('Received while collapsed.\n');await new Promise(setImmediate);
  summary.dispatchEvent(new env.dom.window.KeyboardEvent('keydown',{key:' ',bubbles:true}));row.thinkingBox.open=true;row.thinkingBox.dispatchEvent(new env.dom.window.Event('toggle'));await new Promise(resolve=>setTimeout(resolve,140));
  assert.equal(view.followPaused,false);assert.equal(row.thinkingBody.textContent,row.entry.thinking);assert.equal(view.feed.scrollTop,view.feed.scrollHeight-500);
  const selection=env.doc.getSelection(),range=env.doc.createRange();range.setStart(row.thinkingBody.firstChild.firstChild,0);range.setEnd(row.thinkingBody.firstChild.firstChild,5);selection.addRange(range);env.doc.dispatchEvent(new env.dom.window.Event('selectionchange'));assert.equal(view.followPaused,true);
  const top=view.feed.scrollTop;scrolls.length=0;reason('Keep selection stable.\n');await new Promise(resolve=>setTimeout(resolve,140));assert.equal(selection.toString(),'First');assert.equal(scrolls.length,0);assert.equal(view.feed.scrollTop,top);
  selection.removeAllRanges();env.doc.dispatchEvent(new env.dom.window.Event('selectionchange'));assert.equal(view.followPaused,true);env.doc.querySelector('.sd-reply-nav button:last-child').click();assert.equal(view.followPaused,false);
  finish();await pending;assert.equal(view.followingReply,null);scrolls.length=0;row.thinkingView.refresh();await view.render(row);assert.equal(scrolls.length,0);await view.onClose();
});

test('expanding thinking preserves a deliberate pause and text clicks alone do not pause a following reply',async()=>{
  let reason,finish;const env=ui(async(k,m,s,d,h,o)=>{reason=o.onThinking;await new Promise(resolve=>finish=resolve);d('Done.');return{completion_tokens:2};},async()=>'',{saved:{uiLanguage:'en',webEnabled:false}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='Explain';const pending=view.send();await uiEventually(()=>reason);const row=[...view.rows].at(-1);reason('Reasoning.\n');await new Promise(setImmediate);
  row.body.dispatchEvent(new env.dom.window.Event('pointerdown',{bubbles:true}));assert.equal(view.followPaused,false);
  view.feed.dispatchEvent(new env.dom.window.WheelEvent('wheel',{deltaY:-30,bubbles:true}));assert.equal(view.followPaused,true);let scrolls=0;view.scroll=()=>{scrolls++;};
  row.thinkingBox.querySelector('summary').dispatchEvent(new env.dom.window.Event('pointerdown',{bubbles:true}));row.thinkingBox.open=true;row.thinkingBox.dispatchEvent(new env.dom.window.Event('toggle'));reason('More reasoning.\n');await new Promise(resolve=>setTimeout(resolve,140));
  assert.equal(view.followPaused,true);assert.equal(scrolls,0);assert.equal(row.thinkingBody.textContent,row.entry.thinking);finish();await pending;await view.onClose();
});

test('tool request progress shows real reception separately from thinking without saving partial parameters',async()=>{
  for(const language of ['en','zh']){
    let stream,finish;const env=ui(async(k,m,s,d,h,o)=>{stream=o;await new Promise(resolve=>finish=()=>{d('Ready.');resolve();});return{prompt_tokens:100,completion_tokens:3};},async()=>'',{saved:{uiLanguage:language,webEnabled:true}});
    await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='Read the source';const pending=view.send();await uiEventually(()=>stream);
    stream.onToolProgress({index:0,name:'stage_notebook_edits',argumentCharacters:987654321,totalArgumentCharacters:987654321,addedArgumentCharacters:987654321,callCount:1});
    assert.match(view.status.textContent,language==='en'?/Generating Notebook edits.*987,654,321 characters/:/正在生成 Notebook 修改.*987,654,321 字符/);
    stream.onThinking('Check the next step.');await new Promise(setImmediate);assert.equal(view.status.textContent,language==='en'?'Thinking…':'正在思考…');
    stream.onToolProgress({index:0,name:'fetch_page',argumentCharacters:42,totalArgumentCharacters:42,addedArgumentCharacters:42,callCount:1});assert.match(view.status.textContent,language==='en'?/Generating a tool request.*42 characters/:/正在生成工具请求.*42 字符/);
    assert.ok(!JSON.stringify(view.session).includes('987654321'));assert.ok(!view.session.messages.some(message=>message.tool_calls));finish();await pending;
    assert.equal(view.status.textContent,'');const before=JSON.stringify(view.session);stream.onToolProgress({name:'fetch_page',totalArgumentCharacters:999999999});await new Promise(setImmediate);assert.equal(view.status.textContent,'');assert.equal(JSON.stringify(view.session),before);await view.onClose();
  }
});

test('a Markdown snapshot completing after generation ends cannot restart following or move the feed',async()=>{
  let emit,finish,release,delay=false;const env=ui(async(k,m,s,d)=>{emit=d;await new Promise(resolve=>finish=resolve);return{prompt_tokens:100,completion_tokens:5};},async()=>'',{render:async text=>{if(delay&&text==='Reply text')await new Promise(resolve=>release=resolve);}});await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='Question';const pending=view.send();await uiEventually(()=>emit);const row=[...view.rows].at(-1);emit('Reply text');await uiEventually(()=>row.raw==='Reply text');delay=true;const snapshot=view.render(row);await uiEventually(()=>release);finish();await uiEventually(()=>view.followingReply===null);let scrolls=0;view.scroll=()=>{scrolls++;};const top=view.feed.scrollTop;delay=false;release();await snapshot;await pending;assert.equal(scrolls,0);assert.equal(view.feed.scrollTop,top);assert.equal(row.streaming,false);assert.equal(row.body.textContent,'Reply text');assert.equal(view.followingReply,null);await view.onClose();
});

test('explicit bottom navigation requests instant scrolling even when a theme requests smooth behavior',async()=>{
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();view.feed.style.scrollBehavior='smooth';Object.defineProperty(view.feed,'scrollHeight',{value:900,configurable:true});const requests=[];view.feed.scrollTo=options=>requests.push(options);env.doc.querySelector('.sd-reply-nav button:last-child').click();assert.equal(requests.length,1);assert.deepEqual(JSON.parse(JSON.stringify(requests[0])),{top:900,behavior:'instant'});await view.onClose();
});

async function pausedDraftPreflight(kind){
  let release,fail,generations=0;const requests=[],usage={prompt_tokens:100,completion_tokens:5},options={saved:{uiLanguage:'en'}};
  if(kind==='web')options.webHttp=()=>new Promise((resolve,reject)=>{release=()=>resolve(Buffer.from(JSON.stringify({title:'Reference',content:'Reference text'})));fail=()=>reject(Error('preflight failed'));});
  if(kind==='vision')options.visionSend=async(k,m,s,d)=>new Promise((resolve,reject)=>{release=()=>{d('The figure has a rising curve.');resolve(usage);};fail=()=>reject(Error('preflight failed'));});
  if(kind==='models')options.listModels=()=>new Promise((resolve,reject)=>{release=()=>resolve({data:[{id:'deepseek-flash',context_window:1048576,max_output_tokens:393216,input_modalities:['text','image']}]});fail=()=>reject(Error('preflight failed'));});
  const env=ui(async(k,m,s,d)=>{generations++;requests.push(structuredClone(m));d('Answer');return usage;},async()=>'',options);await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();if(kind==='vision')await view.upload(attachedImage());view.input.value='  Original question'+(kind==='web'?' @[https://example.com/ref]':'')+'\n ';const submitted=view.input.value,pending=view.send();await uiEventually(()=>release);return{env,view,pending,submitted,requests,get generations(){return generations;},release:()=>release(),fail:()=>fail()};
}

test('successful web vision and model preflight preserve a newer draft and its selection without sending it',async()=>{
  for(const kind of ['web','vision','models']){
    const testCase=await pausedDraftPreflight(kind),{view}=testCase,newDraft='  FOLLOWUP_DRAFT_DO_NOT_SEND\nwith whitespace  ';view.input.value=newDraft;view.input.setSelectionRange(4,13);testCase.release();await testCase.pending;assert.equal(testCase.generations,1,kind);assert.equal(view.input.value,newDraft,kind);assert.equal(view.input.selectionStart,4,kind);assert.equal(view.input.selectionEnd,13,kind);assert.equal(view.session.entries[0].raw,testCase.submitted.trim());assert.ok(!JSON.stringify(testCase.requests).includes('FOLLOWUP_DRAFT_DO_NOT_SEND'));assert.ok(!JSON.stringify(view.session).includes('FOLLOWUP_DRAFT_DO_NOT_SEND'));await view.onClose();
  }
});

test('successful preflight clears only the unchanged original draft including its surrounding whitespace',async()=>{
  const testCase=await pausedDraftPreflight('web');assert.equal(testCase.view.input.value,testCase.submitted);testCase.release();await testCase.pending;assert.equal(testCase.view.input.value,'');assert.equal(testCase.view.session.entries[0].raw,testCase.submitted.trim());await testCase.view.onClose();
});

test('stopped or failed web and vision preflight keep the newer draft instead of restoring the submitted text',async()=>{
  for(const kind of ['web','vision'])for(const action of ['stop','failure']){
    const testCase=await pausedDraftPreflight(kind),{view}=testCase,newDraft='NEW_DRAFT_AFTER_SEND\nkeep this';view.input.value=newDraft;view.input.setSelectionRange(2,9);if(action==='stop'){view.sendButton.click();testCase.release();}else testCase.fail();await testCase.pending;assert.equal(testCase.generations,0,kind+' '+action);assert.equal(view.input.value,newDraft);assert.equal(view.input.selectionStart,2);assert.equal(view.input.selectionEnd,9);assert.equal(view.session.entries.length,0);assert.equal(view.messages.length,0);if(kind==='vision')assert.equal(view.pendingImages.length,1);await view.onClose();
  }
});

function patchSources(state){return [...state.element.querySelectorAll('.sd-notebook-patch-source code')].map(node=>node.textContent);}
function expectedPatchSources(patch){return patch.operations.filter(op=>['set_source','insert_cell'].includes(op.type)).map(op=>op.source);}

test('context and cache metrics keep both values separate and preserve full accessible statistics without idle DOM replacement',async()=>{
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'zh'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  const nodes=[...view.metrics.childNodes],texts=nodes.map(node=>node.firstChild);for(let i=0;i<20;i++)view.refreshStats();
  assert.deepEqual([...view.metrics.childNodes],nodes);assert.deepEqual(nodes.map(node=>node.firstChild),texts);
  assert.deepEqual([...view.metrics.querySelectorAll('.sd-metric-value')].map(node=>node.textContent),['0.0%','暂无数据']);assert.ok(view.metrics.querySelector('.sd-metric-note').matches(':empty'));
  view.session.cache={hit:80,miss:20,measured:1,unknown:1};view.refreshStats();assert.match(view.metrics.textContent,/缓存总命中率 80\.0%（仅已返回统计的请求）/);assert.equal(view.metrics.getAttribute('aria-label'),view.metrics.textContent);assert.ok(view.metrics.querySelector('.sd-metric-note-text'));assert.match(view.metrics.title,/1,000,000/);
  env.plugin.uiLanguage='en';view.refreshLanguage();assert.match(view.metrics.getAttribute('aria-label'),/Total cache hit 80\.0%/);assert.match(view.metrics.textContent,/Context 0\.0%/);assert.equal(view.metrics.parentElement,env.doc.querySelector('.sd-history'));await view.onClose();
});

test('composer keyboard order matches the compact toolbar and reasoning remains last',async()=>{
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  const controls=[...env.doc.querySelector('.sd-actions').querySelectorAll('button,input,select')],speed=env.doc.querySelector('.sd-speed input');
  assert.deepEqual(controls,[view.uploadButton,view.sendButton,view.compressButton,view.clearButton,speed,view.searchFetchToggle,view.effortSelect]);assert.equal(speed.max,'301');assert.equal(speed.value,'301');assert.equal(view.effortSelect.value,'low');assert.equal(view.notebookPanel.hidden,true);await view.onClose();
});

test('conversation search keeps only its current highlight without a forced layout read',async()=>{
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  for(const label of ['你','deepseek-flash']){const state=view.row(label,'needle');state.element.scrollIntoView=()=>{};Object.defineProperty(state.element,'offsetWidth',{get(){throw Error('search must not force synchronous layout');}});}
  const button=env.doc.querySelector('button[title="Search this conversation"]');button.click();view.searchInput.value='needle';view.findNext();const first=env.doc.querySelector('.sd-search-hit');assert.ok(first);view.findNext();const second=env.doc.querySelector('.sd-search-hit');assert.ok(second);assert.notEqual(second,first);assert.equal(env.doc.querySelectorAll('.sd-search-hit').length,1);button.click();assert.equal(env.doc.querySelector('.sd-search-hit'),null);assert.equal(view.searchHit,null);await view.onClose();
});

test('Notebook scripts stay readable after Markdown commits without JSON-escaped source or archive changes',async()=>{
  const api=require('./src/notebook'),buffer=new api.NotebookEditBuffer(notebookUiFixture());
  const operations=reviewOperations(8);operations[2].source='from pathlib import Path\n\nSCRIPT = """\n'+('print("line")\n'.repeat(900))+'"""\nPath("engine.py").write_text(SCRIPT)\n';
  buffer.stage({baseHash:buffer.currentHash,operations,done:true});const patch=buffer.result();
  const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();
  view.row('你','Write scripts');const entry={label:'deepseek-flash',raw:'Scripts ready.',notebookPatch:patch,notebookApplied:true},state=view.row(entry.label,entry.raw,entry);
  const archived=JSON.stringify(view.session);await view.render(state);
  assert.deepEqual(patchSources(state),expectedPatchSources(patch));assert.equal(state.body.textContent,'Scripts ready.');
  assert.ok(patchSources(state)[2].includes('Path("engine.py").write_text(SCRIPT)\n'));assert.ok(!patchSources(state)[2].includes('\\n'));
  assert.equal(state.element.querySelector('img'),null);assert.equal(state.element.querySelector('script'),null);assert.equal(state.element.querySelector('.sd-notebook-apply').disabled,true);
  assert.ok(env.renders.every(render=>!render.text.includes('notebook-patch')));state.element.querySelector('.sd-message-footer .sd-icon-button').click();await new Promise(setImmediate);
  assert.deepEqual(api.parsePatch(env.copies.at(-1)),patch);assert.equal(JSON.stringify(view.session),archived);await view.onClose();
});

test('late offscreen observations cannot remove visible live thinking or visible Notebook source',async()=>{
  let observe,reason,finish;class Observer{constructor(callback){observe=callback;}observe(){}unobserve(){}disconnect(){}}
  const env=ui(async(k,m,s,d,h,o)=>{reason=o.onThinking;await new Promise(resolve=>finish=()=>{d('Finished');resolve();});return{prompt_tokens:100,completion_tokens:4};},async()=>'',{IntersectionObserver:Observer,saved:{uiLanguage:'en',webEnabled:false}});
  await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();
  const rect=(top,bottom)=>({left:0,right:500,top,bottom,width:500,height:bottom-top});view.feed.getBoundingClientRect=()=>rect(0,400);
  view.input.value='Think through the problem';const sending=view.send();await uiEventually(()=>reason);const state=[...view.rows].at(-1);
  state.element.getBoundingClientRect=()=>rect(100,300);state.thinkingBox.getBoundingClientRect=()=>rect(120,260);
  reason('First reasoning segment.\n');state.thinkingBox.open=true;state.thinkingBox.dispatchEvent(new env.dom.window.Event('toggle'));
  observe([{target:state.element,isIntersecting:false}]);reason('Later reasoning segment.\n');await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(state.virtualVisible,true);assert.equal(state.thinkingBody.textContent,'First reasoning segment.\nLater reasoning segment.\n');assert.ok(view.controller);
  state.entry.notebookPatch={baseHash:'a'.repeat(64),operations:reviewOperations(2)};state.patchView.refresh();observe([{target:state.element,isIntersecting:false}]);
  assert.deepEqual(patchSources(state),expectedPatchSources(state.entry.notebookPatch));finish();await sending;await view.onClose();
});

function reviewOperations(count){return Array.from({length:count},(_,index)=>({type:'insert_cell',cellId:'review-'+index,cellType:index%2?'markdown':'code',source:index%2?'## Review '+index:'print("safe '+index+'")\nexample = "<img src=x onerror=alert(1)>"'}));}

test('complete two-operation and six-operation patches expose disabled actions before final Markdown and release Send while it is pending',async()=>{
  for(const count of [2,6]){
    const api=require('./src/notebook'),actual=notebookUiFixture();let calls=0,finishAnswer,releaseMarkdown,applied=0;
    const env=ui(async(k,m,s,d,h,o)=>{if(calls++===0)o.onToolCalls([functionCall('prepare-review','stage_notebook_edits',{baseHash:api.notebookHash(actual),operations:reviewOperations(count),done:true})]);else await new Promise(resolve=>finishAnswer=()=>{d('Prepared for review.');resolve();});return{prompt_tokens:100,completion_tokens:10};},async()=>'',{saved:{uiLanguage:'en',webEnabled:false},render:async text=>{if(text==='Prepared for review.')await new Promise(resolve=>releaseMarkdown=resolve);}});
    await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient={read:()=>structuredClone(actual),applyPatch:async()=>{applied++;assert.fail('review must not apply automatically');},close(){}};view.input.value='Prepare code';const sending=view.send();await uiEventually(()=>finishAnswer);const state=[...view.rows].at(-1),button=state.element.querySelector('.sd-notebook-apply');assert.ok(button);assert.equal(button.disabled,true);assert.equal(state.entry.notebookPatch.operations.length,count);assert.equal(state.streaming,true);finishAnswer();await uiEventually(()=>releaseMarkdown);await sending;
    assert.equal(view.controller,null);assert.equal(view.sendButton.textContent,'Send');assert.equal(button.disabled,false);assert.equal(state.streaming,false);assert.equal(applied,0);assert.deepEqual(patchSources(state),expectedPatchSources(state.entry.notebookPatch));assert.equal(state.body.querySelector('img'),null);assert.equal(state.entry.raw,'Prepared for review.');const history=JSON.stringify(view.messages);state.element.querySelector('.sd-message-footer .sd-icon-button').click();await new Promise(setImmediate);assert.match(env.copies.at(-1),/notebook-patch/);assert.match(env.copies.at(-1),/safe 0/);
    releaseMarkdown();await uiEventually(()=>!state.running&&state.rendered===state.version);assert.equal(state.body.textContent,'Prepared for review.');assert.deepEqual(patchSources(state),expectedPatchSources(state.entry.notebookPatch));assert.equal(state.element.querySelectorAll('.sd-notebook-apply').length,1);assert.equal(JSON.stringify(view.messages),history);await view.onClose();
  }
});

test('restored offscreen patches have review actions before lazy Markdown renders and show complete inert previews on entry',async()=>{
  for(const count of [2,6]){
    const api=require('./src/notebook'),base=notebookUiFixture(),buffer=new api.NotebookEditBuffer(base);buffer.stage({baseHash:buffer.currentHash,operations:reviewOperations(count),done:true});const patch=buffer.result(),id='conversation-review-'+count;let visible,releaseMarkdown;class Observer{constructor(callback){visible=callback;}observe(){}unobserve(){}disconnect(){}}
    const entries=[{label:'你',raw:'Prepare code'},{label:'deepseek-flash',raw:'Prepared for review.',notebookPatch:patch}],session={entries,messages:[{role:'user',content:'Prepare code'},{role:'assistant',content:'Prepared for review.'}],meter:null,compactions:0,cache:null};const env=ui(async()=>{},async()=>'',{saved:{uiLanguage:'en',activeConversationId:id},conversationState:new Map([[id,{id,createdAt:1,session}]]),IntersectionObserver:Observer,render:async text=>{if(text==='Prepared for review.')await new Promise(resolve=>releaseMarkdown=resolve);}});await env.plugin.onload();const view=env.plugin.factory({});await view.onOpen();const state=[...view.rows].at(-1),button=state.element.querySelector('.sd-notebook-apply');assert.ok(button);assert.equal(button.disabled,false);assert.equal(state.body.childNodes.length,0);assert.equal(view.controller,null);visible([{target:state.element,isIntersecting:true}]);await uiEventually(()=>releaseMarkdown);assert.deepEqual(patchSources(state),expectedPatchSources(patch));assert.equal(state.body.querySelector('img'),null);assert.equal(state.element.querySelector('.sd-notebook-apply'),button);releaseMarkdown();await uiEventually(()=>!state.running&&state.rendered===state.version);assert.deepEqual(patchSources(state),expectedPatchSources(patch));assert.equal(state.entry.notebookPatch.operations.length,count);assert.equal(state.element.querySelectorAll('.sd-notebook-apply').length,1);await view.onClose();
  }
});

test('stopping or failing after a complete patch keeps review and safe code visible despite an unfinished Markdown snapshot',async()=>{
  for(const ending of ['stop','failure']){
    const api=require('./src/notebook'),actual=notebookUiFixture();let calls=0,failAnswer,releaseMarkdown,heldMarkdown=false;
    const env=ui(async(k,m,s,d,h,o)=>{if(calls++===0){o.onToolCalls([functionCall('complete-before-interruption','stage_notebook_edits',{baseHash:api.notebookHash(actual),operations:reviewOperations(2),done:true})]);return{prompt_tokens:100,completion_tokens:5};}d('Partial summary');await new Promise((resolve,reject)=>{failAnswer=()=>reject(Error('reply interrupted'));s.addEventListener('abort',()=>reject(Object.assign(Error('stopped'),{name:'AbortError'})),{once:true});});},async()=>'',{saved:{uiLanguage:'en',webEnabled:false},render:async text=>{if(text==='Partial summary'&&!heldMarkdown){heldMarkdown=true;await new Promise(resolve=>releaseMarkdown=resolve);}}});await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.notebookMode=true;view.notebookClient={read:()=>structuredClone(actual),close(){}};view.input.value='Prepare code';const sending=view.send();await uiEventually(()=>failAnswer);const state=[...view.rows].at(-1);await uiEventually(()=>state.raw==='Partial summary');const rendering=view.render(state);await uiEventually(()=>releaseMarkdown);const history=JSON.stringify(view.messages);if(ending==='stop')view.sendButton.click();else failAnswer();await sending;assert.equal(view.controller,null);assert.equal(state.streaming,false);assert.equal(state.element.querySelector('.sd-notebook-apply').disabled,false);assert.deepEqual(patchSources(state),expectedPatchSources(state.entry.notebookPatch));assert.equal(state.body.querySelector('img'),null);assert.equal(state.entry.raw,'Partial summary');assert.equal(JSON.stringify(view.messages),history);releaseMarkdown();await rendering;await uiEventually(()=>!state.running);assert.equal(state.element.querySelectorAll('.sd-notebook-apply').length,1);assert.equal(state.element.querySelector('.sd-notebook-apply').disabled,false);assert.deepEqual(patchSources(state),expectedPatchSources(state.entry.notebookPatch));assert.equal(JSON.stringify(view.messages),history);assert.equal(actual.cells.length,2);await view.onClose();
  }
});

test('ordinary replies keep waiting for their final Markdown renderer when no Notebook patch exists',async()=>{
  let releaseMarkdown,finished=false;const env=ui(async(k,m,s,d)=>{d('Ordinary reply');return{prompt_tokens:100,completion_tokens:5};},async()=>'',{render:async text=>{if(text==='Ordinary reply')await new Promise(resolve=>releaseMarkdown=resolve);}});await env.plugin.onload();env.plugin.keys.deepseek='fake';const view=env.plugin.factory({});await view.onOpen();view.input.value='Question';const sending=view.send().then(()=>finished=true);await uiEventually(()=>releaseMarkdown);await new Promise(setImmediate);assert.equal(finished,false);assert.ok(view.controller);assert.equal(view.session.entries[1].notebookPatch,undefined);assert.equal(env.doc.querySelector('.sd-notebook-apply'),null);assert.equal(env.doc.querySelector('.sd-notebook-patch-preview'),null);releaseMarkdown();await sending;assert.equal(finished,true);assert.equal(view.controller,null);assert.equal([...view.rows].at(-1).body.textContent,'Ordinary reply');await view.onClose();
});

test('slow conversation recycling locks review actions and failed recycling restores only unapplied actions',async()=>{
  for(const applied of [false,true]){
    const {env,view,state,entry}=await completedNotebookUi();const button=env.doc.querySelector('.sd-notebook-apply');if(applied){button.click();await uiEventually(()=>env.doc.querySelector('.sd-confirm'));env.doc.querySelector('.sd-confirm .mod-cta').click();await uiEventually(()=>state.applied===1&&!view.applyingNotebookPatch);}let failTrash;env.plugin.conversationStore.remove=()=>new Promise((resolve,reject)=>failTrash=()=>reject(Error('trash unavailable')));const clearing=view.clear();await uiEventually(()=>failTrash);assert.equal(view.clearing,true);assert.equal(button.disabled,true);const before=state.applied;button.click();button.dispatchEvent(new env.dom.window.MouseEvent('click',{bubbles:true}));await new Promise(setImmediate);assert.equal(env.doc.querySelector('.sd-confirm'),null);assert.equal(state.applied,before);failTrash();await clearing;assert.equal(view.clearing,false);assert.equal(button.disabled,applied);assert.equal(!!entry.notebookApplied,applied);assert.equal(state.applied,before);await view.onClose();
  }
});

test('a review confirmation cannot apply a Notebook patch while conversation recycling is pending',async()=>{
  const {env,view,state,entry}=await completedNotebookUi();env.doc.querySelector('.sd-notebook-apply').click();await uiEventually(()=>env.doc.querySelector('.sd-confirm'));let failTrash;env.plugin.conversationStore.remove=()=>new Promise((resolve,reject)=>failTrash=()=>reject(Error('trash unavailable')));const clearing=view.clear();await uiEventually(()=>failTrash);env.doc.querySelector('.sd-confirm .mod-cta').click();await new Promise(setImmediate);assert.equal(state.applied,0);assert.equal(entry.notebookApplied,undefined);assert.equal(env.doc.querySelector('.sd-confirm'),null);failTrash();await clearing;assert.equal(state.applied,0);assert.equal(env.doc.querySelector('.sd-notebook-apply').disabled,false);await view.onClose();
});
