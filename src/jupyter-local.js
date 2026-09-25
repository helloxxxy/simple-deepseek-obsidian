const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

function checkCancelled(signal) {
  if (signal?.aborted) { const error = new Error('已取消 Jupyter 连接'); error.name = 'AbortError'; throw error; }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    try { checkCancelled(signal); } catch (error) { reject(error); return; }
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); try { checkCancelled(signal); } catch (error) { reject(error); } };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function notebookLocation(value) {
  const file = String(value || '').trim();
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.ipynb') throw Error('请填写 Notebook 的完整 .ipynb 文件路径');
  const absolute = path.resolve(file);
  return { file: absolute, root: path.dirname(absolute), name: path.basename(absolute) };
}

async function ensureNotebook(location, io = fs) {
  await io.mkdir(location.root, { recursive: true });
  try {
    const stat = await io.lstat(location.file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Notebook 路径不是普通文件');
    return false;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const initial = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 };
  try { await io.writeFile(location.file, JSON.stringify(initial, null, 2) + '\n', { flag: 'wx' }); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}

async function jupyterExecutable(value, io = fs, platform = process.platform) {
  const raw = String(value || '').trim();
  if (!path.isAbsolute(raw)) throw Error('请填写 Jupyter 启动程序的完整路径');
  const candidates = platform === 'win32' && !path.extname(raw) ? [raw + '.exe', raw] : [raw];
  for (const candidate of candidates) {
    try { if ((await io.stat(candidate)).isFile()) return candidate; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw Error('找不到 Jupyter 启动程序；Windows 可填写 Scripts\\jupyter 或 Scripts\\jupyter.exe');
}

async function launchCommand(executable, io = fs, platform = process.platform) {
  const name = path.basename(executable).replace(/\.exe$/i, '').toLowerCase();
  if (platform === 'win32' && (name === 'jupyter' || name === 'jupyter-lab')) {
    const scripts = path.dirname(executable);
    for (const candidate of [path.join(scripts, 'python.exe'), path.join(path.dirname(scripts), 'python.exe')]) {
      try { if ((await io.stat(candidate)).isFile()) return { file: candidate, prefix: ['-m', 'jupyterlab'] }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return { file: executable, prefix: name === 'jupyter-lab' ? [] : ['lab'] };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function probeServer(baseUrl, token, timeout = 1000) {
  return new Promise(resolve => {
    const request = http.get(baseUrl + '/api/status', { headers: { Authorization: `token ${token}` }, timeout }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode === 200));
    });
    request.on('error', () => resolve(false)); request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

async function startLocalJupyter({ executablePath, notebookFilePath, previous, signal, spawnImpl = spawn, portProvider = freePort, probe = probeServer, io = fs, timeout = 25000 }) {
  checkCancelled(signal);
  const location = notebookLocation(notebookFilePath);
  const executable = await jupyterExecutable(executablePath, io);
  checkCancelled(signal);
  const created = await ensureNotebook(location, io);
  if (previous?.root === location.root && previous?.baseUrl && previous?.token && await probe(previous.baseUrl, previous.token)) {
    checkCancelled(signal);
    return { ...location, executable, baseUrl: previous.baseUrl, token: previous.token, created, reused: true, browserUrl: `${previous.baseUrl}/lab/tree/${encodeURIComponent(location.name)}?token=${encodeURIComponent(previous.token)}` };
  }
  checkCancelled(signal);
  const port = await portProvider(), token = randomBytes(32).toString('hex'), baseUrl = `http://127.0.0.1:${port}`;
  const command = await launchCommand(executable, io);
  checkCancelled(signal);
  const args = [ ...command.prefix, '--no-browser', '--ServerApp.ip=127.0.0.1', `--ServerApp.port=${port}`, '--ServerApp.port_retries=0', `--ServerApp.root_dir=${location.root}`, '--ServerApp.open_browser=False' ];
  // On Windows, detached processes get a separate console window even with windowsHide.
  const child = spawnImpl(command.file, args, { cwd: location.root, env: { ...process.env, JUPYTER_TOKEN: token }, detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true });
  let launchError;
  child.once('error', error => { launchError = error; }); child.unref?.();
  try {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      checkCancelled(signal);
      if (launchError || child.exitCode !== null) throw Error('Jupyter 启动失败；请检查启动程序，以及同一环境中的 jupyterlab 和 jupyter-collaboration');
      if (await probe(baseUrl, token)) {
        checkCancelled(signal);
        return { ...location, executable, baseUrl, token, child, created, reused: false, browserUrl: `${baseUrl}/lab/tree/${encodeURIComponent(location.name)}?token=${encodeURIComponent(token)}` };
      }
      await wait(150, signal);
    }
    throw Error('Jupyter 启动超时；请检查启动程序和协作扩展是否可用');
  } catch (error) {
    child.kill?.();
    throw error;
  }
}

async function stopLocalJupyter(local) {
  if (!local?.child) return;
  if (local.stopPromise) return local.stopPromise;
  local.stopPromise = (async () => {
    await new Promise(resolve => {
      let settled = false, request;
      const done = () => { if (settled) return; settled = true; clearTimeout(deadline); resolve(); };
      const deadline = setTimeout(() => { request?.destroy(); done(); }, 5000);
      try {
        request = http.request(local.baseUrl + '/api/shutdown', { method: 'POST', headers: { Authorization: `token ${local.token}` }, timeout: 2000 }, response => { response.resume(); response.on('end', done); });
        request.on('error', done); request.on('timeout', () => { request.destroy(); done(); }); request.end();
      } catch { done(); }
    });
    const deadline = Date.now() + 3000;
    while (local.child.exitCode === null && local.child.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (local.child.exitCode === null && local.child.signalCode === null) local.child.kill?.();
  })();
  return local.stopPromise;
}

module.exports = { notebookLocation, ensureNotebook, jupyterExecutable, launchCommand, probeServer, startLocalJupyter, stopLocalJupyter };
