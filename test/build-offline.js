'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { build, sources } = require('../tools/build-offline');
const { serve } = require('../tools/serve-offline');

async function main() {
  const out = build();
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'build-manifest.json')));
  const files = fs.readdirSync(out, { recursive: true })
    .filter(f => fs.statSync(path.join(out, f)).isFile()).sort();
  assert.deepEqual(files, [...sources, 'index.html', 'build-manifest.json'].sort());
  for (const source of sources) {
    const bytes = fs.readFileSync(path.join(out, source));
    assert.deepEqual(bytes, fs.readFileSync(path.join(__dirname, '..', source)));
    assert.equal(manifest.files[source].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  }
  // No dependency tree/server can leak through this explicit allowlist.
  const html = fs.readFileSync(path.join(out, 'offline/index.html'), 'utf8');
  for (const [, url] of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    assert(!/^(?:https?:)?\/\//.test(url));
    assert(fs.existsSync(path.resolve(out, 'offline', url)));
  }
  const server = serve({ port: 0 });
  try {
    await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const file of files) assert.equal((await fetch(`${base}/${file}`)).status, 200);
    for (const file of ['server.js', 'node_modules/ws/index.js', 'node_modules/better-sqlite3/package.json']) {
      assert.equal((await fetch(`${base}/${file}`)).status, 404);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('Offline artifact: exact canonical sources, manifest and static serving OK');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
