const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { clipboardAttachments, materializeClipboardAttachment } = require('./src/clipboard');

test('paste detects image and PDF files while leaving ordinary text alone', async () => {
  const image = { name: '', type: 'image/png', size: 4, arrayBuffer: async () => Buffer.from([1, 2, 3, 4]) };
  const pdf = { name: 'paper.pdf', type: 'application/pdf', size: 5, arrayBuffer: async () => Buffer.from('%PDF!') };
  const candidates = clipboardAttachments({ files: [image, pdf], items: [] });
  assert.deepEqual(candidates.map(item => item.name), ['clipboard.png', 'paper.pdf']);
  assert.equal((await materializeClipboardAttachment(candidates[0])).name, 'clipboard.png');
  assert.deepEqual(clipboardAttachments({ files: [], items: [], getData: () => 'ordinary text' }), []);
  assert.equal(clipboardAttachments({ files: [], items: [{ kind: 'file', getAsFile: () => image }] })[0].name, 'clipboard.png');
});

test('paste resolves file URI and Windows FileNameW only for supported local files', async () => {
  const filePath = path.join(__dirname, 'sample.pdf');
  const uri = pathToFileURL(filePath).href;
  const candidate = clipboardAttachments({ files: [], items: [], getData: type => type === 'text/uri-list' ? uri : '' })[0];
  assert.equal(candidate.filePath, filePath);
  const file = await materializeClipboardAttachment(candidate, { stat: async () => ({ isFile: () => true, size: 4 }), readFile: async () => Buffer.from('%PDF') });
  assert.equal(file.name, 'sample.pdf'); assert.equal(file.size, 4);
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), '%PDF');
  if (process.platform === 'win32') {
    const fromExplorer = clipboardAttachments({ files: [], items: [], getData: () => '' }, { availableFormats: () => ['FileNameW'], readBuffer: () => Buffer.from(filePath + '\0', 'utf16le') }, 'win32');
    assert.equal(fromExplorer[0].filePath, filePath);
  }
});

test('chat paste supports the same document formats as the picker for files and local URIs', () => {
  const names = ['paper.DOCX', 'data.xlsx', 'notes.md', 'figure.tif'];
  const direct = clipboardAttachments({ files: [...names, 'conversion-only.jp2'].map(name => ({name})) });
  assert.deepEqual(direct.map(item => item.name), names);
  const paths = names.map(name => path.join(__dirname, name));
  const uris = paths.map(file => pathToFileURL(file).href).join('\r\n');
  assert.deepEqual(clipboardAttachments({ getData: () => uris }).map(item => item.filePath), paths);
  assert.equal(clipboardAttachments({ files: [{name:'',type:'image/tiff'}] })[0].name,'clipboard.tiff');
});
