#!/usr/bin/env node
'use strict';
// A09 (issue #14): ablation-отчёт признака связи области с краем (edgeEscape)
// и эвристики liberties. Каждый признак включается/выключается ОТДЕЛЬНО.
// Варианты: base (BOT_WEIGHTS как есть, edgeEscape выкл.), noLiberty
// (liberty=0), edge2 / edge5 (edgeEscape включён), edge5-noLiberty.
// На тактическом корпусе (capture-in-1 из corpus/openings.v1.json) меряет:
// промахи эталонных ходов (тактические регрессии), время хода p50/p95, узлы,
// а также цену вычисления evaluateStatic с признаком и без (мкс p50/p95).
// Запуск: node tools/bench/a09-ablation.js [--node-limit 300] [--difficulty normal] [--out file.json]
const fs = require('fs');
const path = require('path');
const Engine = require('../../gameEngine.js');
const Runner = require('./runner.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const nodeLimit = parseInt(opt('--node-limit', '300'), 10);
const diffName = opt('--difficulty', 'normal');
const out = opt('--out', null);

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'corpus', 'openings.v1.json'), 'utf8'));
const tactics = [].concat(...Object.values(corpus.tactics || {}));

const B = Engine.BOT_WEIGHTS;
const VARIANTS = {
  base: Object.assign({}, B),
  noLiberty: Object.assign({}, B, { liberty: 0 }),
  edge2: Object.assign({}, B, { edgeEscape: 2 }),
  edge5: Object.assign({}, B, { edgeEscape: 5 }),
    'edge5-noLiberty': Object.assign({}, B, { liberty: 0, edgeEscape: 5 }),
  // A09 шаги 2-5: каждый признак отдельно (по одному поверх base).
  closeCost10: Object.assign({}, B, { closeCost: 10 }),
  captureRace30: Object.assign({}, B, { captureRace: 30 }),
  phase1: Object.assign({}, B, { phase: 1 }),
  endgameScore1: Object.assign({}, B, { endgameScore: 1 })
};

function q(arr, p){
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))].toFixed(3);
}

const diff = Engine.DIFFICULTY[diffName];
const report = { nodeLimit, difficulty: diffName, positions: tactics.length, variants: {}, evalCost: {} };
const snaps = [];
for (const [name, weights] of Object.entries(VARIANTS)){
  let misses = 0; const ms = [], nodes = [], missed = [];
  for (const t of tactics){
    const m = Engine.createMatch(t.rules);
    Runner.applyPrefix(m, t.prefix, () => {});
    if (name === 'base') snaps.push(m.getSnapshot());
    const p = Runner.makeSearchPlayer(Engine, { difficulty: diff, nodeLimit, weights });
    const t0 = process.hrtime.bigint();
    const r = p(m.getSnapshot()) || {};
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
    const tr = r.trace || {};
    if (Number.isFinite(tr.nodes)) nodes.push(tr.nodes);
    const mv = r.move;
    if (!mv || !t.expected.some(e => e.x === mv.x && e.y === mv.y)){ misses++; missed.push(t.id); }
  }
  report.variants[name] = { weights, missRate: +(misses / Math.max(1, tactics.length)).toFixed(3), misses, missed,
    msP50: q(ms, 0.5), msP95: q(ms, 0.95), nodesP50: q(nodes, 0.5), nodesP95: q(nodes, 0.95) };
  const v = report.variants[name];
  console.log(`${name.padEnd(16)} miss=${v.misses}/${tactics.length} ms p50/p95=${v.msP50}/${v.msP95} nodes p50/p95=${v.nodesP50}/${v.nodesP95}`);
}

// Цена вычисления: evaluateStatic на позициях корпуса, без и с признаком.
function stateOf(s){
  const st = s.state || s.board || s;
  return st && st.stone ? st : null;
}
for (const name of ['base', 'edge5']){
  const w = VARIANTS[name]; const us = [];
  for (const s of snaps){
    const st = stateOf(s); if (!st) continue;
    const rows = st.stone.length, cols = st.stone[0].length;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 50; i++) Engine.evaluateStatic(st, rows, cols, 2, w);
    us.push(Number(process.hrtime.bigint() - t0) / 1e3 / 50);
  }
  report.evalCost[name] = { samples: us.length, usP50: q(us, 0.5), usP95: q(us, 0.95) };
  console.log(`evaluateStatic ${name.padEnd(6)} us p50/p95=${report.evalCost[name].usP50}/${report.evalCost[name].usP95} (n=${us.length})`);
}
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
