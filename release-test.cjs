const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {unzipSync,strFromU8} = require('fflate');
const {ASSETS,ROOT_FILES,WORKFLOWS,repositoryFiles,sourceEntries,archive} = require('./scripts/package-release.cjs');

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent,'simple-deepseek-release-'));
  t.after(() => {
    const resolved = fs.realpathSync(root), relative = path.relative(parent,resolved);
    assert.ok(relative.startsWith('simple-deepseek-release-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  for (const name of [...ROOT_FILES,...WORKFLOWS,'src/main.js','scripts/package-release.cjs','test.cjs','example-test.cjs']) {
    fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true}); fs.writeFileSync(path.join(root,name),'public\r\n');
  }
  return root;
}
test('public release sources exclude local secrets, histories, notebooks, dependencies and Git state',t => {
  const root = fixture(t);
  const privateFiles = ['.env','data.json','private.ipynb','conversations/conversation-private.json','.git/config','node_modules/private/index.js','dist/simple-deepseek/main.js','outputs/saved.json','.obsidian/private.json','src/config.local.json'];
  for (const name of privateFiles) { fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true}); fs.writeFileSync(path.join(root,name),'PRIVATE_PAYLOAD'); }
  const files = repositoryFiles(root), entries = sourceEntries(root,files);
  assert.ok(files.includes('.github/workflows/release.yml')); assert.ok(files.includes('src/main.js')); assert.ok(files.includes('example-test.cjs')); assert.ok(files.includes('styles.css'));
  assert.ok(privateFiles.every(name => !files.includes(name)));
  assert.ok(!Buffer.concat(Object.values(entries)).toString().includes('PRIVATE_PAYLOAD'));
  assert.ok(Object.values(entries).every(bytes => !bytes.includes(13)));
});
test('source archives preserve hidden workflow paths and are reproducible independently of filesystem timestamps',t => {
  const root = fixture(t), entries = sourceEntries(root), first = archive(entries);
  fs.utimesSync(path.join(root,'src/main.js'),new Date(1),new Date(1));
  assert.deepEqual(archive(sourceEntries(root)),first);
  const files = unzipSync(first); assert.ok(files['.github/workflows/release.yml']); assert.equal(strFromU8(files['src/main.js']),'public\n');
  assert.deepEqual(ASSETS,['main.js','manifest.json','styles.css']);
});
test('release sources fail on missing required files instead of preparing an incomplete repository',t => {
  const root = fixture(t); fs.unlinkSync(path.join(root,'manifest.json'));
  assert.throws(() => repositoryFiles(root),{code:'ENOENT'});
});
test('ZIP metadata is reproducible across publishing-machine time zones',() => {
  const script = 'const {archive}=require("./scripts/package-release.cjs");const {createHash}=require("node:crypto");process.stdout.write(createHash("sha256").update(archive({"file.txt":Buffer.from("same contents")})).digest("hex"));';
  const digest = zone => execFileSync(process.execPath,['-e',script],{cwd:__dirname,env:{...process.env,TZ:zone},windowsHide:true,encoding:'utf8'});
  assert.equal(digest('UTC'),digest('Asia/Shanghai'));
});
