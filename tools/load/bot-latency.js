#!/usr/bin/env node
// tools/load/bot-latency.js — A10 (issue #15): повторяемый нагрузочный
// сценарий "несколько комнат с ботом normal/strong + отдельная человеческая
// комната". Измеряет задержки, которые видит НЕ-ботовая сторона сервера:
//   - WS RTT: 'list-rooms' -> 'room-list' от клиента человеческой комнаты;
//   - HTTP RTT: GET / (client.html);
//   - event-loop lag процесса сервера (perf_hooks.monitorEventLoopDelay);
//   - CPU (process.cpuUsage, включая потоки worker), RSS/heap;
//   - очередь/занятость пула и время ответа бота.
// Режимы: --mode sync (BOT_POOL_SIZE=0, прежний синхронный botMove — "до")
//         --mode pool (worker_threads, "после"), --mode both (по умолчанию).
//
// Пример: node tools/load/bot-latency.js --rooms 4 --strong 2 --seconds 20 --pool-size 2
//         [--out tools/load/reports/a10.json]
// Границы измерения: клиенты работают в том же процессе, что и сервер, —
// это осознанно (задержка клиента включает блокировку общего event loop),
// но абсолютные числа зависят от машины; сравнивать только режимы между
// собой на одной машине. Сеть — loopback, без реальной сетевой задержки.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const WebSocket = require('ws');
const { createServer } = require('../../server.js');

function arg(name, def){
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const ROOMS = Number(arg('rooms', 4));
const STRONG = Math.min(ROOMS, Number(arg('strong', 2)));
const SECONDS = Number(arg('seconds', 20));
const POOL_SIZE = Number(arg('pool-size', 2));
const MODE = arg('mode', 'both');
const OUT = arg('out', '');
const PROBE_MS = Number(arg('probe-ms', 100));

// Бюджет, зафиксированный заранее (docs/A10_LOAD.md). Это цель для
// человеческой комнаты при нагрузке, а не гарантия real-time.
const BUDGET = { wsP95Ms: 100, httpP95Ms: 150, loopLagP99Ms: 100 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pct(a, p){ if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1); }
function summary(a){ return { n: a.length, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99), max: a.length ? +Math.max(...a).toFixed(1) : null }; }

function connect(url){
  const ws = new WebSocket(url);
  ws.waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    ws.waiters = ws.waiters.filter((w) => { if (w.pred(m)){ w.resolve(m); return false; } return true; });
  });
  ws.next = (pred) => new Promise((resolve) => ws.waiters.push({ pred, resolve }));
  ws.on('error', () => {});
  return new Promise((r) => ws.on('open', () => r(ws)));
}

// Кандидаты хода для "человека" в комнате с ботом: сначала дебютная зона,
// потом любые пустые клетки; нелегальный ход сервер отклонит — берём следующий.
function candidates(snap){
  const z = snap.openingZone, out = [];
  const inZone = (x, y) => z && x >= z.minX && x <= z.maxX && y >= z.minY && y <= z.maxY;
  for (let y = 0; y < snap.rows; y++) for (let x = 0; x < snap.cols; x++)
    if (!snap.stone[y][x] && !(snap.dead && snap.dead[y][x])) out.push({ x, y, z: inZone(x, y) ? 0 : 1, r: Math.random() });
  return out.sort((a, b) => a.z - b.z || a.r - b.r);
}

async function botRoomLoop(url, difficulty, stopAt, botTimes){
  const c = await connect(url);
  c.send(JSON.stringify({ type: 'create-room', options: { sizeKey: 'medium', vsBot: true, botDifficulty: difficulty } }));
  let snap = (await c.next((m) => m.type === 'room-created')).snapshot;
  while (performance.now() < stopAt){
    if (snap.gameOver){
      c.send(JSON.stringify({ type: 'rematch' }));
      snap = (await c.next((m) => m.type === 'rematch-started')).snapshot;
      continue;
    }
    let moved = false;
    for (const mv of candidates(snap).slice(0, 40)){
      c.send(JSON.stringify({ type: 'move', x: mv.x, y: mv.y }));
      const r = await c.next((m) => m.type === 'error' || (m.type === 'state' && m.lastMove && m.lastMove.player === 1));
      if (r.type === 'error') continue;
      moved = true; snap = r.snapshot; break;
    }
    if (!moved){ c.send(JSON.stringify({ type: 'end' })); snap = (await c.next((m) => m.type === 'state' && m.snapshot.gameOver)).snapshot; continue; }
    while (!snap.gameOver && snap.current === 2){
      const t0 = performance.now();
      const b = await c.next((m) => m.type === 'state' && (m.lastMove && m.lastMove.player === 2 || m.snapshot.gameOver));
      botTimes.push(performance.now() - t0);
      snap = b.snapshot;
    }
  }
  c.terminate();
}

function httpGet(port){
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
  });
}

async function runMode(mode){
  const server = createServer({ dbPath: ':memory:', botPool: { size: mode === 'pool' ? POOL_SIZE : 0 } });
  await new Promise((r) => server.httpServer.listen(0, r));
  const port = server.httpServer.address().port;
  const url = `ws://127.0.0.1:${port}`;

  // Отдельная человеческая комната (два клиента), её клиент зондирует WS.
  const h1 = await connect(url);
  h1.send(JSON.stringify({ type: 'create-room', options: { sizeKey: 'medium' } }));
  const code = (await h1.next((m) => m.type === 'room-created')).code;
  const h2 = await connect(url);
  h2.send(JSON.stringify({ type: 'join-room', code }));
  await h2.next((m) => m.type === 'room-joined');

  const loop = monitorEventLoopDelay({ resolution: 10 });
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const stopAt = t0 + SECONDS * 1000;
  loop.enable();
  const botTimes = [], ws = [], httpT = [];
  let maxQueued = 0, maxBusy = 0, rssMax = 0, heapMax = 0;

  const rooms = [];
  for (let i = 0; i < ROOMS; i++) rooms.push(botRoomLoop(url, i < STRONG ? 'strong' : 'normal', stopAt, botTimes));

  const probes = (async () => {
    while (performance.now() < stopAt){
      let s = performance.now();
      h1.send(JSON.stringify({ type: 'list-rooms' }));
      await h1.next((m) => m.type === 'room-list');
      ws.push(performance.now() - s);
      s = performance.now();
      await httpGet(port);
      httpT.push(performance.now() - s);
      if (server.botPool){ const st = server.botPool.stats(); maxQueued = Math.max(maxQueued, st.queued); maxBusy = Math.max(maxBusy, st.busy); }
      const mu = process.memoryUsage(); rssMax = Math.max(rssMax, mu.rss); heapMax = Math.max(heapMax, mu.heapUsed);
      await sleep(PROBE_MS);
    }
  })();

  await Promise.all([probes, ...rooms]);
  loop.disable();
  const wall = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const res = {
    mode, rooms: ROOMS, strong: STRONG, normal: ROOMS - STRONG, poolSize: mode === 'pool' ? POOL_SIZE : 0, seconds: +(wall / 1000).toFixed(1),
    ws: summary(ws), http: summary(httpT),
    loopLagMs: { p50: +(loop.percentile(50) / 1e6).toFixed(1), p95: +(loop.percentile(95) / 1e6).toFixed(1), p99: +(loop.percentile(99) / 1e6).toFixed(1), max: +(loop.max / 1e6).toFixed(1) },
    botReplyMs: summary(botTimes),
    cpuPercent: +(((cpu.user + cpu.system) / 1000) / wall * 100).toFixed(0),
    rssMaxMB: +(rssMax / 1048576).toFixed(0), heapMaxMB: +(heapMax / 1048576).toFixed(0),
    pool: server.botPool ? Object.assign(server.botPool.stats(), { maxQueuedProbe: maxQueued, maxBusyProbe: maxBusy }) : null
  };
  res.withinBudget = res.ws.p95 <= BUDGET.wsP95Ms && res.http.p95 <= BUDGET.httpP95Ms && res.loopLagMs.p99 <= BUDGET.loopLagP99Ms;
  h1.terminate(); h2.terminate();
  await server.close();
  return res;
}

(async () => {
  const modes = MODE === 'both' ? ['sync', 'pool'] : [MODE];
  const results = [];
  for (const m of modes){
    const r = await runMode(m);
    results.push(r);
    console.log(`[${m}] ws p50/p95=${r.ws.p50}/${r.ws.p95} ms  http p50/p95=${r.http.p50}/${r.http.p95} ms  loopLag p50/p99/max=${r.loopLagMs.p50}/${r.loopLagMs.p99}/${r.loopLagMs.max} ms  bot p50/p95=${r.botReplyMs.p50}/${r.botReplyMs.p95} ms (n=${r.botReplyMs.n})  cpu=${r.cpuPercent}%  rss=${r.rssMaxMB}MB  queueMax=${r.pool ? r.pool.maxQueueSeen : '-'}  budget=${r.withinBudget ? 'OK' : 'EXCEEDED'}`);
  }
  const report = { date: new Date().toISOString(), node: process.version, budget: BUDGET, args: { ROOMS, STRONG, SECONDS, POOL_SIZE, PROBE_MS }, results };
  if (OUT){ fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n'); console.log('report:', OUT); }
  setTimeout(() => process.exit(0), 200).unref();
})().catch((e) => { console.error(e); process.exit(1); });
