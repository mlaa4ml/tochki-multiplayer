#!/usr/bin/env node
// tools/bench/profile-search.js
//
// B04 (issue #27): профиль поиска бота на фиксированном корпусе позиций.
// Для каждой позиции корпуса (prefix + rules) выполняется Engine.searchMove
// с одинаковым детерминированным лимитом узлов; фиксируются ход, число
// узлов, completedDepth, время (p50/p95) и прирост памяти.
//
// Запуск:
//   node tools/bench/profile-search.js [--corpus tools/bench/corpus/strategic.v1.json]
//        [--difficulty normal] [--nodes 4000] [--repeat 3] [--limit 0] [--out report.json]
//
// Ход и число узлов при одинаковом лимите должны совпадать до и после любой
// оптимизации (детерминизм) — поле "signature" позволяет сравнить отчёты.
'use strict';

const fs = require('fs');
const path = require('path');
const Engine = require('../../gameEngine.js');

function parseArgs(argv) {
  const a = { corpus: 'tools/bench/corpus/strategic.v1.json', difficulty: 'normal',
    nodes: 4000, repeat: 3, limit: 0, out: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (k in a) { a[k] = (typeof a[k] === 'number') ? Number(v) : v; i++; }
  }
  return a;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = arr.slice().sort((x, y) => x - y);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1));
  return s[idx];
}

function loadPositions(corpus, limit) {
  const out = [];
  const groups = corpus.positions || {};
  for (const key of Object.keys(groups)) {
    for (const p of groups[key]) out.push(p);
  }
  return limit > 0 ? out.slice(0, limit) : out;
}

function snapshotFor(pos) {
  const match = Engine.createMatch(Object.assign({}, pos.rules));
  for (const mv of pos.prefix || []) {
    const r = match.applyMove(mv.seat, mv.x, mv.y);
    if (!r.ok) throw new Error('invalid prefix move in ' + pos.id + ': ' + r.reason);
  }
  return match.getSnapshot();
}

function main() {
  const args = parseArgs(process.argv);
  const corpus = JSON.parse(fs.readFileSync(path.resolve(args.corpus), 'utf8'));
  const diff = Engine.DIFFICULTY[args.difficulty];
  if (!diff) throw new Error('unknown difficulty: ' + args.difficulty);
  const positions = loadPositions(corpus, args.limit);

  const results = [];
  const times = [];
  let totalNodes = 0;
  let maxHeapDelta = 0;
  for (const pos of positions) {
    const snap = snapshotFor(pos);
    if (snap.gameOver) continue;
    const state = { stone: snap.stone, dead: snap.dead, territory: snap.territory };
    let first = null;
    const posTimes = [];
    for (let r = 0; r < args.repeat; r++) {
      if (global.gc) global.gc();
      const heap0 = process.memoryUsage().heapUsed;
      const t0 = process.hrtime.bigint();
      const res = Engine.searchMove(state, snap.rows, snap.cols, snap.current, diff, Engine.BOT_WEIGHTS,
        Object.assign({}, snap, { nodeLimit: args.nodes }));
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const heapDelta = process.memoryUsage().heapUsed - heap0;
      maxHeapDelta = Math.max(maxHeapDelta, heapDelta);
      posTimes.push(ms);
      const sig = { move: res.move ? [res.move.x, res.move.y] : null, nodes: res.trace.nodes,
        depth: res.trace.completedDepth, stop: res.trace.stopReason };
      if (!first) first = sig;
      else if (JSON.stringify(first) !== JSON.stringify(sig)) {
        throw new Error('non-deterministic search on ' + pos.id + ': ' + JSON.stringify(first) + ' vs ' + JSON.stringify(sig));
      }
    }
    times.push(...posTimes);
    totalNodes += first.nodes;
    results.push(Object.assign({ id: pos.id, msP50: percentile(posTimes, 50) }, first));
  }

  const report = {
    tool: 'profile-search', engineVersion: Engine.ENGINE_VERSION, botVersion: Engine.BOT_VERSION,
    corpus: args.corpus, difficulty: args.difficulty, nodeLimit: args.nodes, repeat: args.repeat,
    node: process.version, positions: results.length, totalNodes,
    msP50: percentile(times, 50), msP95: percentile(times, 95),
    maxHeapDeltaMB: +(maxHeapDelta / 1048576).toFixed(2),
    signature: results.map(r => r.id + ':' + JSON.stringify(r.move) + ':' + r.nodes + ':' + r.depth).join('|'),
    results
  };
  const json = JSON.stringify(report, null, 1);
  if (args.out) fs.writeFileSync(args.out, json + '\n');
  const { results: _r, signature: _s, ...summary } = report;
  console.log(JSON.stringify(summary, null, 1));
}

if (require.main === module) main();
module.exports = { percentile, loadPositions, snapshotFor };
