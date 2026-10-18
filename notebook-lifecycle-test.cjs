const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { JupyterRtcClient, requestUrlFetch, notebookHash } = require('./src/notebook');
const tick = () => new Promise(resolve => setImmediate(resolve));
const data = () => ({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] });
const response = value => ({ ok: true, status: 200, json: async () => value });

function transport({ autoOpen = true, autoSync = true, fetchImpl = async url => response(url.includes('/api/sessions') ? [{ path: 'test.ipynb', kernel: { id: 'kernel-1' } }] : { roomId: 'test-room', sessionId: 'rtc-session' }), timeout = 50 } = {}) {
  const filename = path.join(__dirname, 'src', 'notebook.js'), originalRequire = createRequire(filename);
  const sockets = [], notebooks = [], statuses = [];
  class Notebook {
    constructor() { this.ydoc = new EventEmitter(); this.disposals = 0; this.snapshot = data(); notebooks.push(this); }
    toJSON() { if (this.disposals) throw Error('disposed notebook read'); return structuredClone(this.snapshot); }
    dispose() { this.disposals++; }
  }
  class Socket extends EventEmitter {
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; this.closes = 0; sockets.push(this); if (autoOpen) queueMicrotask(() => this.open()); }
    open() { this.readyState = 1; this.emit('open'); }
    send(value) { this.sent.push(value); if (autoSync && this.url.includes('/api/collaboration/')) queueMicrotask(() => this.emit('message', new Uint8Array([0, 1]))); }
    close() { this.closes++; this.readyState = 3; queueMicrotask(() => this.emit('close', 1000, '')); }
  }
  const sandbox = { module: { exports: {} }, exports: {}, URL, URLSearchParams, Buffer, Uint8Array, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name === '@jupyter/ydoc') return { YNotebook: Notebook };
      if (name === 'ws') return { WebSocket: Socket };
      if (name === 'y-protocols/sync.js') return { writeSyncStep1() {}, writeUpdate() {}, readSyncMessage() {} };
      return originalRequire(name);
    }
  };
  vm.runInNewContext(readFileSync(filename, 'utf8'), sandbox, { filename });
  const client = new sandbox.module.exports.JupyterRtcClient({ baseUrl: 'http://127.0.0.1:8888', notebookPath: 'test.ipynb', fetchImpl, timeout, restTimeout: 50, onStatus: (status, error) => statuses.push({ status, error }) });
  return { client, sockets, notebooks, statuses, inject() { const notebook = new Notebook(); client.socket = { synced: true, notebook }; return notebook; } };
}

test('REST timeout aborts the actual transport signal rather than only abandoning the response', async () => {
  let received;
  const client = new JupyterRtcClient({ baseUrl: 'http://127.0.0.1:8888', notebookPath: 'test.ipynb', restTimeout: 10, fetchImpl: (_url, options) => { received = options.signal; return new Promise(() => {}); } });
  await assert.rejects(client.json('/api/hanging'), /等待超时/);
  assert.equal(received.aborted, true); assert.equal(client.closed, false); client.close();
});

test('injected native-style fetch receives its global receiver instead of the RTC client', async () => {
  let calls = 0;
  function nativeStyleFetch() { 'use strict'; if (this !== globalThis) throw TypeError('Illegal invocation'); calls++; return Promise.resolve(response({ connected: true })); }
  const client = new JupyterRtcClient({ baseUrl: 'http://127.0.0.1:8888', notebookPath: 'test.ipynb', fetchImpl: nativeStyleFetch });
  assert.deepEqual(await client.json('/api/status'), { connected: true }); assert.equal(calls, 1); client.close();
});

test('closing during a shared RTC session request rejects both connects and ignores its late response', async () => {
  let release, calls = 0, received;
  const state = transport({ fetchImpl: (_url, options) => { calls++; received = options.signal; return new Promise(resolve => release = resolve); } });
  const first = state.client.connect(), second = state.client.connect(); await tick();
  assert.equal(calls, 1); state.client.close();
  await Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]);
  assert.equal(received.aborted, true); release(response({ roomId: 'late-room', sessionId: 'late-session' })); await tick();
  assert.equal(state.sockets.length, 0); assert.equal(state.client.connected, false); assert.equal(state.client.closed, true);
  assert.equal(state.statuses.filter(item => item.status === 'disconnected').length, 1); assert.equal(state.statuses.some(item => item.status === 'connected'), false);
  await assert.rejects(state.client.connect(), { name: 'AbortError' });
});

test('closing while JSON response body waits prevents a late RTC socket from being created', async () => {
  let releaseBody, received;
  const state = transport({ fetchImpl: async (_url, options) => { received = options.signal; return { ok: true, status: 200, json: () => new Promise(resolve => releaseBody = resolve) }; } });
  const pending = state.client.connect(); await tick(); assert.equal(typeof releaseBody, 'function'); state.client.close();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(received.aborted, true);
  releaseBody({ roomId: 'late-room', sessionId: 'late-session' }); await tick();
  assert.equal(state.sockets.length, 0); assert.equal(state.client.socket, null);
});

test('JSON body timeouts abort the same fetch request signal and close a failed connection attempt', async () => {
  let received;
  const state = transport({ fetchImpl: async (_url, options) => { received = options.signal; return { ok: true, status: 200, json: () => new Promise(() => {}) }; } });
  state.client.restTimeout = 10;
  await assert.rejects(state.client.connect(), /等待超时/); assert.equal(received.aborted, true); assert.equal(state.client.closed, true); assert.equal(state.sockets.length, 0);
});

test('HTTP response bodies remain owned between headers and JSON parsing so close aborts the transport', async () => {
  let received;
  const state = transport({ fetchImpl: async (_url, options) => { received = options.signal; return response({ pending: true }); } });
  const pending = await state.client.request('http://127.0.0.1:8888/api/test');
  assert.equal(received.aborted, false); assert.equal(state.client.requestControllers.size, 1);
  state.client.close(); assert.equal(received.aborted, true); assert.equal(state.client.requestControllers.size, 0);
  await assert.rejects(pending.json(), { name: 'AbortError' });
});

test('a remote RTC close after synchronization invalidates read and ignores every late socket event', async () => {
  const state = transport(); let updates = 0;
  await state.client.connect(); state.client.onChange(() => updates++);
  const socket = state.sockets[0], wrapper = state.client.socket, sent = socket.sent.length;
  assert.equal(state.client.connected, true); socket.readyState = 3; socket.emit('close', 1006, 'lost');
  assert.equal(wrapper.synced, false); assert.equal(wrapper.closed, true); assert.equal(state.client.closed, true); assert.equal(state.client.connected, false);
  assert.throws(() => state.client.read(), /尚未连接/); assert.equal(state.client.socket, null); assert.equal(state.notebooks[0].disposals, 1);
  socket.open(); socket.emit('message', new Uint8Array([0, 1])); wrapper.notebook.ydoc.emit('update', new Uint8Array(), wrapper); socket.emit('error', Error('late failure'));
  assert.equal(socket.sent.length, sent); assert.equal(updates, 0); assert.equal(state.statuses.filter(item => item.status === 'connected').length, 1); assert.equal(state.statuses.filter(item => item.status === 'disconnected').length, 1);
});

test('closing a pending RTC handshake releases its notebook and never announces connected', async () => {
  const state = transport({ autoOpen: false }); const pending = state.client.connect(); await tick();
  assert.equal(state.sockets.length, 1); state.client.close(); await assert.rejects(pending, { name: 'AbortError' });
  state.sockets[0].open(); state.sockets[0].emit('message', new Uint8Array([0, 1])); await tick();
  assert.equal(state.sockets[0].closes, 1); assert.equal(state.notebooks[0].disposals, 1); assert.equal(state.statuses.some(item => item.status === 'connected'), false);
});

test('RTC handshake failure closes the client once and leaves no readable snapshot', async () => {
  const state = transport({ autoOpen: false }); const pending = state.client.connect(); await tick();
  state.sockets[0].emit('error', Error('handshake failed'));
  await assert.rejects(pending, /WebSocket 失败/); assert.equal(state.client.closed, true); assert.equal(state.client.connected, false); assert.equal(state.notebooks[0].disposals, 1);
  assert.equal(state.statuses.filter(item => item.status === 'disconnected').length, 1);
});

test('client close cancels verification sockets both during handshake and between polls', async () => {
  for (const autoOpen of [false, true]) {
    const state = transport({ autoOpen }); const pending = state.client.verify('0'.repeat(64), { accept: () => false }); await tick();
    assert.equal(state.sockets.length, 1); state.client.close(); await assert.rejects(pending, { name: 'AbortError' }); await tick();
    assert.equal(state.sockets.length, 1); assert.equal(state.sockets[0].closes, 1); assert.equal(state.notebooks[0].disposals, 1);
  }
});

test('closing during the shared kernel session lookup prevents late kernel creation', async () => {
  let release, calls = 0;
  const state = transport({ fetchImpl: () => { calls++; return new Promise(resolve => release = resolve); } }); state.inject();
  const first = state.client.ensureKernel(), second = state.client.ensureKernel(); await tick(); assert.equal(calls, 1);
  state.client.close(); await Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]);
  release(response([{ path: 'test.ipynb', kernel: { id: 'late-kernel' } }])); await tick();
  assert.equal(state.sockets.length, 0); assert.equal(state.client.kernel, null);
});

test('closing a pending kernel handshake prevents a late open from resurrecting the kernel', async () => {
  const state = transport({ autoOpen: false }); state.inject(); const pending = state.client.ensureKernel(); await tick(); assert.equal(state.sockets.length, 1);
  state.client.close(); await assert.rejects(pending, { name: 'AbortError' }); state.sockets[0].open(); await tick();
  assert.equal(state.client.kernel, null); assert.equal(state.client.kernelSockets.size, 0); assert.equal(state.sockets[0].closes, 1);
});

test('kernel handshake timeout closes its transport and preserves an independently healthy RTC connection', async () => {
  const state = transport({ autoOpen: false, timeout: 10 }); state.inject();
  await assert.rejects(state.client.ensureKernel(), /Kernel 超时/); assert.equal(state.sockets[0].closes, 1); assert.equal(state.client.kernelSockets.size, 0);
  assert.equal(state.client.closed, false); assert.equal(state.client.connected, true); state.sockets[0].open(); await tick(); assert.equal(state.client.kernel, undefined); state.client.close();
});

test('kernel socket close rejects pending execution without declaring the healthy RTC disconnected', async () => {
  const state = transport(); state.inject(); const kernel = await state.client.ensureKernel();
  const pending = state.client.kernelRequest('execute_request', { code: 'never executed by this test' }); await tick(); assert.equal(kernel.pending.size, 1);
  kernel.socket.close(); await assert.rejects(pending, /Kernel 连接已断开/);
  assert.equal(kernel.pending.size, 0); assert.equal(state.client.kernel, null); assert.equal(state.client.connected, true); assert.equal(state.client.closed, false); state.client.close();
});

test('closing the client rejects pending kernel requests and ignores late results', async () => {
  const state = transport(); state.inject(); const kernel = await state.client.ensureKernel();
  const pending = state.client.kernelRequest('execute_request', { code: 'never executed by this test' }); await tick();
  const id = [...kernel.pending.keys()][0]; state.client.close(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(kernel.pending.size, 0); kernel.socket.emit('message', Buffer.from(JSON.stringify({ channel: 'iopub', parent_header: { msg_id: id }, header: { msg_type: 'status' }, content: { execution_state: 'idle' } })));
  assert.equal(state.client.kernel, null); assert.equal(state.client.closed, true); assert.equal(state.statuses.filter(item => item.status === 'disconnected').length, 1);
});

test('requestUrl adapter cancels locally without accepting a late unabortable response', async () => {
  let release, calls = 0; const controller = new AbortController();
  const request = requestUrlFetch(() => { calls++; return new Promise(resolve => release = resolve); });
  const pending = request('http://127.0.0.1:8888/api/test', { signal: controller.signal }); await tick(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); release({ status: 200, json: { late: true } }); await tick(); assert.equal(calls, 1);
  await assert.rejects(request('http://127.0.0.1:8888/api/test', { signal: controller.signal }), { name: 'AbortError' }); assert.equal(calls, 1);
});

async function localServer() {
  const { WebSocketServer } = require('ws'), { YNotebook } = require('@jupyter/ydoc'), sync = require('y-protocols/sync.js'), encoding = require('lib0/encoding'), decoding = require('lib0/decoding');
  const notebook = YNotebook.create({ data: data() }), requests = [], sockets = new Set();
  const server = http.createServer((request, result) => {
    requests.push(request);
    if (request.url.startsWith('/api/collaboration/session/')) { result.writeHead(200, { 'Content-Type': 'application/json' }); result.end(JSON.stringify({ roomId: 'memory-notebook', sessionId: 'memory-session' })); }
    else { result.writeHead(200, { 'Content-Type': 'application/json' }); result.write('{"waiting":'); }
  });
  const websocket = new WebSocketServer({ server });
  websocket.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('message', raw => { const decoder = decoding.createDecoder(new Uint8Array(raw)), type = decoding.readVarUint(decoder); if (type !== 0) return; const out = encoding.createEncoder(); encoding.writeVarUint(out, 0); sync.readSyncMessage(decoder, out, notebook.ydoc, socket); if (encoding.length(out) > 1) socket.send(encoding.toUint8Array(out)); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { notebook, requests, sockets, url: 'http://127.0.0.1:' + server.address().port,
    async close() { for (const socket of sockets) socket.terminate(); await new Promise(resolve => websocket.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); notebook.dispose(); }
  };
}

test('native WebSocket Yjs handshake followed by a server disconnect invalidates the actual client', async () => {
  const server = await localServer(), statuses = []; const client = new JupyterRtcClient({ baseUrl: server.url, notebookPath: 'memory.ipynb', timeout: 1000, onStatus: (status, error) => statuses.push({ status, error }) });
  try {
    const snapshot = await client.connect(); assert.equal(client.connected, true); assert.equal(notebookHash(snapshot), notebookHash(server.notebook.toJSON()));
    const wrapper = client.socket, disconnected = new Promise(resolve => { const old = client.onStatus; client.onStatus = (status, error) => { old(status, error); if (status === 'disconnected') resolve(); }; });
    for (const socket of server.sockets) socket.terminate(); await disconnected;
    assert.equal(client.closed, true); assert.equal(client.connected, false); assert.equal(wrapper.synced, false); assert.equal(wrapper.closed, true);
    assert.throws(() => client.read(), /尚未连接/); assert.equal(statuses.filter(item => item.status === 'disconnected').length, 1);
  } finally { client.close(); await server.close(); }
});

test('native fetch body parsing is aborted when closing the connected client', async () => {
  const server = await localServer(), client = new JupyterRtcClient({ baseUrl: server.url, notebookPath: 'memory.ipynb', timeout: 1000, restTimeout: 5000 });
  try {
    await client.connect(); const pending = client.json('/api/hanging-body');
    while (!server.requests.some(request => request.url === '/api/hanging-body')) await tick();
    client.close(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(client.closed, true);
  } finally { client.close(); await server.close(); }
});

test('a synchronous transport failure during the Yjs transaction retains the already applied patch marker', async () => {
  const server = await localServer(), client = new JupyterRtcClient({ baseUrl: server.url, notebookPath: 'memory.ipynb', timeout: 1000 });
  try {
    const before = await client.connect(); client.socket.socket.send = () => { throw Error('transport stopped during submission'); };
    await assert.rejects(client.applyPatch({ baseHash: notebookHash(before), operations: [{ type: 'insert_cell', cellId: 'submitted', cellType: 'code', source: 'not executed' }] }), error => {
      assert.equal(error.applied, true); assert.equal(error.notebook.cells[0].id, 'submitted'); return true;
    });
    assert.equal(client.closed, true); assert.equal(client.connected, false);
  } finally { client.close(); await server.close(); }
});
