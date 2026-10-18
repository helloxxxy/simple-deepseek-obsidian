const test = require('node:test');
const assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');
const {sanitizeReferenceText,stripLongBase64} = require('./src/text-safety');
const {safeWebText,WebReferences} = require('./src/web');
const {safeVisionText} = require('./src/vision');
const {safeNotebook,notebookContext,notebookDelta,resultJson} = require('./src/notebook');
const {imageReference,imageReferenceBlocks} = require('./src/image-context');
const {ImageStore} = require('./src/images');

const line = 'A'.repeat(76), final = 'TQ==';
const wrapped = (separator = '\n', indent = '') => 'data:image/png;base64,'+Array(20).fill(line).concat(final).join(separator+indent);
const assertSafe = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!text.includes(line)); assert.ok(!text.includes(final));
  assert.ok(!text.toLowerCase().includes('data:image/'));
};

test('reference sanitization removes wrapped image payloads and indented padded tails', () => {
  for (const separator of ['\n','\r\n','\r','\\n','\\r\\n','\\\n']) for (const indent of ['','  ','\t']) {
    const input = 'Before '+wrapped(separator,indent)+separator+'Keep this paragraph.\nprint("ready")';
    const result = sanitizeReferenceText(input);
    assertSafe(result); assert.match(result,/Before \[image data omitted\]/);
    assert.ok(result.includes('Keep this paragraph.')); assert.ok(result.includes('print("ready")'));
    assert.equal(sanitizeReferenceText(result),result);
  }
});

test('a Base64 prefix can be followed by whitespace and wrapped lines before the padded final line', () => {
  const input = 'data:image/webp;base64,\n  '+line+'\n\n\t'+line+'\r\n  '+final+'\nAfter the image.';
  assert.equal(sanitizeReferenceText(input),'[image data omitted]\nAfter the image.');
});

test('following ordinary prose, formulas, paths and code are not consumed as image continuations', () => {
  const prose = [
    'This paragraph follows the image.', 'Conclusion', '## Findings',
    'return "ready"', 'print("ready")', 'result = x + y', 'E = mc^2',
    '$$\\sum_{i=1}^{n} x_i$$', 'alpha_beta = 1', 'https://example.com/page',
    'const path = "C:/example/file.txt";', 'The answer is 42.',
    'A'.repeat(31), 'x'.repeat(76)+' = value'
  ];
  for (const tail of prose) {
    const result = sanitizeReferenceText('data:image/png;base64,'+line+'\n'+tail);
    assert.equal(result,'[image data omitted]\n'+tail,tail);
  }
  const ordinary = 'Equation: $x^2+y^2=z^2$\n```python\ntext = "aGVsbG8="\npath = "../images/plot.png"\n```';
  assert.equal(sanitizeReferenceText(ordinary),ordinary);
});

test('quoted image values keep their closing syntax and short final encoded fragments are removed', () => {
  for (const close of ['"',"'",')','`','>']) {
    const input = 'data:image/png;base64,'+line+'\n'+line+'\nTWE'+close+'\nVisible text.';
    assert.equal(sanitizeReferenceText(input),'[image data omitted]'+close+'\nVisible text.');
  }
  assert.equal(sanitizeReferenceText('<img src="'+wrapped()+'">\nNext.'),'<img src="[image data omitted]">\nNext.');
});

test('existing unbroken Base64 filtering and caller-specific SVG policies remain intact', () => {
  const long = 'Q'.repeat(400)+'==';
  assert.equal(stripLongBase64('before '+long+' after'),'before [binary data omitted] after');
  assert.equal(sanitizeReferenceText('Q'.repeat(399)),'Q'.repeat(399));
  assert.equal(sanitizeReferenceText('data:image/svg+xml,%3Csvg%3E'),'[image data omitted]');
  const svg = '<svg><path d="M0 0"/></svg>';
  assert.equal(safeWebText(svg),svg); assert.equal(safeVisionText(svg),'[image markup omitted]');
});

test('web hidden references and archived tool results cannot retain wrapped image Base64', async () => {
  const retained = [];
  const web = new WebReferences({key:'key',onReference:reference => retained.push(reference),http:async () => Buffer.from(JSON.stringify({content:'Web text\n'+wrapped()+'\nKeep this evidence.',title:wrapped()}))});
  const result = await web.execute('fetch_page',{url:'https://example.com/page'});
  assertSafe(result); assertSafe(retained);
  assert.ok(result.includes('Keep this evidence.'));
  const archive = JSON.stringify({session:{messages:[{role:'tool',tool_call_id:'call',content:result}],entries:[{contextText:retained[0].content}]}});
  assertSafe(archive);
});

test('Notebook source and stream outputs are filtered for safe context and result JSON without editing originals', () => {
  const original = {cells:[{id:'code',cell_type:'code',source:'image = """'+wrapped('\n','  ')+'"""\nprint("ready")',outputs:[{output_type:'stream',name:'stdout',text:'Preview '+wrapped()+'\nvalue: 42'}]}]};
  const before = JSON.stringify(original), safe = safeNotebook(original);
  for (const value of [safe,notebookContext(notebookDelta(original,null)),resultJson(original),JSON.stringify({session:{messages:[{role:'user',content:notebookContext(notebookDelta(original,null))}]}})]) assertSafe(value);
  assert.ok(safe.cells[0].source.includes('print("ready")'));
  assert.ok(safe.cells[0].outputs[0].text.includes('value: 42'));
  assert.equal(JSON.stringify(original),before);
});

test('image descriptions, names and hidden reference identities remain safe and round-trip through JSON', async () => {
  const bytes = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  const store = new ImageStore({decodeDimensions:async () => ({width:64,height:64}),send:async (_key,messages,_signal,onText) => {
    assertSafe(messages[0].content[0].text);
    onText('A curve\n'+wrapped()+'\nThe axis is time.');
  }});
  const image = await store.add({name:wrapped(),size:bytes.length,arrayBuffer:async () => bytes});
  assertSafe(image);
  const result = await store.describe([image.id],'Read '+wrapped()+'\nExplain the axis.',{key:'key'});
  assertSafe(result); assert.match(result.text,/The axis is time/);
  const reference = imageReference(result,'Read '+wrapped()+'\nExplain the axis.');
  assertSafe(reference);
  const archive = JSON.parse(JSON.stringify({session:{entries:[{images:result.images,contextText:reference}],messages:[{role:'user',content:reference}]}}));
  assertSafe(archive); assert.equal(imageReferenceBlocks(archive.session.messages[0].content).length,1);
  store.clear();
});

test('large wrapped and near-threshold inputs are processed without repeated suffix rescans', () => {
  const fragment = 'data:image/png;base64,'+line+'\n  '+line+'\n'+final+'\nKeep the following prose.\n';
  const input = fragment.repeat(4000)+'\n'+('x'.repeat(399)+';').repeat(4000), start = performance.now();
  const result = sanitizeReferenceText(input);
  assert.equal(result,('[image data omitted]\nKeep the following prose.\n').repeat(4000)+'\n'+('x'.repeat(399)+';').repeat(4000));
  assert.ok(performance.now()-start < 4000);
});
