// test/bot-races.js — A10 (issue #15): гонки серверного поиска бота в пуле
// worker_threads. Поиск искусственно замедлен (worker с задержкой перед
// настоящим handleBotRequest из botWorker.js), чтобы undo/end/rematch
// гарантированно попадали в окно "поиск идёт". Проверяется:
//   - нет хода бота после undo, пришедшего во время поиска;
//   - нет хода бота после 'end' (gameOver);
//   - после реванша бот ходит ровно один раз на ход человека;
//   - зависший worker (таймаут) не ломает партию: повтор + запасной ход;
//   - server.close() не оставляет потоков пула.
'use strict';

const assert = require('assert');
const path = require('path');
const WebSocket = require('ws');
const { createServer } = require('../server.js');

const DELAY_MS = 600;
const slowWorker = `
const { parentPort } = require('worker_threads');
const { handleBotRequest } = require(${JSON.stringify(path.resolve(__dirname, '../botWorker.js'))});
const E = require(${JSON.stringify(path.resolve(__dirname, '../gameEngine.js'))});
parentPort.on('message', (m) => setTimeout(() => parentPort.postMessage(handleBotRequest(E, Object.assign({}, m, { searchOpts: { nodeLimit: 300 } }))), ${DELAY_MS}));
`;
const hangWorker = "require('worker_threads').parentPort.on('message', () => { for(;;){} });";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(url){
  const ws = new WebSocket(url);
  ws.msgs = [];
  ws.waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    ws.msgs.push(m);
    ws.waiters = ws.waiters.filter((w) => { if (w.pred(m)){ w.resolve(m); return false; } return true; });
  });
  ws.next = (pred, timeoutMs = 10000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting message')), timeoutMs);
    ws.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
  ws.botMoves = () => ws.msgs.filter((m) => m.type === 'state' && m.lastMove && m.lastMove.player === 2);
  return new Promise((r) => ws.on('open', () => r(ws)));
}

async function botRoom(url, difficulty){
  const c = await client(url);
  c.send(JSON.stringify({ type: 'create-room', options: { sizeKey: 'small', vsBot: true, botDifficulty: difficulty || 'strong' } }));
  const created = await c.next((m) => m.type === 'room-created');
  const z = created.snapshot.openingZone;
  c.center = { x: Math.floor((z.minX + z.maxX) / 2), y: Math.floor((z.minY + z.maxY) / 2) };
  return c;
}

async function humanMove(c, x, y){
  c.send(JSON.stringify({ type: 'move', x, y }));
  const m = await c.next((m) => (m.type === 'state' && m.lastMove && m.lastMove.player === 1) || m.type === 'error');
  assert.strictEqual(m.type, 'state', 'ход человека принят: ' + JSON.stringify(m));
  return m;
}

async function main(){
  const server = createServer({ dbPath: ':memory:', botPool: { size: 2, maxQueue: 8, timeoutMs: 10000,
    workerPath: slowWorker, workerOptions: { eval: true } } });
  await new Promise((r) => server.httpServer.listen(0, r));
  const url = `ws://localhost:${server.httpServer.address().port}`;

  // 1) undo во время поиска: ответ поиска отброшен, хода бота нет.
  {
    const c = await botRoom(url);
    await humanMove(c, c.center.x, c.center.y);
    await sleep(100); // поиск уже идёт в worker
    assert.ok(server.botPool.stats().busy >= 1, 'поиск действительно идёт в worker');
    c.send(JSON.stringify({ type: 'request-undo' }));
    const u = await c.next((m) => (m.type === 'state' && m.note === 'undo-applied') || m.type === 'error');
    assert.strictEqual(u.type, 'state', 'undo применён: ' + JSON.stringify(u));
    assert.strictEqual(u.snapshot.current, 1);
    await sleep(DELAY_MS + 400);
    assert.strictEqual(c.botMoves().length, 0, 'после undo бот не сходил устаревшим ответом');
    // Следующий ход человека — ровно один ответ бота.
    await humanMove(c, c.center.x, c.center.y);
    const b = await c.next((m) => m.type === 'state' && m.lastMove && m.lastMove.player === 2);
    assert.strictEqual(b.snapshot.current, 1, 'после хода бота ход у человека');
    await sleep(DELAY_MS + 300);
    assert.strictEqual(c.botMoves().length, 1, 'ровно один ход бота, без двойного');
    console.log('OK: undo во время поиска — устаревший ответ отброшен, затем ровно один ход бота');
    c.terminate();
  }

  // 2) end во время поиска: после gameOver хода бота нет; реванш — один ответ на ход.
  {
    const c = await botRoom(url);
    await humanMove(c, c.center.x, c.center.y);
    await sleep(100);
    c.send(JSON.stringify({ type: 'end' }));
    const e = await c.next((m) => m.type === 'state' && m.snapshot.gameOver);
    assert.ok(e.snapshot.gameOver);
    await sleep(DELAY_MS + 400);
    assert.strictEqual(c.botMoves().length, 0, 'после end бот не ходит');
    console.log('OK: end во время поиска — хода после gameOver нет');

    c.send(JSON.stringify({ type: 'rematch' }));
    const r = await c.next((m) => m.type === 'rematch-started');
    assert.strictEqual(r.snapshot.stonesPlacedTotal, 0, 'новая партия пустая');
    await humanMove(c, c.center.x, c.center.y);
    const b = await c.next((m) => m.type === 'state' && m.lastMove && m.lastMove.player === 2);
    assert.strictEqual(b.snapshot.stonesPlacedTotal, 2, 'в новой партии ровно ход человека и ход бота');
    await sleep(DELAY_MS + 300);
    assert.strictEqual(c.botMoves().length, 1, 'после реванша ровно один ход бота');
    console.log('OK: реванш — ответ бота применяется к новой партии ровно один раз');
    c.terminate();
  }

  // 3) несколько комнат одновременно: все получают ход, потоков не больше size.
  {
    const cs = await Promise.all([1, 2, 3, 4].map(() => botRoom(url, 'normal')));
    await Promise.all(cs.map((c) => humanMove(c, c.center.x, c.center.y)));
    await Promise.all(cs.map((c) => c.next((m) => m.type === 'state' && m.lastMove && m.lastMove.player === 2)));
    const st = server.botPool.stats();
    assert.ok(st.workers <= 2 && st.maxBusySeen <= 2, 'не больше size потоков: ' + JSON.stringify(st));
    console.log(`OK: 4 комнаты одновременно — все получили ход (maxBusy=${st.maxBusySeen}, maxQueue=${st.maxQueueSeen})`);
    cs.forEach((c) => c.terminate());
  }

  await server.close();
  assert.strictEqual(server.botPool.stats().workers, 0, 'после close() потоков пула нет');
  console.log('OK: server.close() завершил потоки пула');

  // 4) зависший worker: таймаут -> повторы -> запасной синхронный ход.
  {
    const s2 = createServer({ dbPath: ':memory:', botPool: { size: 1, maxQueue: 4, timeoutMs: 300,
      workerPath: hangWorker, workerOptions: { eval: true } } });
    await new Promise((r) => s2.httpServer.listen(0, r));
    const c = await botRoom(`ws://localhost:${s2.httpServer.address().port}`);
    const origErr = console.error; console.error = () => {};
    try {
      await humanMove(c, c.center.x, c.center.y);
      const b = await c.next((m) => m.type === 'state' && m.lastMove && m.lastMove.player === 2, 8000);
      assert.strictEqual(b.snapshot.current, 1, 'партия продолжается, ход у человека');
    } finally { console.error = origErr; }
    assert.ok(s2.botPool.stats().timeouts >= 3, 'были таймауты зависшего worker');
    console.log(`OK: зависший worker — таймауты (${s2.botPool.stats().timeouts}), партия не повреждена, бот сходил запасным поиском`);
    c.terminate();
    await s2.close();
    assert.strictEqual(s2.botPool.stats().workers, 0);
  }

  console.log('\nВСЕ ПРОВЕРКИ ГОНОК ПОИСКА БОТА (A10) ПРОЙДЕНЫ');
}

main().then(() => {
  // Процесс должен завершиться сам; если что-то держит event loop — это ошибка.
  setTimeout(() => { console.error('FAIL: процесс не завершился (остались потоки/таймеры)'); process.exit(1); }, 5000).unref();
}).catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
