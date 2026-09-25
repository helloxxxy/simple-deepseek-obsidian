const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const out = path.join(__dirname, 'dist', 'simple-deepseek');
fs.mkdirSync(out, {recursive:true});
esbuild.buildSync({entryPoints:[path.join(__dirname,'src','main.js')],bundle:true,platform:'node',format:'cjs',external:['obsidian','electron'],outfile:path.join(out,'main.js')});
for (const name of ['manifest.json','styles.css','THIRD-PARTY-LICENSE.txt']) fs.copyFileSync(path.join(__dirname,name),path.join(out,name));
