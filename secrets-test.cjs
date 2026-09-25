const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');const {KeyStore,protectDirectory}=require('./src/secrets');
function cryptoBackend(backend='gnome_libsecret') {
 const key=crypto.randomBytes(32);return {isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=>backend,
 encryptString:text=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);},
 decryptString:blob=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,blob.subarray(0,12));decipher.setAuthTag(blob.subarray(12,28));return Buffer.concat([decipher.update(blob.subarray(28)),decipher.final()]).toString('utf8');}};
}
async function fixture(run) {
 const dir=await fs.mkdtemp(path.join(__dirname,'key-test-'));try{await run(dir);}finally{
 const child=path.join(dir,'simple-deepseek-secrets');for(const name of await fs.readdir(child).catch(()=>[]))await fs.unlink(path.join(child,name));await fs.rmdir(child).catch(()=>{});await fs.rmdir(dir);
 }
}
test('secure store: encrypted roundtrip, separate vaults, no plaintext, deletion',async()=>fixture(async dir=>{
 const safe=cryptoBackend();let protection=0;const options={safeStorage:safe,userData:dir,vaultPath:path.join(dir,'vault'),secureDirectory:async()=>protection++};
 const empty={deepseek:'',mineru:'',libraryPath:'',notebookPath:'',jupyterUrl:'',jupyterToken:'',jupyterRoot:'',jupyterExecutablePath:'',notebookFilePath:''};
 const stored={deepseek:'fake-api-secret',mineru:'fake-mineru-secret',libraryPath:'C:/private/library',notebookPath:'course/hw.ipynb',jupyterUrl:'http://127.0.0.1:8888',jupyterToken:'local-token',jupyterRoot:'C:/private/homework',jupyterExecutablePath:'C:/private/python/Scripts/jupyter.exe',notebookFilePath:'C:/private/homework/hw.ipynb'};
 const store=new KeyStore(options);assert.deepEqual(await store.load(),empty);await store.save(stored);
 const file=await fs.readFile(store.file,'utf8');for(const secret of ['fake-api-secret','fake-mineru-secret','private/library','course/hw.ipynb','127.0.0.1','local-token','private/homework','private/python'])assert.ok(!file.includes(secret));assert.equal(protection,1);
 const restored=new KeyStore(options);assert.deepEqual(await restored.load(),stored);
 const other=new KeyStore({...options,vaultPath:path.join(dir,'another-vault')});assert.notEqual(other.file,store.file);assert.deepEqual(await other.load(),empty);
 await restored.save({deepseek:'',mineru:'',libraryPath:'',notebookPath:'',jupyterUrl:'',jupyterToken:''});await assert.rejects(fs.access(store.file));
}));
test('secure store: Linux unsafe or unknown backend refuses before any file write',async()=>{
 for(const backend of ['basic_text','unknown','unverified']){const store=new KeyStore({safeStorage:cryptoBackend(backend),platform:'linux',userData:__dirname,vaultPath:__dirname,io:{mkdir:()=>assert.fail('no filesystem access')}});await assert.rejects(store.save({deepseek:'secret',mineru:''}));}
});
test('secure store: encryption failure preserves existing ciphertext and creates no temp',async()=>fixture(async dir=>{
 const safe=cryptoBackend();const store=new KeyStore({safeStorage:safe,userData:dir,vaultPath:dir,secureDirectory:async()=>{}});await store.load();await store.save({deepseek:'old-key',mineru:''});const original=await fs.readFile(store.file,'utf8');safe.encryptString=()=>{throw Error('unavailable');};await assert.rejects(store.save({deepseek:'new-key',mineru:''}));assert.equal(await fs.readFile(store.file,'utf8'),original);assert.equal((await fs.readdir(store.directory)).length,1);
}));
test('secure store: other encryption identity cannot decrypt the same file',async()=>fixture(async dir=>{
 const options={userData:dir,vaultPath:dir,secureDirectory:async()=>{}};const first=new KeyStore({...options,safeStorage:cryptoBackend()});await first.load();await first.save({deepseek:'secret',mineru:''});const other=new KeyStore({...options,safeStorage:cryptoBackend()});await assert.rejects(other.load());
}));
test('secure store: rejects unsafe directory before chmod or write',async()=>{
 const store=new KeyStore({safeStorage:cryptoBackend(),userData:__dirname,vaultPath:__dirname,io:{mkdir:async()=>{},lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>true})},secureDirectory:()=>assert.fail('no permission mutation')});await assert.rejects(store.load());
});
test('Windows integration: private directory ACL grants only current identity', {skip:process.platform!=='win32'},async()=>fixture(async dir=>{
 const secretDir=path.join(dir,'simple-deepseek-secrets');await fs.mkdir(secretDir);await protectDirectory(secretDir,'win32');
 const {execFileSync}=require('node:child_process');const exe=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const result=execFileSync(exe,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$acl=[System.IO.Directory]::GetAccessControl($env:MINIMAL_AI_KEY_DIR);if(!$acl.AreAccessRulesProtected){throw 'inheritance'};foreach($r in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.IdentityReference.Value -ne $sid -or $r.AccessControlType -ne 'Allow'){throw 'unexpected identity'}};$bytes=[Text.Encoding]::UTF8.GetBytes('test-only-not-a-real-key');[void][Reflection.Assembly]::LoadWithPartialName('System.Security');$encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);$decoded=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);if([Text.Encoding]::UTF8.GetString($decoded) -ne 'test-only-not-a-real-key'){throw 'roundtrip'};Write-Output 'PASS'"],{encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,MINIMAL_AI_KEY_DIR:secretDir}});assert.equal(result.trim(),'PASS');
}));

test('secure store: Unix directory permissions are owner-only and unexpected owner is refused',async()=>{
 const modes=[];await protectDirectory('/test-directory','linux',{chmod:async(p,mode)=>modes.push(mode)});assert.deepEqual(modes,[0o700]);
 const store=new KeyStore({safeStorage:cryptoBackend(),platform:'linux',uid:123,userData:__dirname,vaultPath:__dirname,io:{mkdir:async()=>{},lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false,uid:456})},secureDirectory:()=>assert.fail('do not modify another owner directory')});await assert.rejects(store.load());
});
