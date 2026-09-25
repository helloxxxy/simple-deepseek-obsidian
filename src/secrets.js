const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const EMPTY = () => ({ deepseek: '', mineru: '', libraryPath: '', notebookPath: '', jupyterUrl: '', jupyterToken: '', jupyterRoot: '', jupyterExecutablePath: '', notebookFilePath: '' });
class KeyStore {
  constructor({ safeStorage, userData, vaultPath, platform = process.platform, io = fs, secureDirectory, uid = process.getuid?.() }) {
    this.safe = safeStorage; this.platform = platform; this.io = io; this.uid = uid;
    this.directory = path.join(userData, 'simple-deepseek-secrets');
    this.file = path.join(this.directory, createHash('sha256').update(path.resolve(vaultPath)).digest('hex') + '.json');
    this.secureDirectory = secureDirectory || protectDirectory;
    this.last = null; this.ready = false; this.available = false;
  }
  supported() {
    try {
      return !!this.safe?.isEncryptionAvailable() &&
        (this.platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.safe.getSelectedStorageBackend()));
    } catch { return false; }
  }
  async prepare() {
    if (!this.supported()) throw Error('System key storage unavailable');
    if (this.ready) return;
    await this.io.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await this.io.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (this.platform !== 'win32' && stat.uid !== this.uid)) throw Error('Unsafe key directory');
    await this.secureDirectory(this.directory, this.platform, this.io);
    this.ready = true; this.available = true;
  }
  async load() {
    await this.prepare();
    let record;
    try {
      const stat = await this.io.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || (this.platform !== 'win32' && stat.uid !== this.uid)) throw Error('Invalid encrypted key file');
      if (this.platform !== 'win32') await this.io.chmod(this.file, 0o600);
      record = JSON.parse(await this.io.readFile(this.file, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') { this.last = JSON.stringify(EMPTY()); return EMPTY(); } throw Error('Unable to load encrypted keys'); }
    if (record.version !== 1 || typeof record.ciphertext !== 'string') throw Error('Invalid encrypted key record');
    const keys = JSON.parse(this.safe.decryptString(Buffer.from(record.ciphertext, 'base64')));
    if (typeof keys.deepseek !== 'string' || typeof keys.mineru !== 'string' || ['libraryPath','notebookPath','jupyterUrl','jupyterToken','jupyterRoot','jupyterExecutablePath','notebookFilePath'].some(name => keys[name] !== undefined && typeof keys[name] !== 'string')) throw Error('Invalid decrypted settings');
    const result = { deepseek: keys.deepseek, mineru: keys.mineru, libraryPath: keys.libraryPath || '', notebookPath: keys.notebookPath || '', jupyterUrl: keys.jupyterUrl || '', jupyterToken: keys.jupyterToken || '', jupyterRoot: keys.jupyterRoot || '', jupyterExecutablePath: keys.jupyterExecutablePath || '', notebookFilePath: keys.notebookFilePath || '' }; this.last = JSON.stringify(result); return result;
  }
  async save(keys) {
    const plaintext = JSON.stringify({ deepseek: keys.deepseek, mineru: keys.mineru, libraryPath: keys.libraryPath || '', notebookPath: keys.notebookPath || '', jupyterUrl: keys.jupyterUrl || '', jupyterToken: keys.jupyterToken || '', jupyterRoot: keys.jupyterRoot || '', jupyterExecutablePath: keys.jupyterExecutablePath || '', notebookFilePath: keys.notebookFilePath || '' });
    if (plaintext === this.last) return;
    await this.prepare();
    if (!keys.deepseek && !keys.mineru && !keys.libraryPath && !keys.notebookPath && !keys.jupyterUrl && !keys.jupyterToken && !keys.jupyterRoot && !keys.jupyterExecutablePath && !keys.notebookFilePath) {
      await this.io.unlink(this.file).catch(e => { if (e.code !== 'ENOENT') throw e; }); this.last = plaintext; return;
    }
    const encrypted = this.safe.encryptString(plaintext);
    // Verify before writing. No plaintext is ever passed to the filesystem.
    if (this.safe.decryptString(encrypted) !== plaintext) throw Error('Encryption verification failed');
    const temp = this.file + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      await this.io.writeFile(temp, JSON.stringify({ version: 1, ciphertext: Buffer.from(encrypted).toString('base64') }), { flag: 'wx', mode: 0o600 });
      await this.io.rename(temp, this.file); this.last = plaintext;
    } finally { await this.io.unlink(temp).catch(() => {}); }
  }
}
async function protectDirectory(directory, platform, io = fs) {
  if (platform !== 'win32') { await io.chmod(directory, 0o700); return; }
  const script = "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($env:SIMPLE_DEEPSEEK_KEY_DIR,$acl)";
  await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, env: { ...process.env, SIMPLE_DEEPSEEK_KEY_DIR: directory } });
}
function createKeyStore(app) {
  const remote = globalThis.window?.electron?.remote;
  const vaultPath = app?.vault?.adapter?.getBasePath?.();
  if (!remote?.safeStorage || !remote?.app?.getPath || !vaultPath) throw Error('Obsidian system storage bridge unavailable');
  return new KeyStore({ safeStorage: remote.safeStorage, userData: remote.app.getPath('userData'), vaultPath });
}
module.exports = { KeyStore, createKeyStore, protectDirectory };
