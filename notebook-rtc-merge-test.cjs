const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { YNotebook } = require('@jupyter/ydoc');
const { JupyterRtcClient, notebookHash } = require('./src/notebook');

const makeCell = (id, source = `${id} = 1`) => ({ id, cell_type: 'code', source, metadata: {}, outputs: [], execution_count: null });
const fixture = () => ({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [makeCell('a'), makeCell('b'), makeCell('c')] });
function clientWithModel(data = fixture()) {
  const model = YNotebook.create({ data });
  const client = new JupyterRtcClient({ baseUrl: 'http://127.0.0.1:8888', notebookPath: 'test.ipynb', fetchImpl: async () => assert.fail('no service calls') });
  client.socket = { synced: true, notebook: model };
  return { client, model };
}
function editsFor(client, operations) { return { baseHash: notebookHash(client.read()), operations }; }

test('RTC confirmation accepts independent manual edits and outputs after local application', async () => {
  const { client, model } = clientWithModel();
  client.verify = async (expected, { accept }) => {
    const remote = client.read(); remote.cells[1].source = 'manual = 77';
    remote.cells[0].outputs = [{ output_type: 'stream', name: 'stdout', text: 'new output' }];
    remote.cells[0].execution_count = 12; remote.cells.push(makeCell('manual'));
    assert.notEqual(notebookHash(remote), expected); assert.equal(accept(remote), true);
    model.cells[1].setSource('manual = 77');
  };
  try {
    const result = await client.applyPatch(editsFor(client, [{ type: 'set_source', cellId: 'a', source: 'a = 2' }]));
    assert.equal(result.cells[0].source, 'a = 2'); assert.equal(result.cells[1].source, 'manual = 77');
  } finally { model.dispose(); }
});

test('RTC confirmation checks inserted and modified IDs through a sequential patch', async () => {
  const { client, model } = clientWithModel();
  client.verify = async (expected, { accept }) => {
    const remote = client.read(); assert.equal(accept(remote), true);
    const modified = structuredClone(remote); modified.cells.find(cell => cell.id === 'inserted').source = 'manual change';
    assert.equal(accept(modified), false);
    const removed = structuredClone(remote); removed.cells = removed.cells.filter(cell => cell.id !== 'inserted');
    assert.equal(accept(removed), false);
    const changedType = structuredClone(remote); changedType.cells.find(cell => cell.id === 'a').cell_type = 'markdown';
    assert.equal(accept(changedType), false);
    const moved = structuredClone(remote); moved.cells.reverse(); assert.equal(accept(moved), true);
  };
  try {
    await client.applyPatch(editsFor(client, [
      { type: 'insert_cell', cellId: 'inserted', index: 0, cellType: 'code', source: 'first' },
      { type: 'replace_text', index: 0, oldText: 'first', newText: 'final' },
      { type: 'set_source', index: 1, source: 'a = 2' }
    ]));
  } finally { model.dispose(); }
});

test('RTC confirmation verifies deleted IDs remain absent without rejecting unrelated deletion', async () => {
  const { client, model } = clientWithModel();
  client.verify = async (expected, { accept }) => {
    const remote = client.read(); assert.equal(accept(remote), true);
    remote.cells = remote.cells.filter(cell => cell.id !== 'c'); assert.equal(accept(remote), true);
    remote.cells.push(makeCell('b')); assert.equal(accept(remote), false);
  };
  try { await client.applyPatch(editsFor(client, [{ type: 'delete_cell', cellId: 'b' }])); }
  finally { model.dispose(); }
});

test('RTC confirmation rejects duplicate IDs and overlapping manual edits', async () => {
  const { client, model } = clientWithModel();
  client.verify = async (expected, { accept }) => {
    const remote = client.read(); remote.cells.push(structuredClone(remote.cells[0])); assert.equal(accept(remote), false);
    remote.cells.pop(); remote.cells[0].source = 'manual overlap'; assert.equal(accept(remote), false);
    throw Error('confirmation does not match');
  };
  try {
    await assert.rejects(client.applyPatch(editsFor(client, [{ type: 'set_source', cellId: 'a', source: 'a = 2' }])), error => error.applied === true && error.notebook.cells[0].source === 'a = 2');
  } finally { model.dispose(); }
});

test('RTC lost confirmation marks already submitted edits without rolling back later manual changes', async () => {
  const { client, model } = clientWithModel();
  client.verify = async () => { model.cells[0].setSource('manual after submission'); throw Error('connection lost'); };
  try {
    await assert.rejects(client.applyPatch(editsFor(client, [{ type: 'set_source', cellId: 'a', source: 'a = 2' }])), error => {
      assert.equal(error.applied, true); assert.equal(error.message, 'connection lost');
      assert.equal(error.notebook.cells[0].source, 'manual after submission'); return true;
    });
    assert.equal(client.read().cells[0].source, 'manual after submission');
  } finally { model.dispose(); }
});

test('RTC does not claim confirmation if the local target changes while the server is being checked', async () => {
  const { client, model } = clientWithModel();
  client.verify = async (expected, { accept }) => {
    assert.equal(accept(client.read()), true);
    model.cells[0].setSource('manual overlap after server snapshot');
  };
  try {
    await assert.rejects(client.applyPatch(editsFor(client, [{ type: 'set_source', cellId: 'a', source: 'a = 2' }])), error => error.applied === true && error.notebook.cells[0].source === 'manual overlap after server snapshot');
  } finally { model.dispose(); }
});

test('RTC lost confirmation after disconnect retains the submitted Notebook snapshot', async () => {
  const { client, model } = clientWithModel();
  client.verify = async () => { client.socket = null; throw Error('disconnected'); };
  try {
    await assert.rejects(client.applyPatch(editsFor(client, [{ type: 'set_source', cellId: 'a', source: 'a = 2' }])), error => error.applied === true && error.notebook.cells[0].source === 'a = 2');
  } finally { model.dispose(); }
});

test('RTC validation failure has no applied flag and leaves local state untouched', async () => {
  const { client, model } = clientWithModel(), before = client.read();
  client.verify = async () => assert.fail('invalid patch cannot reach confirmation');
  try {
    await assert.rejects(client.applyPatch({ baseHash: '0'.repeat(64), operations: [{ type: 'set_source', cellId: 'a', source: 'a = 2' }] }), error => error.applied !== true);
    assert.deepEqual(client.read(), before);
  } finally { model.dispose(); }
});

test('RTC legacy IDs retain strict whole-Notebook confirmation', async () => {
  const { client, model } = clientWithModel();
  const originalRead = client.read.bind(client);
  // Simulate a v4 Notebook transport which omits persistent cell IDs.
  client.read = () => { const value = originalRead(); for (const cell of value.cells) delete cell.id; return value; };
  client.verify = async (expected, options) => { assert.equal(options, undefined); assert.equal(expected, notebookHash(client.read())); };
  try { await client.applyPatch(editsFor(client, [{ type: 'set_source', index: 0, source: 'a = 2' }])); }
  finally { model.dispose(); }
});

// Load the production verifier with an in-memory socket/Notebook transport. The
// handshake completes through the same YSocket callbacks without opening ports.
function mockedVerifier(snapshot) {
  const filename = path.join(__dirname, 'src', 'notebook.js'), originalRequire = createRequire(filename);
  const state = { closed: 0, disposed: 0 };
  class MockNotebook {
    constructor() { this.ydoc = { on() {}, off() {} }; }
    toJSON() { return structuredClone(snapshot); }
    dispose() { state.disposed++; }
  }
  class MockSocket extends EventEmitter {
    static OPEN = 1;
    constructor() { super(); this.readyState = 1; queueMicrotask(() => this.emit('open')); }
    send() { queueMicrotask(() => this.emit('message', new Uint8Array([0, 1]))); }
    close() { state.closed++; this.readyState = 3; }
  }
  const sandbox = { module: { exports: {} }, exports: {}, URL, URLSearchParams, Buffer, Uint8Array, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name === '@jupyter/ydoc') return { YNotebook: MockNotebook };
      if (name === 'ws') return { WebSocket: MockSocket };
      if (name === 'y-protocols/sync.js') return { writeSyncStep1() {}, writeUpdate() {}, readSyncMessage() {} };
      return originalRequire(name);
    }
  };
  vm.runInNewContext(readFileSync(filename, 'utf8'), sandbox, { filename });
  const client = new sandbox.module.exports.JupyterRtcClient({ baseUrl: 'http://127.0.0.1:8888', notebookPath: 'test.ipynb', timeout: 15 });
  return { client, state };
}

test('RTC verifier accepts the optional source predicate when the full hash changed', async () => {
  const snapshot = fixture(), { client, state } = mockedVerifier(snapshot); let received = null;
  await client.verify('0'.repeat(64), { accept: value => { received = value; return true; } });
  assert.equal(received.cells[0].id, 'a'); assert.equal(state.closed, 1); assert.equal(state.disposed, 1);
});

test('RTC verifier remains compatible with a single expected hash', async () => {
  const snapshot = fixture(), { client, state } = mockedVerifier(snapshot);
  await client.verify(notebookHash(snapshot)); assert.equal(state.closed, 1); assert.equal(state.disposed, 1);
});

test('RTC verifier rejects missing confirmation and always disposes temporary sockets', async () => {
  const { client, state } = mockedVerifier(fixture());
  await assert.rejects(client.verify('0'.repeat(64), { accept: () => false }), /Jupyter 未确认/);
  assert.ok(state.closed > 0); assert.equal(state.closed, state.disposed);
});

test('staged chunks survive reload review cancellation and independent live edits before one RTC application', async () => {
  const { NotebookEditBuffer, notebookDelta, notebookContext, notebookSnapshot } = require('./src/notebook');
  const { rebaseNotebookPatch } = require('./src/notebook-merge');
  const image = 'Q'.repeat(900), updatedImage = 'R'.repeat(900), data = fixture();
  data.cells[1] = { id: 'b', cell_type: 'markdown', metadata: {}, source: '![figure](attachment:figure.png)', attachments: { 'figure.png': { 'image/png': image } } };
  const { client, model } = clientWithModel(data), original = client.read();
  let verifications = 0;
  try {
    const initialContext = notebookContext(notebookDelta(original, null)); assert.equal(initialContext.includes(image), false);
    const first = new NotebookEditBuffer(original);
    first.stage({ baseHash: first.currentHash, operations: [{ type: 'source_chunk', chunkId: 'rewrite-a', part: 0, source: 'a = ', operation: { type: 'set_source', cellId: 'a' } }], done: false });
    const saved = JSON.parse(JSON.stringify(first.exportState())); assert.equal(JSON.stringify(saved).includes(image), false);
    model.getCell(1).setAttachments({ 'figure.png': { 'image/png': updatedImage } });
    const resumed = NotebookEditBuffer.restore(saved); assert.equal(resumed.readPending().source, 'a = ');
    resumed.stage({ baseHash: resumed.currentHash, operations: [{ type: 'source_chunk', chunkId: 'rewrite-a', part: 1, source: '2', final: true }, { type: 'insert_cell', cellId: 'generated', cellType: 'code', source: 'generated = a + 1' }], done: true });
    const ready = NotebookEditBuffer.restore(JSON.parse(JSON.stringify(resumed.exportState()))), patch = ready.result();
    const options = { baseMetadataHashes: ready.baseMetadataHashes, baseAttachmentHashes: ready.baseAttachmentHashes };
    const beforeReview = JSON.stringify(client.read()), preview = rebaseNotebookPatch(ready.baseNotebook, client.read(), patch, options);
    // Preparation and a cancelled review leave both the live notebook and the staged task intact.
    assert.equal(JSON.stringify(client.read()), beforeReview); assert.equal(ready.done, true); assert.equal(verifications, 0);
    const reviewed = rebaseNotebookPatch(ready.baseNotebook, client.read(), patch, options); assert.deepEqual(reviewed.patch, preview.patch);
    client.verify = async (_expected, { accept }) => { verifications++; model.getCell(2).setSource('c = 99 # independent edit'); assert.equal(accept(client.read()), true); };
    const applied = await client.applyPatch(reviewed.patch);
    assert.equal(verifications, 1); assert.equal(applied.cells[0].source, 'a = 2'); assert.equal(applied.cells[2].source, 'c = 99 # independent edit');
    assert.equal(applied.cells[1].attachments['figure.png']['image/png'], updatedImage); assert.equal(applied.cells.filter(cell => cell.id === 'generated').length, 1);
    const baseline = notebookSnapshot(applied); assert.equal(notebookDelta(client.read(), baseline).changed.length, 0);
    model.getCell(0).setOutputs([{ output_type: 'display_data', data: { 'image/png': image, 'text/plain': 'result = 3' }, metadata: {} }]);
    const next = notebookDelta(client.read(), baseline); assert.equal(next.changed.length, 1); assert.equal(next.changed[0].source, undefined); assert.equal(next.changed[0].outputs[0].data['text/plain'], 'result = 3');
    assert.equal(notebookContext(next).includes(image), false);
    const reopened = clientWithModel(JSON.parse(JSON.stringify(client.read())));
    try {
      const archivedTask = NotebookEditBuffer.restore(JSON.parse(JSON.stringify(ready.exportState())));
      assert.equal(archivedTask.done, true); assert.deepEqual(archivedTask.result(), patch);
      assert.throws(() => rebaseNotebookPatch(archivedTask.baseNotebook, reopened.client.read(), patch, { baseMetadataHashes: archivedTask.baseMetadataHashes, baseAttachmentHashes: archivedTask.baseAttachmentHashes }), error => error.conflicts[0].reason === 'insert_id_collision');
      assert.equal(reopened.client.read().cells[1].attachments['figure.png']['image/png'], updatedImage);
    } finally { reopened.model.dispose(); }
  } finally { model.dispose(); }
});

test('attachment replacement during review prevents deletion before any RTC transaction or confirmation', async () => {
  const { NotebookEditBuffer } = require('./src/notebook'), { rebaseNotebookPatch } = require('./src/notebook-merge');
  const data = fixture(); data.cells[1] = { id: 'b', cell_type: 'markdown', metadata: {}, source: '![figure](attachment:figure.png)', attachments: { 'figure.png': { 'image/png': 'AAAA' } } };
  const { client, model } = clientWithModel(data); let verifications = 0;
  client.verify = async () => { verifications++; };
  try {
    const task = new NotebookEditBuffer(client.read()); task.stage({ baseHash: task.currentHash, operations: [{ type: 'delete_cell', cellId: 'b' }], done: true });
    const recovered = NotebookEditBuffer.restore(JSON.parse(JSON.stringify(task.exportState()))), options = { baseMetadataHashes: recovered.baseMetadataHashes, baseAttachmentHashes: recovered.baseAttachmentHashes };
    const preview = rebaseNotebookPatch(recovered.baseNotebook, client.read(), recovered.result(), options); assert.equal(preview.patch.operations.length, 1);
    model.getCell(1).setAttachments({ 'figure.png': { 'image/png': 'BBBB' } });
    const before = JSON.stringify(client.read()); assert.equal(notebookHash(client.read()), task.baseHash);
    assert.throws(() => rebaseNotebookPatch(recovered.baseNotebook, client.read(), recovered.result(), options), error => error.conflicts[0].reason === 'deleted_cell_attachments_changed');
    assert.equal(JSON.stringify(client.read()), before); assert.equal(client.read().cells[1].attachments['figure.png']['image/png'], 'BBBB'); assert.equal(verifications, 0);
  } finally { model.dispose(); }
});

test('compaction between accepted source chunks preserves the task and a complete raw tool journal', async () => {
  const { NotebookEditBuffer, notebookDelta, notebookContext } = require('./src/notebook');
  const { runToolTurn } = require('./src/tool-turn'), { compactContext } = require('./src/context');
  const { rebuildEntryMessages } = require('./src/history'), { buildSystemPrompt } = require('./src/prompts');
  const notebook = fixture(), task = new NotebookEditBuffer(notebook), prompt = buildSystemPrompt({ webEnabled: false, notebookMode: true, notebookEnabled: true });
  const originalUser = { role: 'user', content: 'Create a long cell.\n' + 'Reference material for the task. '.repeat(1000) + notebookContext(notebookDelta(notebook, null)) };
  const session = { messages: [originalUser], entries: [], meter: null, compactions: 0, cache: null }, journal = [], saved = [];
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const signal = new AbortController().signal; let requests = 0, compressed = false;
  const result = await runToolTurn({ key: 'fake', session, signal, model: 'deepseek-flash', reasoningEffort: 'low', systemPrompt: prompt,
    capabilities: { contextWindow: 1048576, maxOutputTokens: 393216 }, webEnabled: false, notebook: task, userText: 'Create a long cell.',
    onMessage: message => journal.push(message), onCheckpoint: async state => saved.push(JSON.parse(JSON.stringify(state))),
    beforeRequest: async () => {
      if (!compressed && task.status().started) {
        compressed = true;
        await compactContext(session, 'fake', signal, () => {}, async (_key, _messages, _signal, onText) => {
          onText('Continue the pending notebook source task. ' + JSON.stringify(task.status())); return { prompt_tokens: 1000, completion_tokens: 50 };
        }, 0, true, prompt, { contextWindow: 1048576, maxOutputTokens: 393216 }, 'deepseek-flash', true);
      }
    },
    send: async (_key, messages, _signal, onText, _http, options) => {
      const step = requests++;
      if (step === 0) options.onToolCalls([call('begin-long-source', 'stage_notebook_edits', { baseHash: task.currentHash, operations: [{ type: 'source_chunk', chunkId: 'new-long-cell', part: 0, source: 'print("', operation: { type: 'insert_cell', cellType: 'code', cellId: 'generated' } }], done: false })]);
      else if (step === 1) {
        assert.match(messages[1].content, /Continuation checkpoint/); assert.equal(messages.some(message => message.tool_calls?.some(value => value.id === 'begin-long-source')), false);
        options.onToolCalls([call('inspect-partial-source', 'read_notebook', { pendingSource: { offset: 0, limit: 12000 } })]);
      } else if (step === 2) {
        const pending = JSON.parse(messages.at(-1).content); assert.equal(pending.source, 'print("'); assert.equal(pending.nextPart, 1);
        options.onToolCalls([call('finish-long-source', 'stage_notebook_edits', { baseHash: pending.currentHash, operations: [{ type: 'source_chunk', chunkId: 'new-long-cell', part: 1, source: 'ready")', final: true }], done: true })]);
      } else { assert.equal(step, 3); onText('The complete edit awaits review.'); }
      return { prompt_tokens: 100, completion_tokens: 10 };
    }
  });
  assert.equal(requests, 4); assert.equal(session.compactions, 1); assert.equal(result.patch.operations[0].source, 'print("ready")');
  assert.equal(notebook.cells.length, 3); assert.equal(saved[0].revision, 1);
  const restored = NotebookEditBuffer.restore(saved.at(-1)); assert.equal(restored.taskId, task.taskId); assert.deepEqual(restored.result(), result.patch);
  const archived = [{ label: '你', raw: 'Create a long cell.', contextText: originalUser.content }, { label: 'deepseek-flash', raw: 'The complete edit awaits review.', modelMessages: journal }];
  const rebuilt = rebuildEntryMessages(JSON.parse(JSON.stringify(archived)));
  const tools = rebuilt.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []), results = rebuilt.filter(message => message.role === 'tool');
  assert.deepEqual(tools.map(value => value.id), ['begin-long-source', 'inspect-partial-source', 'finish-long-source']);
  assert.deepEqual(results.map(message => message.tool_call_id), tools.map(value => value.id));
  assert.equal(rebuilt.at(-1).content, 'The complete edit awaits review.');
  assert.equal(rebuildEntryMessages(archived.slice(0, 1)).some(message => message.role === 'tool'), false);
});
