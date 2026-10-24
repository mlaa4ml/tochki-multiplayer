// test/build-offline.js — статическая сборка offline (B01, issue #24) и
// PWA-вариант (B02, issue #25).
// Проверяет: сборка проходит; движок/Worker в артефакте побайтно совпадают
// с каноническими исходниками; нет server.js/ws/SQLite; все локальные
// ссылки index.html разрешаются внутри артефакта; нет внешних URL;
// партия бот–бот доводится до конца на СОБРАННЫХ файлах с настоящим
// Worker'ом (worker_threads, тот же botWorker.js из артефакта).
// PWA: sw.js собран из шаблона (версия + список ресурсов), версия меняется
// при изменении любого файла; в эмуляции Service Worker install кладёт все
// ресурсы в кеш, activate удаляет старые версии кеша, при отключённой сети
// (fetch падает) все ресурсы отдаются из кеша. Отказ Worker'а: явное
// состояние workerError без зависания.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { build } = require('../tools/build-offline.js');

const ROOT = path.resolve(__dirname, '..');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tochki-offline-'));
const outDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tochki-offline2-'));

// Минимальная эмуляция окружения Service Worker (Cache Storage + события).
function loadServiceWorker(code, preKeys){
  const base = 'https://example.test/app/';
  const abs = u => new URL(typeof u === 'string' ? u : u.url, base).href;
  const noSearch = u => { const x = new URL(abs(u)); x.search = ''; return x.href; };
  const store = new Map();
  for (const k of preKeys || []) store.set(k, new Map([[base + 'index.html', 'stale']]));
  const caches = {
    open: async name => {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name);
      return {
        addAll: async reqs => { for (const r of reqs){ assert.strictEqual(r.opts && r.opts.cache, 'reload'); m.set(noSearch(r), 'body:' + noSearch(r)); } },
        match: async (r, o) => m.get(o && o.ignoreSearch ? noSearch(r) : abs(r))
      };
    },
    keys: async () => [...store.keys()],
    delete: async name => store.delete(name)
  };
  const listeners = {};
  const flags = { skipped: false, claimed: false, network: true, netRequests: [] };
  const self = {
    location: { origin: 'https://example.test', href: base + 'sw.js' },
    addEventListener: (t, f) => { listeners[t] = f; },
    skipWaiting: () => { flags.skipped = true; return Promise.resolve(); },
    clients: { claim: () => { flags.claimed = true; return Promise.resolve(); } }
  };
  class Request { constructor(u, opts){ this.url = abs(u); this.opts = opts; } }
  const fetch = req => { flags.netRequests.push(abs(req)); return flags.network ? Promise.resolve('net:' + abs(req)) : Promise.reject(new TypeError('Failed to fetch (offline)')); };
  vm.runInNewContext(code, { self, caches, Request, URL, fetch, Promise, console }, { filename: 'dist/sw.js' });
  async function lifecycle(type){ let p; listeners[type]({ waitUntil(x){ p = x; } }); await p; }
  async function request(rel, mode){
    let p = null;
    listeners.fetch({ request: { method: 'GET', url: base + rel, mode: mode || 'no-cors' }, respondWith(x){ p = x; } });
    assert.ok(p, 'SW перехватил ' + rel);
    return p;
  }
  return { base, store, flags, lifecycle, request };
}

async function main(){
  const { manifest } = build({ out: outDir });
  const files = fs.readdirSync(outDir).sort();
  assert.deepStrictEqual(files,
    ['botWorker.js', 'build-manifest.json', 'gameEngine.js', 'index.html', 'localSession.js', 'manifest.webmanifest', 'replay.js', 'storage.js', 'sw.js'],
    'состав артефакта');
  console.log('ok - состав артефакта: ' + files.join(', '));

  // Канонический движок, а не копия.
  assert.strictEqual(sha(path.join(outDir, 'gameEngine.js')), sha(path.join(ROOT, 'gameEngine.js')));
  assert.strictEqual(sha(path.join(outDir, 'botWorker.js')), sha(path.join(ROOT, 'botWorker.js')));
  assert.strictEqual(sha(path.join(outDir, 'localSession.js')), sha(path.join(ROOT, 'offline/localSession.js')));
  const eng = manifest.files.find(f => f.file === 'gameEngine.js');
  assert.strictEqual(eng.source, 'gameEngine.js');
  assert.strictEqual(eng.sha256, sha(path.join(ROOT, 'gameEngine.js')));
  console.log('ok - движок/Worker/сессия совпадают с каноническими исходниками (sha256)');

  // Нет серверных частей.
  for (const f of files){
    const t = fs.readFileSync(path.join(outDir, f), 'utf8');
    assert.ok(!/require\(\s*['"](ws|better-sqlite3)['"]\s*\)/.test(t), f + ': ws/better-sqlite3');
    assert.ok(!/require\(\s*['"]\.\/(server|db|auth)(\.js)?['"]\s*\)/.test(t), f + ': серверный модуль');
  }
  console.log('ok - нет server.js, ws, better-sqlite3');

  // index.html: все src/href локальные и существуют в артефакте.
  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)].map(m => m[1]);
  assert.ok(refs.includes('gameEngine.js') && refs.includes('localSession.js'), 'index.html подключает движок и сессию');
  assert.ok(refs.includes('manifest.webmanifest'), 'index.html ссылается на manifest.webmanifest');
  for (const r of refs){
    assert.ok(!/^(?:[a-z]+:)?\/\//i.test(r), 'внешний URL: ' + r);
    assert.ok(!r.startsWith('..') && !r.startsWith('/'), 'ссылка вне артефакта: ' + r);
    assert.ok(fs.existsSync(path.join(outDir, r)), 'нет файла для ссылки: ' + r);
  }
  assert.ok(/TOCHKI_BOT_WORKER_URL\s*=\s*'botWorker\.js'/.test(html), 'URL Worker указывает на botWorker.js из артефакта');
  console.log('ok - ссылки index.html разрешаются внутри артефакта: ' + refs.join(', '));

  // --- PWA ---
  assert.ok(/serviceWorker\.register\('sw\.js'/.test(html), 'index.html регистрирует sw.js');
  assert.ok(/location\.protocol === 'file:'/.test(html) && /isSecureContext/.test(html), 'регистрация только в secure context, сообщение для file://');
  assert.ok(/controllerchange/.test(html) && /новая версия/.test(html), 'сообщение о новой версии');
  assert.ok(/Ошибка бота \(Worker\)/.test(html), 'UI показывает явное сообщение об отказе Worker');
  const wm = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.webmanifest'), 'utf8'));
  assert.strictEqual(wm.start_url, './index.html');
  assert.strictEqual(wm.scope, './');

  const swCode = fs.readFileSync(path.join(outDir, 'sw.js'), 'utf8');
  assert.ok(!/'__CACHE_VERSION__'|=\s*__ASSETS__/.test(swCode), 'плейсхолдеры подставлены');
  assert.ok(/^[0-9a-f]{16}$/.test(manifest.cacheVersion), 'cacheVersion: ' + manifest.cacheVersion);
  assert.ok(swCode.includes('const CACHE_VERSION = "' + manifest.cacheVersion + '"'), 'версия кеша в sw.js = cacheVersion манифеста');
  const assets = JSON.parse(swCode.match(/const ASSETS = (\[.*\]);/)[1]);
  assert.deepStrictEqual(assets.slice().sort(),
    ['botWorker.js', 'gameEngine.js', 'index.html', 'localSession.js', 'manifest.webmanifest'], 'кешируются все ресурсы игры');
  for (const a of assets) assert.ok(fs.existsSync(path.join(outDir, a)), 'нет ресурса ' + a);
  console.log('ok - sw.js: кеш tochki-offline-' + manifest.cacheVersion + ', ресурсы: ' + assets.join(', '));

  // Повторная сборка тех же исходников — та же версия; правка движка — новая.
  const again = build({ out: outDir2 });
  assert.strictEqual(again.manifest.cacheVersion, manifest.cacheVersion, 'сборка детерминирована');
  const changed = build({ out: outDir2, overrides: { 'gameEngine.js': Buffer.concat([fs.readFileSync(path.join(ROOT, 'gameEngine.js')), Buffer.from('\n// v-next\n')]) } });
  assert.notStrictEqual(changed.manifest.cacheVersion, manifest.cacheVersion, 'новая версия файла -> новая версия кеша');
  const swNext = fs.readFileSync(path.join(outDir2, 'sw.js'), 'utf8');
  assert.notStrictEqual(swNext, swCode, 'sw.js меняется -> браузер установит новый SW');
  console.log('ok - версия кеша меняется при изменении файлов (' + manifest.cacheVersion + ' -> ' + changed.manifest.cacheVersion + ')');

  // Эмуляция: первая загрузка, затем сеть отключена.
  const oldKey = 'tochki-offline-0000000000000000';
  const sw = loadServiceWorker(swCode, [oldKey, 'other-app-cache']);
  await sw.lifecycle('install');
  assert.ok(sw.flags.skipped, 'install -> skipWaiting');
  await sw.lifecycle('activate');
  assert.ok(sw.flags.claimed, 'activate -> clients.claim');
  const keys = [...sw.store.keys()].sort();
  assert.deepStrictEqual(keys, ['other-app-cache', 'tochki-offline-' + manifest.cacheVersion].sort(), 'старый кеш удалён, чужой не тронут');
  sw.flags.network = false;
  for (const a of assets){
    assert.strictEqual(await sw.request(a), 'body:' + sw.base + a, 'из кеша без сети: ' + a);
  }
  assert.strictEqual(await sw.request('index.html?x=1', 'navigate'), 'body:' + sw.base + 'index.html');
  assert.strictEqual(await sw.request('', 'navigate'), 'body:' + sw.base + 'index.html', 'навигация на каталог без сети -> index.html');
  await assert.rejects(sw.request('missing.js'), /offline/, 'неизвестный ресурс без сети — ошибка, а не зависание');
  console.log('ok - SW: install/activate, старый кеш удалён, без сети все ресурсы из кеша');

  // Обновление: новый SW с новой версией удаляет предыдущий кеш.
  const sw2 = loadServiceWorker(swNext, ['tochki-offline-' + manifest.cacheVersion]);
  await sw2.lifecycle('install');
  await sw2.lifecycle('activate');
  assert.deepStrictEqual([...sw2.store.keys()], ['tochki-offline-' + changed.manifest.cacheVersion], 'после обновления остался только новый кеш');
  console.log('ok - SW: при выходе новой версии кеш заменяется');

  // Партия бот–бот до конца на собранных файлах с настоящим Worker'ом.
  const Engine = require(path.join(outDir, 'gameEngine.js'));
  // localSession.js загружаем как в браузере (глобальный self.TochkiEngine),
  // а не через require: CommonJS-ветка файла ссылается на ../gameEngine.js
  // (раскладка репозитория), а в браузере используется именно глобальная ветка.
  const sandboxSelf = { TochkiEngine: Engine };
  vm.runInNewContext(fs.readFileSync(path.join(outDir, 'localSession.js'), 'utf8'),
    { self: sandboxSelf, setTimeout, clearTimeout, console }, { filename: 'dist/localSession.js' });
  assert.ok(sandboxSelf.TochkiLocalSession, 'localSession.js из артефакта регистрирует TochkiLocalSession');
  const { createLocalSession } = sandboxSelf.TochkiLocalSession;

  // Отказ Worker: нет Worker в окружении (фабрика по умолчанию) и падение
  // Worker'а — явное workerError, поиск не висит.
  {
    const s = createLocalSession({ engine: Engine });
    let last = null;
    s.subscribe((snap, st) => { last = st; });
    s.newGame({ sizeKey: 'small', controllers: { 1: 'normal', 2: 'human' } });
    // Ход бота планируется через setTimeout(0) — ждём, пока он отработает.
    await new Promise(r => setTimeout(r, 20));
    assert.ok(last && /Worker/.test(last.workerError || ''), 'workerError при недоступном Worker: ' + (last && last.workerError));
    assert.strictEqual(last.searching, false, 'нет зависшего поиска');
    s.dispose();
    let fake = null;
    const s2 = createLocalSession({ engine: Engine, createWorker: () => (fake = { postMessage(){}, terminate(){}, onmessage: null, onerror: null }) });
    s2.subscribe((snap, st) => { last = st; });
    s2.newGame({ sizeKey: 'small', controllers: { 1: 'normal', 2: 'human' } });
    await new Promise(r => setTimeout(r, 10));
    assert.ok(fake && last.searching, 'запрос отправлен');
    fake.onerror({ message: 'boom', preventDefault(){} });
    assert.ok(/boom/.test(last.workerError) && last.searching === false, 'падение Worker -> workerError без зависания');
    s2.dispose();
    console.log('ok - отказ Worker: явное сообщение workerError, без зависания');
  }

  const workers = [];
  const createWorker = () => {
    const nw = new Worker(path.join(outDir, 'botWorker.js'));
    const w = {
      onmessage: null, onerror: null,
      postMessage(m){ nw.postMessage(m); },
      terminate(){ nw.terminate(); }
    };
    nw.on('message', data => w.onmessage && w.onmessage({ data }));
    nw.on('error', e => w.onerror && w.onerror(e));
    workers.push(nw);
    return w;
  };
  const s = createLocalSession({ engine: Engine, createWorker,
    searchOpts: { normal: { nodeLimit: 400 }, strong: { nodeLimit: 400 } } });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('партия не завершилась за 120 с')), 120000);
    s.subscribe((snap, st) => {
      if (st && st.workerError){ clearTimeout(timer); reject(new Error('workerError: ' + st.workerError)); }
      else if (snap && snap.gameOver){ clearTimeout(timer); resolve({ snap, st }); }
    });
    s.newGame({ sizeKey: 'small', targetFillPercent: 8, delayMs: 0,
      controllers: { 1: 'normal', 2: 'normal' } });
    s.start();
  });
  s.dispose();
  await Promise.all(workers.map(w => w.terminate().catch(() => {})));
  assert.ok(result.st.moveCount > 0, 'ходы сделаны');
  console.log('ok - бот–бот на собранном артефакте доведена до конца: ходов ' + result.st.moveCount +
    ', счёт ' + result.snap.scores[1] + ':' + result.snap.scores[2]);
}

main().then(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(outDir2, { recursive: true, force: true });
  console.log('build-offline: все проверки пройдены');
}, err => {
  console.error(err);
  process.exit(1);
});
