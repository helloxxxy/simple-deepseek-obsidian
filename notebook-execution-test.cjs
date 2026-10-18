const { test } = require('node:test');
const assert = require('node:assert/strict');
const { YNotebook } = require('@jupyter/ydoc');
const { JupyterRtcClient } = require('./src/notebook');

const code = (id, source) => ({ id, cell_type: 'code', metadata: {}, source, execution_count: null, outputs: [] });
const fixture = () => ({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [code('first', 'print(42)'), code('second', 'print(7)')] });
const response = (text = '42\n', count = 1) => [
  { channel: 'iopub', header: { msg_type: 'stream' }, content: { name: 'stdout', text } },
  { channel: 'shell', header: { msg_type: 'execute_reply' }, content: { execution_count: count } }
];
const setup = (data = fixture()) => {
  const model = YNotebook.create({ data }), client = new JupyterRtcClient({ baseUrl: 'http://127.0.0.1:8888', notebookPath: 'test.ipynb' });
  client.socket = { synced: true, notebook: model }; client.verify = async () => {};
  client.kernelRequest = async () => response();
  return { model, client };
};
const conflict = reason => error => error.code === 'NOTEBOOK_EXECUTION_CONFLICT' && error.reason === reason && error.outputsDiscarded === true;

test('execution output follows its original cell when a manual cell is inserted before it', async () => {
  const { model, client } = setup();
  try {
    client.kernelRequest = async () => { model.insertCell(0, code('manual-new', 'print("manual")')); return response(); };
    const result = await client.executeCell(0), cells = client.read().cells;
    assert.equal(result.index, 1); assert.equal(result.cellId, 'first');
    assert.deepEqual(cells[0].outputs, []); assert.equal(cells[1].outputs[0].text, '42\n');
  } finally { model.dispose(); }
});

test('deleted execution target never transfers results to the next cell', async () => {
  const { model, client } = setup();
  try {
    client.kernelRequest = async () => { model.deleteCell(0); return response(); };
    await assert.rejects(client.executeCell(0), conflict('target_deleted'));
    assert.equal(client.read().cells[0].id, 'second'); assert.deepEqual(client.read().cells[0].outputs, []);
  } finally { model.dispose(); }
});

test('source edited during execution remains intact and does not receive stale outputs', async () => {
  const { model, client } = setup();
  try {
    client.kernelRequest = async () => { model.getCell(0).setSource('print("edited")'); return response(); };
    await assert.rejects(client.executeCell('first'), conflict('source_changed'));
    assert.equal(client.read().cells[0].source, 'print("edited")'); assert.deepEqual(client.read().cells[0].outputs, []);
  } finally { model.dispose(); }
});

test('manual outputs appearing during execution are preserved instead of overwritten', async () => {
  const { model, client } = setup();
  try {
    client.kernelRequest = async () => { model.getCell(0).setOutputs([{ output_type: 'stream', name: 'stdout', text: 'manual run\n' }]); model.getCell(0).setExecutionCount(9); return response(); };
    await assert.rejects(client.executeCell('first'), conflict('outputs_changed'));
    assert.equal(client.read().cells[0].outputs[0].text, 'manual run\n'); assert.equal(client.read().cells[0].execution_count, 9);
  } finally { model.dispose(); }
});

test('a persistent cell ID follows a manual move while its kernel request is pending', async () => {
  const { model, client } = setup();
  try {
    client.kernelRequest = async () => { model.moveCell(0, 1); return response(); };
    const result = await client.executeCell('first');
    assert.equal(result.index, 1); assert.equal(client.read().cells[1].id, 'first'); assert.equal(client.read().cells[1].outputs[0].text, '42\n');
  } finally { model.dispose(); }
});

test('legacy notebooks use the original shared-cell object across index shifts', async () => {
  const data = fixture(); data.nbformat_minor = 4; data.cells.forEach(cell => delete cell.id);
  const { model, client } = setup(data);
  try {
    client.kernelRequest = async () => { model.insertCell(0, code('inserted', 'print("new")')); return response(); };
    const result = await client.executeCell(0);
    assert.equal(result.index, 1); assert.deepEqual(client.read().cells[0].outputs, []); assert.equal(client.read().cells[1].outputs[0].text, '42\n');
  } finally { model.dispose(); }
});

test('disconnecting or replacing the shared notebook while waiting prevents all output writes', async () => {
  for (const replacement of [false, true]) {
    const { model, client } = setup(), newer = replacement ? YNotebook.create({ data: fixture() }) : null;
    try {
      client.kernelRequest = async () => { client.socket = newer ? { synced: true, notebook: newer } : null; return response(); };
      await assert.rejects(client.executeCell(0), conflict('connection_changed'));
      assert.deepEqual(model.toJSON().cells[0].outputs, []); if (newer) assert.deepEqual(newer.toJSON().cells[0].outputs, []);
    } finally { model.dispose(); newer?.dispose(); }
  }
});

test('execution keeps native image outputs but returns only safe text to callers', async () => {
  const { model, client } = setup(), image = 'A'.repeat(900);
  try {
    client.kernelRequest = async () => [...response(), { channel: 'iopub', header: { msg_type: 'display_data' }, content: { data: { 'image/png': image, 'text/plain': 'Figure 1' } } }];
    const result = await client.executeCell(0);
    assert.equal(client.read().cells[0].outputs[1].data['image/png'], image);
    assert.equal(JSON.stringify(result.outputs).includes(image), false); assert.equal(result.outputs[1].data['text/plain'], 'Figure 1');
  } finally { model.dispose(); }
});

test('execution verification tolerates unrelated manual changes and confirms the targeted cell output', async () => {
  const { model, client } = setup();
  try {
    client.verify = async (_expected, { accept }) => { model.getCell(1).setSource('print("other edit")'); assert.equal(accept(model.toJSON()), true); };
    const result = await client.executeCell(0);
    assert.equal(result.outputs[0].text, '42\n'); assert.equal(result.notebook.cells[1].source, 'print("other edit")');
  } finally { model.dispose(); }
});

test('moving the completed cell during confirmation returns its current identity and position', async () => {
  const { model, client } = setup();
  try {
    client.verify = async (_expected, { accept }) => { model.moveCell(0, 1); assert.equal(accept(model.toJSON()), true); };
    const result = await client.executeCell(0);
    assert.equal(result.index, 1); assert.equal(result.cellId, 'first'); assert.equal(result.notebook.cells[1].outputs[0].text, '42\n');
  } finally { model.dispose(); }
});

test('changes after an output write report that it was already submitted and preserve the later edit', async () => {
  const { model, client } = setup();
  try {
    client.verify = async () => { model.getCell(0).setSource('print("later")'); };
    await assert.rejects(client.executeCell(0), error => error.code === 'NOTEBOOK_EXECUTION_CONFLICT' && error.outputsApplied === true && error.outputsDiscarded === false);
    assert.equal(client.read().cells[0].source, 'print("later")'); assert.equal(client.read().cells[0].outputs[0].text, '42\n');
  } finally { model.dispose(); }
});

test('runAll snapshots its targets and never executes a newly inserted code cell', async () => {
  const { model, client } = setup(), executed = [];
  try {
    client.kernelRequest = async (_type, args) => { executed.push(args.code); if (executed.length === 1) model.insertCell(0, code('manual-new', 'print("unexpected")')); return response(args.code + '\n', executed.length); };
    await assert.rejects(client.runAll({ clean: false }), error => error.code === 'NOTEBOOK_EXECUTION_CONFLICT' && error.reason === 'new_code_cells');
    assert.deepEqual(executed, ['print(42)', 'print(7)']); assert.deepEqual(client.read().cells[0].outputs, []); assert.equal(client.lastCleanRun, undefined);
  } finally { model.dispose(); }
});

test('runAll follows persistent IDs through cell moves without running a cell twice', async () => {
  const { model, client } = setup(), executed = [], progress = [];
  try {
    client.kernelRequest = async (_type, args) => { executed.push(args.code); if (executed.length === 1) model.moveCell(1, 0); return response(args.code + '\n', executed.length); };
    const result = await client.runAll({ clean: false, onProgress: (done, total, index) => progress.push({ done, total, index }) });
    assert.deepEqual(executed, ['print(42)', 'print(7)']); assert.equal(result.cells[0].id, 'second');
    assert.deepEqual(progress, [{ done: 1, total: 2, index: 0 }, { done: 2, total: 2, index: 0 }]);
  } finally { model.dispose(); }
});

test('runAll stops before running a deleted or manually edited planned target', async () => {
  for (const remove of [true, false]) {
    const { model, client } = setup(), executed = [];
    try {
      client.kernelRequest = async (_type, args) => { executed.push(args.code); if (remove) model.deleteCell(1); else model.getCell(1).setSource('print("manual edit")'); return response(); };
      await assert.rejects(client.runAll({ clean: false }), conflict(remove ? 'target_deleted' : 'source_changed'));
      assert.deepEqual(executed, ['print(42)']);
      if (!remove) { assert.equal(client.read().cells[1].source, 'print("manual edit")'); assert.deepEqual(client.read().cells[1].outputs, []); }
    } finally { model.dispose(); }
  }
});

test('a clean run discards its old result export on failure and does not clear outputs after a restart conflict', async () => {
  const { model, client } = setup();
  try {
    const prior = [{ output_type: 'stream', name: 'stdout', text: 'keep manual output\n' }]; model.getCell(0).setOutputs(prior);
    client.lastCleanRun = fixture(); const kernel = { id: 'old-kernel', socket: { close() {} } }; client.kernel = kernel; client.ensureKernel = async () => kernel;
    client.json = async () => { model.getCell(0).setSource('print("new source")'); return {}; };
    await assert.rejects(client.runAll({ clean: true }), conflict('source_changed'));
    assert.equal(client.lastCleanRun, undefined); assert.deepEqual(client.read().cells[0].outputs, prior);
    await assert.rejects(client.writeResultJson(), /全量运行/);
  } finally { model.dispose(); }
});

test('a successful clean run records only a fully validated completed snapshot', async () => {
  const { model, client } = setup(), executed = [];
  try {
    const kernel = { id: 'kernel', socket: { close() {} } }; client.kernel = kernel; client.ensureKernel = async () => kernel; client.json = async () => ({});
    client.kernelRequest = async (_type, args) => { executed.push(args.code); if (executed.length === 1) model.insertCell(1, { id: 'manual-note', cell_type: 'markdown', metadata: {}, source: '# Manual note' }); return response(args.code + '\n', executed.length); };
    const result = await client.runAll({ clean: true });
    assert.deepEqual(executed, ['print(42)', 'print(7)']); assert.deepEqual(client.lastCleanRun, JSON.parse(JSON.stringify(result)));
    result.cells[0].source = 'external change'; assert.equal(client.lastCleanRun.cells[0].source, 'print(42)');
  } finally { model.dispose(); }
});
