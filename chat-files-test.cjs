const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const vm = require('node:vm');
const {prepareFile, contentWithFiles, attachmentMetadata} = require('./src/chat-files');

function session() { return {messages:[],entries:[],meter:{tokens:90}}; }
function file(name = 'paper.pdf', bytes = Buffer.from('%PDF-1.7 example')) {
  return {name,size:bytes.length,arrayBuffer:async () => bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
}
function signal() { return new AbortController().signal; }
function metadata(id = 'file-api-original') {
  return {id,name:'paper.pdf',hash:createHash('sha256').update('%PDF-1.7 example').digest('hex'),purpose:'rich_layout_recognition',bytes:16,expiresAt:2000000000};
}
const now = () => 1900000000000;

test('preparing chat attachment uploads binary separately and stores allowlisted metadata only', async () => {
  const current = session();
  const result = await prepareFile(file(),current,'key',signal(),{now,upload:async (input,key) => {
    assert.equal(key,'key'); assert.equal(input.name,'paper.pdf');
    assert.equal(Buffer.from(await input.arrayBuffer()).toString(),'%PDF-1.7 example');
    return {...metadata(),bytes:input.size,unwantedBinary:Buffer.from('secret'),file_data:'base64'};
  }});
  assert.deepEqual(Object.keys(result).sort(),['bytes','expiresAt','hash','id','name','purpose'].sort());
  assert.deepEqual(current.files,[result]);
  assert.ok(!JSON.stringify(current).includes('base64'));
  assert.ok(!JSON.stringify(current).includes('%PDF'));
  assert.equal(current.messages.length,0);
});

test('matching content reuses a verified cloud file without uploading again', async () => {
  const current = session(), previous = metadata(); current.files = [previous];
  let checks = 0;
  const result = await prepareFile(file(),current,'key',signal(),{now,validate:async messages => {
    checks++; assert.deepEqual(messages,[{role:'user',content:[{type:'file',file_id:previous.id}]}]);
  },upload:async () => { throw new Error('unexpected upload'); }});
  assert.equal(result,previous); assert.equal(checks,1); assert.equal(current.files.length,1);
});

test('expired same-content reupload renews both active and archived message IDs and metadata', async () => {
  const current = session(), previous = {...metadata(),expiresAt:100};
  current.files = [previous];
  const message = {role:'user',content:[{type:'text',text:'Question'},{type:'file',file_id:previous.id}]};
  current.messages.push(structuredClone(message));
  current.entries.push({label:'you',raw:'Question',files:[{...previous}],modelMessages:[structuredClone(message)]});
  const result = await prepareFile(file(),current,'key',signal(),{now,upload:async () => metadata('file-api-renewed')});
  assert.equal(current.messages[0].content[1].file_id,result.id);
  assert.equal(current.entries[0].modelMessages[0].content[1].file_id,result.id);
  assert.equal(current.entries[0].files[0].expiresAt,result.expiresAt);
  assert.equal(current.entries[0].raw,'Question');
  assert.equal(current.meter,null); assert.deepEqual(current.files,[result]);
});

test('deleted cloud file is renewed while unrelated validation failures propagate unchanged', async () => {
  const current = session(); current.files = [metadata()];
  const upload = async () => metadata('file-api-renewed');
  const unavailable = Object.assign(new Error('missing'),{code:'FILE_UNAVAILABLE'});
  const result = await prepareFile(file(),current,'key',signal(),{now,validate:async () => { throw unavailable; },upload});
  assert.equal(result.id,'file-api-renewed');
  const denied = Object.assign(new Error('denied'),{httpStatus:401});
  await assert.rejects(prepareFile(file(),current,'key',signal(),{now,validate:async () => { throw denied; },upload}), error => error === denied);
});

test('same bytes with a different parsing purpose get an independent cloud record', async () => {
  const current = session(); current.files = [metadata()];
  const result = await prepareFile(file('paper.txt'),current,'key',signal(),{now,upload:async () => ({...metadata('file-api-text'),purpose:'user_data',name:'paper.txt'})});
  assert.equal(current.files.length,2); assert.equal(result.id,'file-api-text');
});

test('size limits are checked before a local file is read and changed files are rejected', async () => {
  let reads = 0;
  const huge = {name:'paper.pdf',size:101*1024*1024,arrayBuffer:async () => { reads++; }};
  await assert.rejects(prepareFile(huge,session(),'key',signal()),/100 MiB/);
  assert.equal(reads,0);
  await assert.rejects(prepareFile({...file(),size:999},session(),'key',signal()),/changed while being read/);
});

test('aborting local read promptly returns and never mutates cloud references', async () => {
  const current = session(), controller = new AbortController();
  let finishRead, uploaded = false;
  const input = {name:'paper.pdf',size:2,arrayBuffer:() => new Promise(resolve => { finishRead = resolve; })};
  const pending = prepareFile(input,current,'key',controller.signal,{upload:async () => { uploaded = true; }});
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  finishRead(new Uint8Array([1,2]).buffer);
  await Promise.resolve();
  assert.equal(uploaded,false); assert.equal(current.files,undefined);
});

test('a late upload response after abort leaves earlier history intact', async () => {
  const current = session(), controller = new AbortController(), previous = {...metadata(),expiresAt:1};
  current.files = [previous];
  let finishUpload;
  const pending = prepareFile(file(),current,'key',controller.signal,{upload:() => new Promise(resolve => { finishUpload = resolve; })});
  while (!finishUpload) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); finishUpload(metadata('file-api-late'));
  await assert.rejects(pending,{name:'AbortError'});
  assert.deepEqual(current.files,[previous]); assert.deepEqual(current.meter,{tokens:90});
});

test('browser-realm ArrayBuffers and offset views hash exactly the file bytes', async () => {
  const current = session();
  const source = vm.runInNewContext('new Uint8Array([1,2,3]).buffer');
  const result = await prepareFile({name:'data.txt',size:3,arrayBuffer:async () => source},current,'key',signal(),{upload:async () => ({...metadata(),purpose:'user_data'})});
  assert.equal(result.hash,createHash('sha256').update(Buffer.from([1,2,3])).digest('hex'));
  const view = new Uint8Array([9,1,2,3,8]).subarray(1,4);
  const other = await prepareFile({name:'data.txt',size:3,arrayBuffer:async () => view},session(),'key',signal(),{upload:async () => ({...metadata(),purpose:'user_data'})});
  assert.equal(other.hash,result.hash);
});

test('native request includes new files once and reuses existing full-history references', () => {
  const old = metadata('file-api-old'), fresh = metadata('file-api-new');
  const history = [{role:'user',content:[{type:'text',text:'Earlier'},{type:'file',file_id:old.id}]}];
  assert.deepEqual(contentWithFiles('Next',[old,fresh,fresh],history),[{type:'text',text:'Next'},{type:'file',file_id:fresh.id}]);
  assert.equal(contentWithFiles('Next',[old],history),'Next');
  assert.deepEqual(contentWithFiles('Again',[old],[]),[{type:'text',text:'Again'},{type:'file',file_id:old.id}]);
});

test('attachment metadata excludes local paths, buffers and inline image payloads', () => {
  const record = metadata();
  assert.deepEqual(attachmentMetadata({...record,path:'C:/private/paper.pdf',file_data:'data:image/png;base64,AAAA',buffer:Buffer.from('x')}),record);
});
