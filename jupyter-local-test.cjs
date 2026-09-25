const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { notebookLocation, ensureNotebook, jupyterExecutable, launchCommand, startLocalJupyter, stopLocalJupyter } = require('./src/jupyter-local');

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
