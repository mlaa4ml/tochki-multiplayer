'use strict';
// Service-worker lifecycle and cache isolation without browser dependencies.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { build } = require('../tools/build-offline');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tochki-pwa-'));
const storage = new Map();
let online = true;
const caches = {
  async open(name){
    if (!storage.has(name)) storage.set(name, new Map());
    const entries = storage.get(name);
    return {
      async addAll(requests){
        if (!online) throw new Error('offline');
        for (const r of requests) entries.set(r.url, fs.readFileSync(path.join(out, new URL(r.url).pathname.split('/').pop()), 'utf8'));
      },
      async match(req){ return entries.get(typeof req === 'string' ? req : req.url); }
    };
  },
  async keys(){ return [...storage.keys()]; },
  async delete(name){ return storage.delete(name); }
};
function worker(){
  const handlers = {};
  let skipped = false, claimed = false;
  const self = {
    location: { href: 'https://example.test/game/sw.js' },
    addEventListener(type, fn){ handlers[type] = fn; },
    skipWaiting(){ skipped = true; },
    clients: { async claim(){ claimed = true; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(out, 'sw.js'), 'utf8'),
    { self, caches, URL, Request, fetch: async () => { throw new Error('network unavailable'); } });
  return {
    async event(type, data = {}){
      let result;
      handlers[type]({ ...data, waitUntil(p){ result = p; }, respondWith(p){ result = p; } });
      return await result;
    },
    get skipped(){ return skipped; },
    get claimed(){ return claimed; }
  };
}
async function main(){
  const first = build({ out }).manifest.cacheVersion;
  assert.strictEqual(build({ out }).manifest.cacheVersion, first, 'deterministic build');
  storage.set('unrelated', new Map());
  storage.set('tochki-offline-/other/-old', new Map());
  const a = worker();
  await a.event('install');
  assert.ok(!a.skipped, 'updates wait for consent');
  await a.event('activate');
  assert.ok(a.claimed);
  online = false;
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'build-manifest.json')));
  for (const file of [...manifest.files.map(f => f.file), 'build-manifest.json']){
    const response = await a.event('fetch', { request: new Request('https://example.test/game/' + file) });
    assert.strictEqual(response, fs.readFileSync(path.join(out, file), 'utf8'), file + ' cached offline');
  }
  assert.strictEqual(await a.event('fetch', { request: new Request('https://example.test/game/?x=1') }),
    fs.readFileSync(path.join(out, 'index.html'), 'utf8'));
  await assert.rejects(a.event('fetch', { request: new Request('https://example.test/game/missing') }), /network unavailable/);
  console.log('ok - all application resources cached; offline navigation; network failure rejects');
  // Change a source in an isolated build fixture, never mutate repository sources.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tochki-pwa-src-'));
  try {
    for (const file of ['tools/build-offline.js', 'gameEngine.js', 'botWorker.js', 'offline/localSession.js', 'offline/index.html', 'offline/pwa.js', 'offline/sw.js']){
      fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', file), path.join(fixture, file));
    }
    fs.appendFileSync(path.join(fixture, 'offline/pwa.js'), '\n// new release\n');
    const second = require(path.join(fixture, 'tools/build-offline.js')).build({ out }).manifest.cacheVersion;
    assert.notStrictEqual(second, first);
    online = true;
    const b = worker();
    await b.event('install');
    assert.ok((await caches.keys()).some(k => k.endsWith(first)), 'old cache remains while waiting');
    await b.event('message', { data: 'SKIP_WAITING' });
    assert.ok(b.skipped);
    await b.event('activate');
    const keys = await caches.keys();
    assert.ok(!keys.some(k => k.endsWith(first)));
    assert.ok(keys.some(k => k.endsWith(second)));
    assert.ok(keys.includes('unrelated') && keys.includes('tochki-offline-/other/-old'));
    console.log('ok - new release changes version; activation removes only this scope’s old cache');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}
main().then(() => {
  fs.rmSync(out, { recursive: true, force: true });
  console.log('pwa: passed');
}, err => { console.error(err); fs.rmSync(out, { recursive: true, force: true }); process.exitCode = 1; });
