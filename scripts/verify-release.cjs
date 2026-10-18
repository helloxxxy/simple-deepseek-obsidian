const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { checkThirdPartyNotices } = require('./third-party-notices.cjs');
const manifest = require('../manifest.json');
const pkg = require('../package.json');
const versions = require('../versions.json');
const lock = require('../package-lock.json');
const root = path.resolve(__dirname,'..');

assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.id, 'simple-deepseek');
assert.equal(pkg.name, 'simple-deepseek-obsidian');
assert.equal(pkg.version, manifest.version);
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages[''].version, manifest.version);
assert.equal(versions[manifest.version], manifest.minAppVersion);
assert.equal(manifest.isDesktopOnly, true);
assert.equal(manifest.author, 'helloxxxy');
assert.match(fs.readFileSync(path.resolve(__dirname, '..', 'LICENSE'), 'utf8'), /^MIT License\s/m);
const built = path.resolve(__dirname, '..', 'dist', 'simple-deepseek');
const assets = ['main.js','manifest.json','styles.css'];
assert.deepEqual(fs.readdirSync(built).sort(),[...assets].sort(),'Release assets must contain only the files installed by Obsidian');
for (const name of assets) {
  assert.ok(fs.statSync(path.join(built, name)).isFile(), `Missing release asset: ${name}`);
}
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(built, 'manifest.json'), 'utf8')), manifest);
const normalize = text => text.replace(/\r\n?/g,'\n');
assert.equal(fs.readFileSync(path.join(built,'styles.css'),'utf8'),normalize(fs.readFileSync(path.join(root,'styles.css'),'utf8')));
checkThirdPartyNotices(root);
const bundle = fs.readFileSync(path.join(built,'main.js'),'utf8');
new vm.Script(bundle,{filename:'main.js'});
assert.ok(bundle.startsWith(`/*!\nSimple DeepSeek ${manifest.version}\n`),'The bundle must identify the released version');
for (const name of ['LICENSE','THIRD-PARTY-LICENSE.txt']) assert.ok(bundle.includes(normalize(fs.readFileSync(path.join(root,name),'utf8')).trim()),`Missing embedded notices: ${name}`);
const tests = fs.readdirSync(root).filter(name => name === 'test.cjs' || /-test\.cjs$/.test(name));
const testFiles = new Set(pkg.scripts.test.split(/\s+/));
for (const name of tests) assert.ok(testFiles.has(name),`Test missing from npm test: ${name}`);
console.log(`Release ${manifest.version} is ready for GitHub assets.`);
