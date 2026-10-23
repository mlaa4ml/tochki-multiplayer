// test/botpool.js — A10 (issue #15): ограниченный пул worker_threads для
// поиска бота. Проверяет: реальный поиск через botWorker.js, предел
// параллелизма, переполнение очереди (backpressure), таймаут зависшего
// потока, падение потока, отмену, close() без оставшихся потоков.
'use strict';

const assert = require('assert');
const Engine = require('../gameEngine.js');
const { createBotPool } = require('../botPool.js');

function snapshotAfterOneMove(){
  const m = Engine.createMatch({ sizeKey: 'medium' });
  const r = m.applyMove(1, 7, 5);
  assert.ok(r.ok, 'первый ход человека должен быть легальным');
  return { match: m, snapshot: m.getSnapshot() };
}

async function expectCode(p, code, label){
  try { await p; } catch (e){ assert.strictEqual(e.code, code, `${label}: ожидали ${code}, получили ${e.code} (${e.message})`); return; }
  assert.fail(`${label}: ожидали отказ ${code}, а запрос выполнился`);
}

(async () => {
  // 1. Реальный поиск: легальный ход, applyMove на стороне владельца партии.
  {
    const pool = createBotPool({ size: 2, maxQueue: 8, timeoutMs: 20000 });
    const { match, snapshot } = snapshotAfterOneMove();
    const res = await pool.search({ snapshot, difficulty: 'normal', weights: null,
      searchOpts: { nodeLimit: 300 }, gameId: 1, revision: 1 }, { key: 'r1' });
    assert.ok(res.move && Number.isInteger(res.move.x) && Number.isInteger(res.move.y), 'поиск вернул ход');
    assert.ok(res.trace && typeof res.trace === 'object', 'есть диагностика trace');
    const ap = match.applyMove(snapshot.current, res.move.x, res.move.y);
    assert.ok(ap.ok, 'ход из пула легален для авторитетного матча: ' + ap.reason);
    console.log('OK: поиск в worker вернул легальный ход и trace');

    // 2. Предел параллелизма: 6 запросов, не больше size потоков.
    const ps = [];
    for (let i = 0; i < 6; i++) ps.push(pool.search({ snapshot, difficulty: 'normal', searchOpts: { nodeLimit: 200 } }, { key: 'p' + i }));
    const all = await Promise.all(ps);
    assert.ok(all.every((r) => r.move), 'все запросы получили ход');
    const st = pool.stats();
    assert.ok(st.maxBusySeen <= 2 && st.spawned <= 2, `потоков не больше size: ${JSON.stringify(st)}`);
    console.log(`OK: предел параллелизма соблюдён (spawned=${st.spawned}, maxBusy=${st.maxBusySeen}, maxQueue=${st.maxQueueSeen})`);
    await pool.close();
    assert.strictEqual(pool.stats().workers, 0, 'после close() потоков нет');
    await expectCode(pool.search({ snapshot }), 'pool-closed', 'после close');
    console.log('OK: close() завершил все потоки, новые запросы отклоняются');
  }

  const hang = "require('worker_threads').parentPort.on('message', () => { for(;;){} });";
  const crash = "require('worker_threads').parentPort.on('message', () => process.exit(3));";

  // 3. Очередь под нагрузкой: size=1, maxQueue=2 -> 4-й запрос queue-full.
  {
    const pool = createBotPool({ size: 1, maxQueue: 2, timeoutMs: 300, workerPath: hang, workerOptions: { eval: true } });
    const a = pool.search({}, { key: 'a' });
    const b = pool.search({}, { key: 'b' });
    const c = pool.search({}, { key: 'c' });
    await expectCode(pool.search({}, { key: 'd' }), 'queue-full', 'переполнение');
    console.log('OK: переполнение очереди даёт queue-full (backpressure)');
    // 4. Отмена из очереди.
    assert.strictEqual(pool.cancel('c'), 1, 'отменён один запрос из очереди');
    await expectCode(c, 'cancelled', 'отмена из очереди');
    // 5. Таймаут зависшего потока: поток пересоздаётся и следующий тоже по таймауту.
    await expectCode(a, 'timeout', 'зависший поток');
    await expectCode(b, 'timeout', 'второй зависший');
    const st = pool.stats();
    assert.strictEqual(st.timeouts, 2, 'учтено 2 таймаута');
    assert.ok(st.spawned >= 2, 'после таймаута поток пересоздан');
    console.log('OK: зависший поток прерван по таймауту и заменён новым');
    // 6. Отмена идущего расчёта — terminate.
    const e = pool.search({}, { key: 'e' });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(pool.isBusyFor('e'));
    assert.strictEqual(pool.cancel('e'), 1);
    await expectCode(e, 'cancelled', 'отмена идущего');
    assert.ok(!pool.isBusyFor('e'));
    console.log('OK: отмена идущего поиска прерывает поток');
    const pending = pool.search({}, { key: 'f' });
    await pool.close();
    await expectCode(pending, 'pool-closed', 'close с идущим поиском');
    assert.strictEqual(pool.stats().workers, 0);
    console.log('OK: close() во время зависшего поиска не оставляет потоков');
  }

  // 7. Падение потока: отклоняется только текущий запрос, пул живёт дальше.
  {
    const pool = createBotPool({ size: 1, maxQueue: 4, timeoutMs: 2000, workerPath: crash, workerOptions: { eval: true } });
    await expectCode(pool.search({}, { key: 'x' }), 'worker-crashed', 'падение');
    await expectCode(pool.search({}, { key: 'y' }), 'worker-crashed', 'второе падение');
    assert.strictEqual(pool.stats().crashes, 2);
    await pool.close();
    assert.strictEqual(pool.stats().workers, 0);
    console.log('OK: падение потока отклоняет только его запрос, пул продолжает работу');
  }

  console.log('\nВСЕ ПРОВЕРКИ ПУЛА ПОИСКА БОТА (A10) ПРОЙДЕНЫ');
  // Процесс должен завершиться сам — без оставшихся потоков/таймеров.
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
