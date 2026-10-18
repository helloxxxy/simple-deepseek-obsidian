const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { zipSync } = require('fflate');

const ASSETS = ['main.js','manifest.json','styles.css'];
const ROOT_FILES = ['.gitattributes','.gitignore','LICENSE','THIRD-PARTY-LICENSE.txt','README.md','README.zh-CN.md','PRIVACY.md','RELEASE_NOTES.md','manifest.json','versions.json','package.json','package-lock.json','build.cjs','styles.css'];
const WORKFLOWS = ['.github/workflows/ci.yml','.github/workflows/release.yml'];
const normalize = text => text.replace(/\r\n?/g,'\n');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function repositoryFiles(root) {
  root = fs.realpathSync(root);
  const files = [...ROOT_FILES,...WORKFLOWS];
  const collect = directory => {
    const absolute = path.join(root,directory);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error(`Unsafe public source directory: ${directory}`);
    for (const entry of fs.readdirSync(absolute,{withFileTypes:true})) {
      const relative = directory+'/'+entry.name;
      if (entry.isSymbolicLink()) throw Error(`Symbolic link is not a release source: ${relative}`);
      if (entry.isDirectory()) collect(relative);
      else if (entry.isFile() && /\.(?:js|cjs)$/.test(entry.name)) files.push(relative);
    }
  };
  collect('src'); collect('scripts');
  files.push(...fs.readdirSync(root).filter(name => name === 'test.cjs' || /-test\.cjs$/.test(name)));
  for (const name of files) {
    const absolute = path.join(root,name), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) throw Error(`Release source must be an ordinary file: ${name}`);
    const real = fs.realpathSync(absolute), relative = path.relative(root,real);
    if (relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw Error(`Release source escaped repository: ${name}`);
  }
  return [...new Set(files)].sort();
}

function sourceEntries(root, files = repositoryFiles(root)) {
  return Object.fromEntries(files.map(name => [name,Buffer.from(normalize(fs.readFileSync(path.join(root,name),'utf8')))]));
}

function archive(entries) {
  return Buffer.from(zipSync(Object.fromEntries(Object.keys(entries).sort().map(name => [name,[entries[name],{mtime:new Date(2000,0,1,0,0,0),level:6}]]))));
}

function prepareRelease(root, destination) {
  root = fs.realpathSync(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.id !== 'simple-deepseek') throw Error('Invalid release identity');
  destination = path.resolve(destination || path.join(root,'..','outputs',`simple-deepseek-obsidian-release-${manifest.version}`));
  const relative = path.relative(root,destination);
  if (!relative || (!relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('Release output must be outside the source repository');
  if (fs.existsSync(destination)) throw Error('Release output already exists; choose a new --output directory');
  execFileSync(process.execPath,[path.join(root,'scripts','verify-release.cjs')],{cwd:root,stdio:'pipe',windowsHide:true});
  const entries = sourceEntries(root), assets = Object.fromEntries(ASSETS.map(name => [name,fs.readFileSync(path.join(root,'dist',manifest.id,name))]));
  fs.mkdirSync(destination,{recursive:true});
  for (const [name,bytes] of Object.entries(entries)) {
    const target = path.join(destination,'repository',name); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,bytes,{flag:'wx'});
  }
  fs.mkdirSync(path.join(destination,'release-assets'));
  for (const [name,bytes] of Object.entries(assets)) fs.writeFileSync(path.join(destination,'release-assets',name),bytes,{flag:'wx'});
  const sourceZip = `simple-deepseek-obsidian-${manifest.version}-source.zip`, pluginZip = `simple-deepseek-${manifest.version}.zip`;
  fs.writeFileSync(path.join(destination,sourceZip),archive(entries),{flag:'wx'});
  fs.writeFileSync(path.join(destination,pluginZip),archive(Object.fromEntries(Object.entries(assets).map(([name,bytes]) => [manifest.id+'/'+name,bytes]))),{flag:'wx'});
  fs.writeFileSync(path.join(destination,'RELEASE_NOTES.md'),entries['RELEASE_NOTES.md'],{flag:'wx'});
  const sums = [...ASSETS.map(name => 'release-assets/'+name),sourceZip,pluginZip].map(name => sha256(fs.readFileSync(path.join(destination,name)))+'  '+name).join('\n')+'\n';
  fs.writeFileSync(path.join(destination,'SHA256SUMS.txt'),sums,{flag:'wx'});
  return {directory:destination,version:manifest.version,sourceFiles:Object.keys(entries).length,assets:ASSETS.map(name => ({name,sha256:sha256(assets[name]),bytes:assets[name].length})),sourceZip,pluginZip};
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output')) throw Error('Usage: node scripts/package-release.cjs [--output DIRECTORY]');
  console.log(JSON.stringify(prepareRelease(path.resolve(__dirname,'..'),args[1]),null,2));
}
module.exports = {ASSETS,ROOT_FILES,WORKFLOWS,repositoryFiles,sourceEntries,archive,prepareRelease};
