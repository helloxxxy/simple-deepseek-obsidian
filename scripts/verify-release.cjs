const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../manifest.json');
const pkg = require('../package.json');
const versions = require('../versions.json');

assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.id, 'simple-deepseek');
assert.equal(pkg.name, 'simple-deepseek-obsidian');
assert.equal(pkg.version, manifest.version);
assert.equal(versions[manifest.version], manifest.minAppVersion);
assert.equal(manifest.isDesktopOnly, true);
assert.equal(manifest.author, 'helloxxxy');
assert.match(fs.readFileSync(path.resolve(__dirname, '..', 'LICENSE'), 'utf8'), /^MIT License\s/m);
const built = path.resolve(__dirname, '..', 'dist', 'simple-deepseek');
for (const name of ['main.js', 'manifest.json', 'styles.css', 'THIRD-PARTY-LICENSE.txt']) {
  assert.ok(fs.statSync(path.join(built, name)).isFile(), `Missing release asset: ${name}`);
}
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(built, 'manifest.json'), 'utf8')), manifest);
console.log(`Release ${manifest.version} is ready for GitHub assets.`);
