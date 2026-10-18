const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {bundledPackages,generateThirdPartyNotices,checkThirdPartyNotices} = require('./scripts/third-party-notices.cjs');

const root = __dirname;

test('third-party notices cover every package that contributes runtime bundle bytes', () => {
  const packages = bundledPackages(root), notices = generateThirdPartyNotices(root);
  assert.ok(packages.some(item => item.name === '@lumino/algorithm'));
  assert.ok(packages.some(item => item.name === 'pako'));
  for (const item of packages) assert.ok(notices.includes(item.name+' '+item.version+'\n\n'),item.name);
  assert.ok(!packages.some(item => ['esbuild','jsdom'].includes(item.name)));
  assert.equal(checkThirdPartyNotices(root),true);
});

test('notice generation is deterministic LF text with no machine paths', () => {
  const first = generateThirdPartyNotices(root), second = generateThirdPartyNotices(root);
  assert.equal(first,second);
  assert.ok(first.endsWith('\n'));
  assert.ok(!first.includes('\r'));
  assert.ok(!/(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|16874|node_modules)/.test(first));
  assert.equal(fs.readFileSync(path.join(root,'THIRD-PARTY-LICENSE.txt'),'utf8'),first);
});

test('notices retain complete upstream licenses and missing npm license copyright holders', () => {
  const notices = generateThirdPartyNotices(root);
  for (const [name,file] of [['fflate','LICENSE'],['pdf-lib','LICENSE.md'],['@pdf-lib/standard-fonts','LICENSE.md'],['@pdf-lib/upng','LICENSE'],['pako','LICENSE'],['tslib','LICENSE.txt'],['lib0','LICENSE'],['ws','LICENSE'],['y-protocols','LICENSE'],['yjs','LICENSE']]) {
    const license = fs.readFileSync(path.join(root,'node_modules',name,file),'utf8').replace(/\r\n?/g,'\n').trim();
    assert.ok(notices.includes(license),name);
  }
  assert.match(notices,/Copyright \(c\) 2022, Jupyter Development Team/);
  assert.match(notices,/Copyright \(c\) 2022, David Brochart/);
  assert.match(notices,/Copyright \(c\) 2019-2023 Project Jupyter Contributors/);
  assert.match(notices,/Copyright \(c\) 2014-2017, PhosphorJS Contributors/);
  assert.match(notices,/Neither the name of the copyright holder nor the names of its/);
  assert.match(notices,/CONSEQUENTIAL/);
});

test('pako notices include the bundled Zlib copyright and redistribution restrictions', () => {
  const notices = generateThirdPartyNotices(root), pako = bundledPackages(root).find(item => item.name === 'pako');
  let count = 0;
  for (const input of pako.inputs.filter(file => file.startsWith('lib/zlib/'))) {
    const source = fs.readFileSync(path.join(pako.directory,input),'utf8');
    const start = source.indexOf('// (C)'), end = source.indexOf('// 3. This notice may not be removed or altered from any source distribution.');
    if (start < 0 || end < start) continue;
    const header = source.slice(start,end+'// 3. This notice may not be removed or altered from any source distribution.'.length).replace(/^\/\/ ?/gm,'').replace(/\r\n?/g,'\n').trim();
    assert.ok(notices.includes(header),input); count++;
  }
  assert.ok(count >= 5);
  assert.match(notices,/Jean-loup Gailly and Mark Adler/);
  assert.match(notices,/Vitaly Puzrin and Andrey Tupitsin/);
  assert.match(notices,/Altered source versions must be plainly marked as such/);
});

test('a new bundled dependency without a reviewed notice blocks generation', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'simple-deepseek-notice-test-'));
  t.after(() => {
    const absolute = path.resolve(temporary), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(absolute),parent);
    assert.ok(path.basename(absolute).startsWith('simple-deepseek-notice-test-'));
    fs.rmSync(absolute,{recursive:true,force:true});
  });
  fs.mkdirSync(path.join(temporary,'src'));
  fs.mkdirSync(path.join(temporary,'node_modules','unreviewed-runtime'),{recursive:true});
  fs.writeFileSync(path.join(temporary,'src','main.js'),"module.exports = require('unreviewed-runtime');\n");
  fs.writeFileSync(path.join(temporary,'node_modules','unreviewed-runtime','package.json'),JSON.stringify({name:'unreviewed-runtime',version:'1.0.0',main:'index.js',license:'MIT'}));
  fs.writeFileSync(path.join(temporary,'node_modules','unreviewed-runtime','index.js'),'module.exports = 123;\n');
  assert.throws(() => generateThirdPartyNotices(temporary),/No reviewed license notice for bundled dependency: unreviewed-runtime@1\.0\.0/);
});
