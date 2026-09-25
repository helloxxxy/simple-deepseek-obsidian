const { test } = require('node:test');
const assert = require('node:assert/strict');
const { YNotebook } = require('@jupyter/ydoc');
const notebookModule = process.env.NOTEBOOK_MODULE || './src/notebook';
const { safeOutputs, safeNotebook, notebookHash, notebookSnapshot, notebookDelta, notebookContext, notebookCurrentHash, parsePatch, normalizeBaseUrl, encodeNotebookPath, requestUrlFetch, JupyterRtcClient, resultJson } = require(notebookModule);

const fixture = () => ({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3' } }, cells: [
  { id: 'intro', cell_type: 'markdown', metadata: {}, source: ['# Notebook\n', 'Explain the result.'], attachments: { hidden: { 'image/png': 'AAAA' } } },
  { id: 'calc', cell_type: 'code', metadata: {}, source: 'x = 2\nx', execution_count: 1, outputs: [
    { output_type: 'execute_result', execution_count: 1, metadata: {}, data: { 'text/plain': '2', 'image/png': 'a'.repeat(1000), 'application/vnd.jupyter.widget-view+json': '{}' } }
  ] }
] });

test('notebook context strips every image, attachment, widget and base64-like payload', () => {
  const safe = safeNotebook(fixture()), serialized = JSON.stringify(safe);
  assert.equal(safe.cells[1].outputs[0].data['text/plain'], '2');
  assert.ok(!serialized.includes('image/png')); assert.ok(!serialized.includes('widget')); assert.ok(!serialized.includes('attachments')); assert.ok(!serialized.includes('a'.repeat(400)));
  assert.deepEqual(safeOutputs([{ output_type: 'display_data', data: { 'text/plain': 'DATA:IMAGE/png;base64,AAAA' } }])[0].data, {});
});
test('embedded image data in cell source is omitted from AI context without editing the notebook', () => {
  const original = fixture(), payload = 'A'.repeat(1200);
  original.cells[1].source = `image = "data:image/png;base64,${payload}"\nprint("ready")`;
  const safe = safeNotebook(original), delta = notebookDelta(original, null), context = notebookContext(delta);
  assert.ok(original.cells[1].source.includes(payload));
  assert.ok(safe.cells[1].source.includes('[image data omitted]'));
  assert.ok(!context.includes(payload));
  assert.ok(context.includes('print(\\"ready\\")') || context.includes('print("ready")'));
});
test('safe Notebook error output accepts both Jupyter traceback arrays and archived plain text', () => {
  assert.equal(safeOutputs([{ output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: 'line 1\nline 2' }])[0].traceback, 'line 1\nline 2');
  assert.equal(safeOutputs([{ output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['line 1', 'line 2'] }])[0].traceback, 'line 1\nline 2');
});

test('notebook incremental context sends only changed and removed cells', () => {
  const before = fixture(), snapshot = notebookSnapshot(before), after = fixture();
  after.cells[1].source = 'x = 3\nx'; after.cells.shift();
  const delta = notebookDelta(after, snapshot);
  assert.deepEqual(delta.removed, ['intro']); assert.equal(delta.changed.length, 1); assert.equal(delta.changed[0].cellId, 'calc');
  const context = notebookContext(delta); assert.ok(context.includes('x = 3')); assert.ok(!context.includes('# Notebook'));
  assert.equal(notebookCurrentHash(context), delta.currentHash); assert.ok(context.includes('previousHash'));
});

test('Notebook delta omits unchanged code on rerun and sends a short line patch for a small edit', () => {
  const source = Array.from({ length: 80 }, (_, i) => `value_${i} = ${i}`).join('\n');
  const before = { cells: [{ id: 'calc', cell_type: 'code', source, outputs: [], execution_count: 1 }] };
  const snapshot = notebookSnapshot(before);
  const rerun = structuredClone(before); rerun.cells[0].execution_count = 2;
  assert.equal(notebookDelta(rerun, snapshot).changed.length, 0);
  const edited = structuredClone(rerun); edited.cells[0].source = source.replace('value_45 = 45', 'value_45 = 46');
  const update = notebookDelta(edited, snapshot).changed[0];
  assert.equal(update.source, undefined); assert.equal(update.sourcePatch.startLine, 46);
  assert.deepEqual(update.sourcePatch.insertLines, ['value_45 = 46']);
  const restored = source.split('\n'); restored.splice(update.sourcePatch.startLine - 1, update.sourcePatch.deleteLines, ...update.sourcePatch.insertLines);
  assert.equal(restored.join('\n'), edited.cells[0].source);
  edited.cells[0].outputs = [{ output_type: 'stream', name: 'stdout', text: '46\n' }];
  const outputUpdate = notebookDelta(edited, notebookSnapshot(rerun)).changed[0];
  assert.equal(outputUpdate.outputs[0].text, '46\n'); assert.equal(outputUpdate.source, undefined);
});

test('notebook patch parser is explicit and paths stay inside Jupyter root', () => {
  const currentHash = 'a'.repeat(64);
  const patch = parsePatch(`answer\n\`\`\`notebook-patch\n{"baseHash":"${currentHash}","operations":[{"type":"set_source","cellId":"calc","source":"x=4"}]}\n\`\`\``);
  assert.equal(patch.operations[0].source, 'x=4'); assert.throws(() => parsePatch(`\`\`\`notebook-patch\n{"baseHash":"${currentHash}","operations":[{"type":"shell"}]}\n\`\`\``));
  const alternate = parsePatch('```json\n{"baseHash":null,"operations":[{"op":"insert_cell","index":1,"cellType":"code","source":"print(42)"}]}\n```', currentHash);
  assert.equal(alternate.baseHash, currentHash); assert.equal(alternate.operations[0].type, 'insert_cell'); assert.equal(alternate.operations[0].source, 'print(42)');
  assert.equal(parsePatch('```json\n{"example":true}\n```'), null);
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8888/lab?token=secret'), 'http://127.0.0.1:8888');
  assert.equal(encodeNotebookPath('course\\hw 1.ipynb'), 'course/hw%201.ipynb'); assert.throws(() => encodeNotebookPath('../secret.ipynb'));
  assert.throws(() => encodeNotebookPath('C:\\Users\\Example\\Desktop\\Untitled.ipynb'), /相对于 Jupyter 根目录/);
  assert.throws(() => encodeNotebookPath('/home/user/Untitled.ipynb'), /相对于 Jupyter 根目录/);
});

test('Obsidian requestUrl adapter preserves authenticated REST requests and HTTP status', async () => {
  let sent;
  const fetchImpl = requestUrlFetch(async request => { sent = request; return { status: 201, json: { fileId: 'file-1', sessionId: 'session-1' } }; });
  const response = await fetchImpl('http://127.0.0.1:8899/api/collaboration/session/hw.ipynb', { method: 'PUT', headers: { Authorization: 'token secret', 'Content-Type': 'application/json' }, body: '{"format":"json"}' });
  assert.equal(sent.method, 'PUT'); assert.equal(sent.headers.Authorization, 'token secret'); assert.equal(sent.throw, false);
  assert.equal(sent.body, '{"format":"json"}'); assert.equal(response.ok, true); assert.equal((await response.json()).fileId, 'file-1');
  const missing = await requestUrlFetch(async () => ({ status: 404, json: {} }))('http://127.0.0.1:8899/nope');
  assert.equal(missing.ok, false); assert.equal(missing.status, 404);
});

test('Notebook requests recover when REST hangs or Kernel is idle without a completion message', async () => {
  const client = new JupyterRtcClient({ baseUrl: 'http://127.0.0.1:8888', notebookPath: 'hw.ipynb', fetchImpl: () => new Promise(() => {}), restTimeout: 20, kernelPollInterval: 5, kernelIdleGrace: 15 });
  await assert.rejects(client.json('/api/status'), /等待超时/);
  const kernel = { id: 'test-kernel', sessionId: 'test-session', socket: { send() {} }, pending: new Map() };
  client.ensureKernel = async () => kernel; client.json = async () => ({ execution_state: 'idle' });
  await assert.rejects(client.kernelRequest('execute_request', { code: 'print(1)' }), /已空闲/);
  assert.equal(kernel.pending.size, 0);
});

test('RTC patch checks the exact base hash and verifies server state before success', async () => {
  const original = fixture(), model = YNotebook.create({ data: original }), states = [], client = new JupyterRtcClient({ baseUrl: 'http://127.0.0.1:8888', notebookPath: 'hw.ipynb', fetchImpl: async () => assert.fail('network should be stubbed'), onStatus: state => states.push(state) });
  client.socket = { synced: true, notebook: model }; let verified = '';
  client.verify = async expected => { verified = expected; };
  const updated = await client.applyPatch({ baseHash: notebookHash(original), operations: [{ type: 'set_source', cellId: 'calc', source: 'x = 5\nx' }, { type: 'insert_cell', index: 2, cellType: 'markdown', source: 'done' }] });
  assert.equal(updated.cells[1].source, 'x = 5\nx'); assert.equal(updated.cells[2].source, 'done'); assert.equal(verified, notebookHash(updated)); assert.deepEqual(states, ['syncing', 'connected']);
  await assert.rejects(client.applyPatch({ baseHash: 'stale', operations: [] }), /发生变化/); model.dispose();
});

test('result.json contains safe text outputs from a completed snapshot', () => {
  const result = resultJson(fixture()), serialized = JSON.stringify(result);
  assert.equal(result.cells.length, 1); assert.ok(serialized.includes('text/plain')); assert.ok(!serialized.includes('image/png'));
});

if (process.env.NOTEBOOK_MODULE) test('bundled RTC completes Jupyter-style sync and verifies through a second connection', async () => {
  const { WebSocketServer } = require('ws'), Y = require('yjs'), sync = require('y-protocols/sync'), encoding = require('lib0/encoding'), decoding = require('lib0/decoding');
  const serverDoc = new Y.Doc(), sockets = new Set(), server = new WebSocketServer({ port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('message', raw => { const decoder = decoding.createDecoder(new Uint8Array(raw)), type = decoding.readVarUint(decoder); if (type !== 0) return; const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 0); sync.readSyncMessage(decoder, encoder, serverDoc, socket); if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder)); });
  });
  const address = server.address(), fetchImpl = async () => ({ ok: true, status: 201, json: async () => ({ roomId: 'json:notebook:test-room', sessionId: 'test-session' }) });
  const client = new JupyterRtcClient({ baseUrl: `http://127.0.0.1:${address.port}`, notebookPath: 'hw.ipynb', fetchImpl, timeout: 3000 });
  try {
    const loaded = await client.connect(); assert.equal(loaded.cells.length, 0);
    const updated = await client.applyPatch({ baseHash: notebookHash(loaded), operations: [{ type: 'insert_cell', index: 0, cellType: 'code', source: 'received = True' }] });
    assert.equal(updated.cells[0].source, 'received = True'); assert.equal(serverDoc.getArray('cells').length, 1);
  } finally { client.close(); for (const socket of sockets) socket.terminate(); await new Promise(resolve => server.close(resolve)); serverDoc.destroy(); }
});
