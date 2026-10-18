const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { notebookLocation, ensureNotebook, jupyterExecutable, launchCommand, probeServer, startLocalJupyter, stopLocalJupyter } = require('./src/jupyter-local');

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(__dirname, 'jupyter-local-test-'));
  try { await run(directory); } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(__dirname)) throw Error('Unsafe test cleanup path');
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('local Notebook address creates a valid empty file once in its own directory', async () => fixture(async directory => {
  const location = notebookLocation(path.join(directory, 'example', 'answer.ipynb'));
  assert.equal(await ensureNotebook(location), true);
  assert.deepEqual(JSON.parse(await fs.readFile(location.file, 'utf8')), { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 });
  assert.equal(await ensureNotebook(location), false);
  await fs.writeFile(location.file, '{"keep":true}');
  assert.equal(await ensureNotebook(location), false);
  assert.equal(await fs.readFile(location.file, 'utf8'), '{"keep":true}');
  assert.throws(() => notebookLocation('answer.ipynb'), /完整/);
}));

test('local launch resolves jupyter.exe, confines server to Notebook directory and reuses authenticated server', async () => fixture(async directory => {
  const program = path.join(directory, 'jupyter.exe'), file = path.join(directory, 'notebooks', 'answer.ipynb');
  await fs.writeFile(program, 'test launcher');
  assert.equal(await jupyterExecutable(program.slice(0, -4), fs, 'win32'), program);
  const python = path.join(directory, 'python.exe'); await fs.writeFile(python, 'test interpreter');
  assert.deepEqual(await launchCommand(program, fs, 'win32'), { file: python, prefix: ['-m', 'jupyterlab'] });
  let invocation, checks = 0;
  const child = Object.assign(new EventEmitter(), { exitCode: null, unref() {}, kill() { this.killed = true; } });
  const launch = await startLocalJupyter({ executablePath: program, notebookFilePath: file, portProvider: async () => 19234,
    probe: async () => ++checks > 1,
    spawnImpl: (exe, args, options) => { invocation = { exe, args, options }; return child; } });
  assert.equal(launch.created, true); assert.equal(launch.reused, false); assert.equal(launch.name, 'answer.ipynb');
  if (process.platform === 'win32') { assert.equal(invocation.exe, python); assert.deepEqual(invocation.args.slice(0, 2), ['-m', 'jupyterlab']); }
  else { assert.equal(invocation.exe, program); assert.equal(invocation.args[0], 'lab'); }
  assert.equal(invocation.options.cwd, path.dirname(file));
  assert.equal(invocation.options.detached, process.platform !== 'win32'); assert.equal(invocation.options.windowsHide, true);
  assert.ok(invocation.args.includes(`--ServerApp.root_dir=${path.dirname(file)}`));
  assert.ok(invocation.args.includes('--ServerApp.ip=127.0.0.1'));
  assert.match(invocation.options.env.JUPYTER_TOKEN, /^[0-9a-f]{64}$/);
  assert.equal(launch.browserUrl, `${launch.baseUrl}/lab/tree/answer.ipynb?token=${launch.token}`);
  const reused = await startLocalJupyter({ executablePath: program, notebookFilePath: file,
    previous: { root: launch.root, baseUrl: launch.baseUrl, token: launch.token }, probe: async () => true,
    spawnImpl: () => assert.fail('reuse must not start another server') });
  assert.equal(reused.reused, true); assert.equal(reused.created, false);
}));

test('closing mode stops only a Jupyter process launched by this plugin view', async () => {
  let shutdowns = 0;
  const server = http.createServer((request, response) => { shutdowns++; assert.equal(request.url, '/api/shutdown'); response.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const local = { baseUrl, token: 'test-token', child: { exitCode: 0, signalCode: null, kill() { assert.fail('already exited'); } } };
    await stopLocalJupyter(local); await stopLocalJupyter(local);
    assert.equal(shutdowns, 1);
    await stopLocalJupyter({ baseUrl, token: 'test-token', reused: true });
    assert.equal(shutdowns, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('cancelling a pending local launch terminates its child process promptly', async () => fixture(async directory => {
  const program = path.join(directory, 'jupyter.exe'), file = path.join(directory, 'answer.ipynb');
  await fs.writeFile(program, 'test launcher');
  const controller = new AbortController();
  const child = Object.assign(new EventEmitter(), { exitCode: null, unref() {}, kill() { this.killed = true; } });
  const started = Date.now();
  await assert.rejects(startLocalJupyter({ executablePath: program, notebookFilePath: file, signal: controller.signal,
    portProvider: async () => 19235, spawnImpl: () => child, probe: async () => { controller.abort(); return false; }, timeout: 25000 }),
  error => error.name === 'AbortError');
  assert.equal(child.killed, true);
  assert.ok(Date.now() - started < 1000);
}));

test('cancelling during notebook directory creation prevents a later empty notebook write', async () => {
  const controller = new AbortController(); let writes = 0, stats = 0;
  const io = { mkdir: async () => controller.abort(), lstat: async () => { stats++; }, writeFile: async () => writes++ };
  await assert.rejects(ensureNotebook({ root: 'unused', file: 'unused.ipynb' }, io, controller.signal), { name: 'AbortError' });
  assert.equal(writes, 0); assert.equal(stats, 0);
});

test('cancelling a previous-server probe that ignores its signal never starts another process', async () => fixture(async directory => {
  const program = path.join(directory, 'jupyter.exe'), file = path.join(directory, 'answer.ipynb'); await fs.writeFile(program, 'test launcher');
  const controller = new AbortController(); let probing, seenSignal, spawned = 0;
  const ready = new Promise(resolve => probing = resolve);
  const pending = startLocalJupyter({ executablePath: program, notebookFilePath: file, previous: { root: directory, baseUrl: 'http://127.0.0.1:19234', token: 'test-token' }, signal: controller.signal,
    probe: (_url, _token, _timeout, signal) => { seenSignal = signal; probing(); return new Promise(() => {}); }, spawnImpl: () => { spawned++; assert.fail('cancelled probe cannot spawn'); } });
  await ready; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(seenSignal.aborted, true); assert.equal(spawned, 0);
}));

test('cancelling an owned launch interrupts an unresponsive readiness probe and kills only its child', async () => fixture(async directory => {
  const program = path.join(directory, 'jupyter.exe'); await fs.writeFile(program, 'test launcher');
  const controller = new AbortController(), child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() { this.killed = true; }, unref() {} });
  let probing; const ready = new Promise(resolve => probing = resolve);
  const pending = startLocalJupyter({ executablePath: program, notebookFilePath: path.join(directory, 'answer.ipynb'), signal: controller.signal, portProvider: async () => 19235,
    spawnImpl: () => child, probe: () => { probing(); return new Promise(() => {}); } });
  await ready; controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(child.killed, true);
}));

test('startup deadline bounds a hanging readiness probe instead of waiting for its Promise forever', async () => fixture(async directory => {
  const program = path.join(directory, 'jupyter.exe'); await fs.writeFile(program, 'test launcher');
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() { this.killed = true; }, unref() {} });
  const start = Date.now();
  await assert.rejects(startLocalJupyter({ executablePath: program, notebookFilePath: path.join(directory, 'answer.ipynb'), timeout: 25, portProvider: async () => 19235,
    spawnImpl: () => child, probe: () => new Promise(() => {}) }), /启动超时/);
  assert.equal(child.killed, true); assert.ok(Date.now() - start < 1000);
}));

test('a process ended by a signal fails before any additional readiness probe', async () => fixture(async directory => {
  const program = path.join(directory, 'jupyter.exe'); await fs.writeFile(program, 'test launcher');
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: 'SIGTERM', kill() { assert.fail('already ended process'); }, unref() {} });
  await assert.rejects(startLocalJupyter({ executablePath: program, notebookFilePath: path.join(directory, 'answer.ipynb'), portProvider: async () => 19235, spawnImpl: () => child,
    probe: async () => assert.fail('process has already ended') }), /启动失败/);
}));

test('a successful readiness response cannot revive a child that exited while the probe was pending', async () => fixture(async directory => {
  const program = path.join(directory, 'jupyter.exe'); await fs.writeFile(program, 'test launcher');
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() { assert.fail('already exited'); }, unref() {} });
  await assert.rejects(startLocalJupyter({ executablePath: program, notebookFilePath: path.join(directory, 'answer.ipynb'), portProvider: async () => 19235, spawnImpl: () => child,
    probe: async () => { child.exitCode = 0; return true; } }), /启动失败/);
}));

test('HTTP health probes obey total deadlines even when a server continuously sends an unfinished response', async () => {
  let timer;
  const server = http.createServer((_request, response) => {
    response.writeHead(200); response.write('{'); timer = setInterval(() => response.write(' '), 5); response.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const start = Date.now(); assert.equal(await probeServer(`http://127.0.0.1:${server.address().port}`, 'token', 35), false); assert.ok(Date.now() - start < 1000);
  } finally { clearInterval(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('cancelling an HTTP health probe closes its request without waiting for the server body', async () => {
  let arrived; const ready = new Promise(resolve => arrived = resolve);
  const server = http.createServer((_request, response) => { response.writeHead(200); response.write('{'); arrived(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const controller = new AbortController(), pending = probeServer(`http://127.0.0.1:${server.address().port}`, 'token', 5000, controller.signal);
    await ready; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('an interrupted shutdown response does not delay cleanup of an already exited owned process', async () => {
  const server = http.createServer((_request, response) => { response.writeHead(200); response.write('closing'); setTimeout(() => response.destroy(), 5); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const start = Date.now();
    await stopLocalJupyter({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test-token', child: { exitCode: 0, signalCode: null, kill() { assert.fail('already exited process'); } } });
    assert.ok(Date.now() - start < 1000);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
