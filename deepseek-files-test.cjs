const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { uploadFile, validateFiles, fileOptions, fileIds, FILE_LIFETIME_SECONDS } = require('./src/deepseek-files');

const file = (name = 'paper.pdf', raw = Buffer.from('%PDF-test')) => ({ name, size: raw.length, arrayBuffer: async () => raw });
const signal = () => new AbortController().signal;
const json = data => Buffer.from(JSON.stringify(data));

test('Files upload puts purpose before file, sets expiry, hashes content, and allows parsing time', async () => {
  const uploaded = await uploadFile(file(), 'fake-key', signal(), { request: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/files');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer fake-key');
    const body = options.body.toString();
    assert.ok(body.indexOf('name="purpose"') < body.indexOf('name="file"'));
    assert.match(body, /rich_layout_recognition/);
    assert.match(body, /expires_after\[anchor\]/);
    assert.ok(body.includes(String(FILE_LIFETIME_SECONDS)));
    assert.ok(options.idleTimeoutMs >= 240000);
    return json({ id: 'file-api-paper', expires_at: 1900000000 });
  }});
  assert.deepEqual(uploaded, { id: 'file-api-paper', name: 'paper.pdf', purpose: 'rich_layout_recognition', hash: createHash('sha256').update('%PDF-test').digest('hex'), bytes: 9, expiresAt: 1900000000 });
});

test('Files purpose and size reflect document, image, and text limits', () => {
  for (const name of ['x.PDF','x.doc','x.docx','x.ppt','x.pptx']) assert.deepEqual(fileOptions(name), { purpose:'rich_layout_recognition', maxBytes:100*1024*1024 });
  for (const name of ['x.jpeg','x.png','x.webp','x.gif']) assert.deepEqual(fileOptions(name), { purpose:'user_data', maxBytes:64*1024*1024 });
  for (const name of ['x.md','x.py','x.csv','x.xlsx','x.epub']) assert.deepEqual(fileOptions(name), { purpose:'user_data', maxBytes:32*1024*1024 });
});

test('Files reject size violations, changing files and cancellation before uploading', async () => {
  const options = { request: () => assert.fail('must not upload') };
  await assert.rejects(uploadFile({ ...file(), size:101*1024*1024 }, 'key', signal(), options), /100 MiB/);
  await assert.rejects(uploadFile({ ...file(), size:0 }, 'key', signal(), options), /1 byte/);
  await assert.rejects(uploadFile({ ...file(), size:2 }, 'key', signal(), options), /changed/);
  const controller = new AbortController();controller.abort();
  await assert.rejects(uploadFile(file(), 'key', controller.signal, options), { name:'AbortError' });
});

test('Files filenames cannot add multipart headers and returned IDs are validated', async () => {
  await assert.rejects(uploadFile(file('x"\r\nmalicious.pdf'), 'key', signal(), { request: async (_url, options) => {
    assert.match(options.body.toString(), /filename="x___malicious.pdf"/);
    return json({ id:'../../bad' });
  }}), /invalid file ID/);
});

test('Files validates each unique referenced ID and ignores ordinary strings', async () => {
  const messages = [{ role:'user', content:'file-api-not-a-reference' },{ role:'user', content:[{type:'text',text:'Question'},{type:'file',file_id:'file-api-a'},{type:'file',file_id:'file-api-a'}] }];
  assert.deepEqual(fileIds(messages), ['file-api-a']);let calls=0;
  const result = await validateFiles(messages, 'key', signal(), { request: async url => { calls++;assert.ok(url.endsWith('/file-api-a'));return json({id:'file-api-a'}); } });
  assert.equal(calls,1);assert.equal(result.length,1);
});

test('Files unavailable errors identify the file for reattachment and preserve unrelated service errors', async () => {
  const messages = [{role:'user',content:[{type:'file',file_id:'file-api-a'}]}];
  for (const mode of ['missing','expired','deleted']) {
    await assert.rejects(validateFiles(messages, 'key', signal(), {request:async()=>{
      if(mode==='missing')throw Object.assign(new Error('HTTP 404'),{status:404});
      return json({id:'file-api-a', ...(mode==='expired'?{expires_at:1}:{deleted:true})});
    }}), {code:'FILE_UNAVAILABLE',fileId:'file-api-a'});
  }
  const network = new Error('network unavailable');
  await assert.rejects(validateFiles(messages, 'key', signal(), {request:async()=>{throw network;}}), error=>error===network);
});

test('Files errors recognize the shared transport HTTP status fields', async () => {
  const messages = [{role:'user',content:[{type:'file',file_id:'file-api-a'}]}];
  await assert.rejects(validateFiles(messages,'key',signal(),{request:async()=>{throw Object.assign(new Error('missing'),{httpStatus:404});}}), {code:'FILE_UNAVAILABLE'});
  await assert.rejects(uploadFile(file(),'key',signal(),{request:async()=>{throw Object.assign(new Error('expired key'),{httpStatus:401});}}), {authExpired:true,authService:'deepseek'});
});
