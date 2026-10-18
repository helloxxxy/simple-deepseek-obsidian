const { test } = require('node:test');
const assert = require('node:assert/strict');
const { YNotebook } = require('@jupyter/ydoc');
const notebookModule = process.env.NOTEBOOK_MODULE || './src/notebook';
const { safeOutputs, safeNotebook, notebookHash, notebookSnapshot, notebookDelta, notebookContext, notebookCurrentHash, parsePatch, describePatch, validatePatch, NotebookEditBuffer, normalizeBaseUrl, encodeNotebookPath, requestUrlFetch, JupyterRtcClient, resultJson, hash } = require(notebookModule);
const { NotebookPatchWorkspace } = require(notebookModule);

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

test('Notebook stream and error text remove embedded image bytes without changing the file data', () => {
  const payload = 'Q'.repeat(900), image = `data:image/png;base64,${payload}`;
  const original = fixture(); original.cells[1].outputs = [
    { output_type: 'stream', name: 'stdout', text: [`image: ${image}\n`, `binary: ${payload}\nvalue: 42`] },
    { output_type: 'error', ename: image, evalue: `failed: ${image}`, traceback: [`line 1: ${payload}`, 'line 2: print(x)'] }
  ];
  const before = JSON.stringify(original), safe = safeNotebook(original), context = notebookContext(notebookDelta(original, null));
  assert.equal(JSON.stringify(original), before);
  for (const text of [JSON.stringify(safe), context, JSON.stringify(resultJson(original))]) {
    assert.equal(text.includes(payload), false); assert.equal(text.includes('data:image/'), false);
    assert.ok(text.includes('value: 42')); assert.ok(text.includes('line 2: print(x)'));
    assert.ok(text.includes('[image data omitted]')); assert.ok(text.includes('[binary data omitted]'));
  }
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

test('Notebook patch parser preserves fenced source strings and accepts complete JSON objects', () => {
  const value = { baseHash: 'b'.repeat(64), operations: [{ type: 'insert_cell', cellType: 'markdown', source: '# Notes\n```python\nprint({"value": "}"})\n```\n\\quoted\\' }] };
  const json = JSON.stringify(value);
  assert.deepEqual(parsePatch(`Explanation\n\`\`\`notebook-patch\n${json}\n\`\`\``), value);
  assert.deepEqual(parsePatch(`~~~~json\n${json}\n~~~~`), value);
  assert.deepEqual(parsePatch(`\`\`\`notebook-patch ${json}\`\`\``), value);
  assert.deepEqual(parsePatch(json), value);
  assert.deepEqual(parsePatch(value), value);
  assert.throws(() => parsePatch(`\`\`\`notebook-patch\n${json.slice(0, -1)}\n\`\`\``), /JSON 无法解析/);
  assert.throws(() => parsePatch(json.slice(0, -1)), /JSON 无法解析/);
  assert.equal(parsePatch('{"other":true}'), null);
});

test('local Notebook replacements require an exact unique match and preserve literal replacement text', () => {
  const original = fixture(), baseHash = notebookHash(original);
  const patch = { baseHash, operations: [{ type: 'replace_text', cellId: 'calc', oldText: 'x = 2', newText: 'x = "$&"' }] };
  const prepared = validatePatch(original, patch);
  assert.equal(prepared.notebook.cells[1].source, 'x = "$&"\nx');
  assert.equal(original.cells[1].source, 'x = 2\nx');
  assert.match(describePatch(patch, 'en'), /Replace text/);
  assert.throws(() => validatePatch(original, { baseHash, operations: [{ ...patch.operations[0], oldText: '' }] }), /非空 oldText/);
  assert.throws(() => validatePatch(original, { baseHash, operations: [{ ...patch.operations[0], oldText: 'missing' }] }), /恰好匹配一次/);
  assert.throws(() => validatePatch(original, { baseHash, operations: [{ ...patch.operations[0], oldText: 'x' }] }), /恰好匹配一次/);
  assert.throws(() => validatePatch(original, { baseHash, operations: [{ ...patch.operations[0], sourceHash: hash('old source') }] }), /源码哈希不匹配/);
  assert.throws(() => validatePatch(original, { baseHash, operations: [{ ...patch.operations[0], cellId: 'missing', index: 1 }] }), /找不到/);
});

test('invalid operations reject the whole RTC patch before any Yjs change', async () => {
  const model = YNotebook.create({ data: fixture() }), client = new JupyterRtcClient({ baseUrl: 'http://127.0.0.1:8888', notebookPath: 'test.ipynb' });
  client.socket = { synced: true, notebook: model }; client.verify = async () => assert.fail('invalid patch must not be sent');
  const original = client.read(), baseHash = notebookHash(original);
  await assert.rejects(client.applyPatch({ baseHash, operations: [{ type: 'set_source', cellId: 'calc', source: 'changed' }, { type: 'delete_cell', cellId: 'absent', index: 0 }] }), /找不到/);
  assert.deepEqual(client.read(), original);
  await assert.rejects(client.applyPatch({ baseHash, operations: [{ type: 'insert_cell', cellType: 'code', source: 'print(1)', index: 9 }] }), /位置无效/);
  await assert.rejects(client.applyPatch({ baseHash, operations: [{ type: 'insert_cell', cellId: 'calc', cellType: 'code', source: 'print(1)' }] }), /ID 无效或重复/);
  assert.deepEqual(client.read(), original); model.dispose();
});

test('Notebook edit batches use virtual hashes, keep insertion IDs, and leave failed batches unchanged', async () => {
  const original = fixture(), buffer = new NotebookEditBuffer(original);
  const first = buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'insert_cell', cellType: 'code', source: 'y = 3' }], done: false });
  const inserted = buffer.snapshot().cells[2]; assert.ok(inserted.id); assert.equal(first.currentHash, buffer.currentHash); assert.equal(buffer.done, false);
  assert.throws(() => buffer.result(), /尚未完成/);
  const snapshot = buffer.snapshot();
  assert.throws(() => buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'set_source', cellId: 'calc', source: 'not committed' }, { type: 'delete_cell', cellId: 'absent' }], done: true }), /找不到/);
  assert.deepEqual(buffer.snapshot(), snapshot); assert.equal(buffer.done, false);
  assert.throws(() => buffer.stage({ baseHash: notebookHash(original), operations: [], done: true }), /发生变化/);
  buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'replace_text', cellId: inserted.id, oldText: '3', newText: '4' }], done: true });
  const patch = buffer.result(); assert.equal(patch.baseHash, notebookHash(original)); assert.equal(patch.operations.length, 2);
  const model = YNotebook.create({ data: original }), client = new JupyterRtcClient({ baseUrl: 'http://127.0.0.1:8888', notebookPath: 'test.ipynb' });
  client.socket = { synced: true, notebook: model }; client.verify = async () => {};
  const applied = await client.applyPatch(patch);
  assert.equal(applied.cells[2].id, inserted.id); assert.equal(notebookHash(applied), buffer.currentHash);
  patch.operations[0].source = 'external mutation'; assert.equal(buffer.result().operations[0].source, 'y = 3');
  const copy = buffer.read(); copy.cells.length = 0; assert.equal(buffer.snapshot().cells.length, 3);
  assert.throws(() => buffer.stage({ baseHash: buffer.currentHash, operations: [] }), /已经完成/); model.dispose();
});

test('large new-cell chunks stay in memory and cannot become applicable until every chunk is complete', () => {
  const original = fixture(), buffer = new NotebookEditBuffer(original), baseHash = buffer.currentHash;
  assert.equal(buffer.status().started, false);
  const operation = { type: 'insert_cell', cellType: 'code', index: 2 };
  const first = buffer.stage({ baseHash, operations: [{ type: 'source_chunk', chunkId: 'large', part: 0, totalParts: 2, source: 'print("', operation }], done: false });
  assert.equal(first.pendingChunks, 1); assert.equal(first.currentHash, baseHash); assert.equal(buffer.snapshot().cells.length, 2);
  assert.equal(first.nextPart, 1); assert.equal(first.chunkId, 'large'); assert.equal(first.started, true);
  assert.equal(JSON.stringify(buffer.status()).includes('print'), false);
  assert.throws(() => buffer.result(), /尚未完成/);
  assert.throws(() => buffer.stage({ baseHash, operations: [{ type: 'source_chunk', chunkId: 'large', part: 1, totalParts: 2, source: 'bad")' }, { type: 'delete_cell', cellId: 'absent' }], done: true }), /找不到/);
  assert.equal(buffer.currentHash, baseHash); assert.equal(buffer.snapshot().cells.length, 2);
  assert.throws(() => buffer.stage({ baseHash, operations: [{ type: 'source_chunk', chunkId: 'other', part: 1, totalParts: 2, source: 'bad' }], done: true }), /顺序或元数据/);
  assert.throws(() => buffer.stage({ baseHash, operations: [], done: true }), /尚未收齐/);
  assert.throws(() => buffer.stage({ baseHash, operations: [{ type: 'set_source', cellId: 'calc', source: 'bad' }], done: false }), /先收齐/);
  const last = buffer.stage({ baseHash, operations: [{ type: 'source_chunk', chunkId: 'large', part: 1, totalParts: 2, source: 'ready")' }], done: true });
  assert.equal(last.pendingChunks, 0); assert.equal(last.done, true);
  const patch = buffer.result(); assert.equal(patch.operations.length, 1); assert.equal(patch.operations[0].source, 'print("ready")');
  assert.equal(validatePatch(original, patch).notebook.cells[2].source, 'print("ready")');
});

test('Notebook chunks validate insertion targets on their first part and preserve older notebook hashes', async () => {
  const original = fixture(), buffer = new NotebookEditBuffer(original);
  assert.throws(() => buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'source_chunk', chunkId: 'bad', part: 0, totalParts: 2, source: '', operation: { type: 'insert_cell', cellType: 'code', index: 99 } }], done: false }), /位置无效/);
  assert.equal(buffer.currentHash, notebookHash(original));
  const old = fixture(); old.nbformat_minor = 4; for (const cell of old.cells) delete cell.id;
  const model = YNotebook.create({ data: old }), client = new JupyterRtcClient({ baseUrl: 'http://127.0.0.1:8888', notebookPath: 'test.ipynb' });
  client.socket = { synced: true, notebook: model }; client.verify = async () => {};
  const oldBuffer = new NotebookEditBuffer(client.read());
  oldBuffer.stage({ baseHash: oldBuffer.currentHash, operations: [{ type: 'insert_cell', cellType: 'markdown', source: 'legacy schema', index: 2 }], done: true });
  assert.equal(notebookHash(await client.applyPatch(oldBuffer.result())), oldBuffer.currentHash); model.dispose();
});

test('a completed source chunk can be finalized by an empty batch and result calls remain independent', () => {
  const buffer = new NotebookEditBuffer(fixture());
  buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'source_chunk', chunkId: 'one', part: 0, totalParts: 1, source: '# Collected', operation: { type: 'insert_cell', cellType: 'markdown' } }], done: false });
  assert.equal(buffer.status().pendingChunks, 0); assert.equal(buffer.done, false);
  const hashBefore = buffer.currentHash;
  buffer.stage({ baseHash: hashBefore, operations: [], done: true });
  assert.equal(buffer.currentHash, hashBefore); assert.equal(buffer.done, true);
  const first = buffer.result(), second = buffer.result(); assert.deepEqual(first, second); assert.notEqual(first, second);
  first.operations[0].source = 'mutated'; assert.equal(buffer.result().operations[0].source, '# Collected');
  assert.equal(buffer.stage({ baseHash: hashBefore, operations: [], done: true }).replayed, true);
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

test('Notebook delta reads source and outputs once per cell while retaining hash and snapshot compatibility', () => {
  const original = fixture(); original.cells[0].source = ['# Unicode 数学\n', '![hidden](data:image/png;base64,QUJDRA==)'];
  original.cells[1].outputs.push({ output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['first', 'second'] });
  let sourceReads = 0, outputReads = 0;
  const counted = { ...original, cells: original.cells.map(cell => ({ ...cell,
    get source() { sourceReads++; return cell.source; }, get outputs() { outputReads++; return cell.outputs; }
  })) };
  const result = notebookDelta(counted, null);
  assert.equal(sourceReads, original.cells.length); assert.equal(outputReads, original.cells.length);
  assert.equal(result.currentHash, notebookHash(original)); assert.deepEqual(result.snapshot, notebookSnapshot(original));
  assert.deepEqual(result.changed, safeNotebook(original).cells);
  assert.ok(!JSON.stringify(result.changed).includes('data:image/')); assert.equal(original.cells[0].source[1], '![hidden](data:image/png;base64,QUJDRA==)');
  const second = notebookDelta(original, result.snapshot); assert.deepEqual(second.changed, []); assert.deepEqual(second.removed, []);
});

test('Notebook projections and snapshots observe in-place source output and structural changes without stale caching', () => {
  const notebook = fixture(), previous = notebookSnapshot(notebook), firstHash = previous.hash;
  notebook.cells[1].source = 'x = 45'; notebook.cells[1].outputs[0].data['text/plain'] = '45';
  const changed = notebookDelta(notebook, previous);
  assert.notEqual(changed.currentHash, firstHash); assert.equal(changed.currentHash, notebookHash(notebook));
  assert.equal(changed.changed[0].source, 'x = 45'); assert.equal(changed.changed[0].outputs[0].data['text/plain'], '45');
  notebook.cells.unshift({ id: 'new', cell_type: 'raw', source: 'new source' });
  assert.equal(safeNotebook(notebook).notebookHash, notebookHash(notebook)); assert.equal(notebookSnapshot(notebook).cells.calc.index, 2);
});

test('Notebook virtual operation index is reused for source edits and rebuilt after insertions or deletions', () => {
  const workspace = new NotebookPatchWorkspace({ cells: Array.from({ length: 120 }, (_, index) => ({ id: 'cell-'+index, cell_type: 'code', source: 'original '+index, metadata: {}, outputs: [] })) });
  let reads = 0;
  for (const cell of workspace.notebook.cells) { const id = cell.id; Object.defineProperty(cell, 'id', { enumerable: true, get() { reads++; return id; } }); }
  let initialReads;
  for (let index = 0; index < 40; index++) {
    const operation = workspace.apply({ type: 'set_source', cellId: 'cell-119', source: 'update '+index }); assert.equal(operation.index, 119);
    if (index === 0) initialReads = reads;
  }
  assert.ok(initialReads >= 120); assert.equal(reads, initialReads); assert.equal(workspace.notebook.cells[119].source, 'update 39');
  workspace.apply({ type: 'insert_cell', cellId: 'new-cell', index: 0, cellType: 'markdown', source: '# New' });
  const moved = workspace.apply({ type: 'replace_text', cellId: 'cell-119', oldText: 'update 39', newText: 'moved update' });
  assert.equal(moved.index, 120); assert.equal(reads, initialReads*2);
  workspace.apply({ type: 'delete_cell', cellId: 'new-cell' });
  assert.equal(workspace.apply({ type: 'set_source', cellId: 'cell-119', source: 'last' }).index, 119); assert.equal(reads, initialReads*3);
});

test('Notebook virtual operations preserve first matching duplicate IDs and reindex legacy fallback IDs', () => {
  const duplicate = { cells: [{ id: 'same', cell_type: 'raw', source: 'first' }, { id: 'same', cell_type: 'raw', source: 'second' }] };
  const workspace = new NotebookPatchWorkspace(duplicate); workspace.apply({ type: 'set_source', cellId: 'same', source: 'changed first' });
  assert.equal(workspace.notebook.cells[0].source, 'changed first'); assert.equal(workspace.notebook.cells[1].source, 'second'); assert.equal(duplicate.cells[0].source, 'first');
  workspace.apply({ type: 'delete_cell', cellId: 'same' }); assert.equal(workspace.apply({ type: 'set_source', cellId: 'same', source: 'remaining' }).index, 0);
  const legacy = new NotebookPatchWorkspace({ nbformat: 4, nbformat_minor: 4, cells: [{ cell_type: 'raw', source: 'first' }, { cell_type: 'raw', source: 'second' }] });
  assert.equal(legacy.indexForId('index-1'), 1); legacy.apply({ type: 'delete_cell', cellId: 'index-0' });
  assert.equal(legacy.indexForId('index-1'), -1); assert.equal(legacy.apply({ type: 'set_source', cellId: 'index-0', source: 'remaining second' }).index, 0);
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
