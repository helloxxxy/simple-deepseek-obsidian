const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const DEFAULT_ROOT = path.resolve(__dirname,'..');
const normalize = value => String(value).replace(/\r\n?/g,'\n').trim();
const order = (left,right) => left < right ? -1 : left > right ? 1 : 0;
const BSD_DISCLAIMER = `THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;
const BSD_NUMBERED = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

${BSD_DISCLAIMER}`;
const BSD_BULLETS = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

${BSD_DISCLAIMER}`;

// These npm tarballs omit their root LICENSE files. Preserve the official
// license text here, with exact supported versions, so builds remain offline.
// https://github.com/jupyter-server/jupyter_ydoc/blob/v4.1.1/LICENSE
const YDOC_LICENSE = `BSD 3-Clause License

Copyright (c) 2022, Jupyter Development Team
Copyright (c) 2022, David Brochart
All rights reserved.

${BSD_NUMBERED}`;
// https://github.com/jupyterlab/lumino/blob/main/LICENSE
// The additional source-file copyright is retained from the installed package.
const LUMINO_LICENSE = `Source file copyright notice:
Copyright (c) Jupyter Development Team.

Copyright (c) 2019-2023 Project Jupyter Contributors
All rights reserved.

${BSD_NUMBERED}


Copyright (c) 2014-2017, PhosphorJS Contributors
All rights reserved.

${BSD_BULLETS}`;
const FALLBACK_LICENSES = new Map([
  ['@jupyter/ydoc@4.1.1',YDOC_LICENSE],
  ['@lumino/algorithm@2.0.5',LUMINO_LICENSE],
  ['@lumino/coreutils@2.2.3',LUMINO_LICENSE],
  ['@lumino/signaling@2.1.6',LUMINO_LICENSE]
]);
const LICENSE_FILES = new Map([
  ['fflate','LICENSE'], ['pdf-lib','LICENSE.md'], ['@pdf-lib/standard-fonts','LICENSE.md'],
  ['@pdf-lib/upng','LICENSE'], ['pako','LICENSE'], ['tslib','LICENSE.txt'],
  ['lib0','LICENSE'], ['ws','LICENSE'], ['y-protocols','LICENSE'], ['yjs','LICENSE']
]);

function bundledPackages(root = DEFAULT_ROOT) {
  const {metafile} = esbuild.buildSync({absWorkingDir:root,entryPoints:['src/main.js'],bundle:true,platform:'node',format:'cjs',external:['obsidian','electron'],write:false,metafile:true});
  const packages = new Map();
  for (const output of Object.values(metafile.outputs)) for (const [input,info] of Object.entries(output.inputs)) {
    if (!info.bytesInOutput) continue;
    const unix = input.replace(/\\/g,'/'), marker = unix.lastIndexOf('node_modules/');
    if (marker < 0) continue;
    const tail = unix.slice(marker+'node_modules/'.length), segments = tail.split('/'), name = segments[0].startsWith('@') ? segments.slice(0,2).join('/') : segments[0];
    const directory = path.resolve(root,unix.slice(0,marker+'node_modules/'.length)+name);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
    if (metadata.name !== name || typeof metadata.version !== 'string') throw Error('Invalid bundled dependency metadata: '+name);
    const identity = name+'@'+metadata.version;
    const found = packages.get(identity) || {name,version:metadata.version,directory,inputs:[]};
    found.inputs.push(path.relative(directory,path.resolve(root,input)).split(path.sep).join('/'));
    packages.set(identity,found);
  }
  return [...packages.values()].map(item => ({...item,inputs:[...new Set(item.inputs)].sort(order)})).sort((left,right) => order(left.name,right.name)||order(left.version,right.version));
}

function packageNotice(item) {
  const licenseFile = LICENSE_FILES.get(item.name), fallback = FALLBACK_LICENSES.get(item.name+'@'+item.version);
  if (!licenseFile && !fallback) throw Error('No reviewed license notice for bundled dependency: '+item.name+'@'+item.version);
  const license = normalize(licenseFile ? fs.readFileSync(path.join(item.directory,licenseFile),'utf8') : fallback);
  if (!license || !/copyright/i.test(license)) throw Error('Missing copyright notice for bundled dependency: '+item.name);
  const sections = [item.name+' '+item.version+'\n\n'+license];
  if (item.name === 'pako') {
    const headers = new Map();
    for (const input of item.inputs.filter(file => file.startsWith('lib/zlib/'))) {
      const source = fs.readFileSync(path.join(item.directory,input),'utf8');
      for (const block of source.match(/\/\/[^\r\n]*(?:\r?\n\/\/[^\r\n]*)*/g) || []) {
        if (!/This software is provided/.test(block) || !/This notice may not be removed/.test(block)) continue;
        const notice = normalize(block.replace(/^\/\/ ?/gm,''));
        const files = headers.get(notice) || []; files.push(input); headers.set(notice,files);
      }
    }
    if (!headers.size) throw Error('The bundled pako Zlib notices were not found');
    for (const [notice,files] of [...headers].sort(([left],[right]) => order(left,right))) sections.push('Additional Zlib notice ('+files.sort(order).join(', ')+')\n\n'+notice);
  }
  return sections.join('\n\n');
}

function generateThirdPartyNotices(root = DEFAULT_ROOT) {
  const notices = bundledPackages(root).map(packageNotice);
  return 'Third-party notices for packages bundled in main.js.\n\n'+notices.join('\n\n'+'-'.repeat(79)+'\n\n')+'\n';
}

function checkThirdPartyNotices(root = DEFAULT_ROOT) {
  const expected = generateThirdPartyNotices(root), actual = fs.readFileSync(path.join(root,'THIRD-PARTY-LICENSE.txt'),'utf8');
  if (actual !== expected) throw Error('Third-party notices are out of date. Run node scripts/third-party-notices.cjs --write and review the changes.');
  return true;
}

if (require.main === module) {
  if (process.argv.includes('--write')) { fs.writeFileSync(path.join(DEFAULT_ROOT,'THIRD-PARTY-LICENSE.txt'),generateThirdPartyNotices(DEFAULT_ROOT),'utf8'); process.stdout.write('Third-party notices updated.\n'); }
  else { checkThirdPartyNotices(DEFAULT_ROOT); process.stdout.write('Third-party notices match bundled dependencies.\n'); }
}

module.exports = {bundledPackages,generateThirdPartyNotices,checkThirdPartyNotices};
