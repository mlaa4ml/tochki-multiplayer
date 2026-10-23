// test/build-offline.js — статическая сборка offline (B01, issue #24).
// Проверяет: сборка проходит; движок/Worker в артефакте побайтно совпадают
// с каноническими исходниками; нет server.js/ws/SQLite; все локальные
// ссылки index.html разрешаются внутри артефакта; нет внешних URL;
// партия бот–бот доводится до конца на СОБРАННЫХ файлах с настоящим
// Worker'ом (worker_threads, тот же botWorker.js из артефакта).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { build } = require('../tools/build-offline.js');

const ROOT = path.resolve(__dirname, '..');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tochki-offline-'));

async function main(){
  const { manifest } = build({ out: outDir });
  const files = fs.readdirSync(outDir).sort();
  assert.deepStrictEqual(files,
    ['botWorker.js', 'build-manifest.json', 'gameEngine.js', 'index.html', 'localSession.js'],
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
  for (const r of refs){
    assert.ok(!/^(?:[a-z]+:)?\/\//i.test(r), 'внешний URL: ' + r);
    assert.ok(!r.startsWith('..') && !r.startsWith('/'), 'ссылка вне артефакта: ' + r);
    assert.ok(fs.existsSync(path.join(outDir, r)), 'нет файла для ссылки: ' + r);
  }
  assert.ok(/TOCHKI_BOT_WORKER_URL\s*=\s*'botWorker\.js'/.test(html), 'URL Worker указывает на botWorker.js из артефакта');
  console.log('ok - ссылки index.html разрешаются внутри артефакта: ' + refs.join(', '));

  // Партия бот–бот до конца на собранных файлах с настоящим Worker'ом.
  const Engine = require(path.join(outDir, 'gameEngine.js'));
    // localSession.js загружаем как в браузере (глобальный self.TochkiEngine),
  // а не через require: CommonJS-ветка файла ссылается на ../gameEngine.js
  // (раскладка репозитория), а в браузере используется именно глобальная ветка.
  const vm = require('vm');
  const sandboxSelf = { TochkiEngine: Engine };
  vm.runInNewContext(fs.readFileSync(path.join(outDir, 'localSession.js'), 'utf8'),
    { self: sandboxSelf, setTimeout, clearTimeout, console }, { filename: 'dist/localSession.js' });
  assert.ok(sandboxSelf.TochkiLocalSession, 'localSession.js из артефакта регистрирует TochkiLocalSession');
  const { createLocalSession } = sandboxSelf.TochkiLocalSession;
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
  console.log('build-offline: все проверки пройдены');
}, err => {
  console.error(err);
  process.exit(1);
});
