#!/usr/bin/env node
'use strict';
// A08 (issue #13): ablation-отчёт обрезки кандидатов.
// Варианты: base (как до A08: tactical=false, strategic=false), tactical,
// strategic, both (по умолчанию в A08), both+extScan.
// На тактическом корпусе (capture-in-1 из corpus/openings.v1.json) меряет:
// долю пропущенных эталонных ходов, узлы, время хода p50/p95, genMs p50/p95.
// Запуск: node tools/bench/a08-ablation.js [--node-limit 300] [--difficulty normal] [--out file.json]
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

const VARIANTS = {
  base: { tactical: false, strategic: false },
  tactical: { tactical: true, strategic: false },
  strategic: { tactical: false, strategic: true },
  both: {},
  'both+extScan': { tacticalExtScan: true }
};

function q(arr, p){
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))].toFixed(2);
}

const report = { nodeLimit, difficulty: diffName, positions: tactics.length, variants: {} };
for (const [name, over] of Object.entries(VARIANTS)){
  const diff = Object.assign({}, Engine.DIFFICULTY[diffName], over);
  let misses = 0; const ms = [], nodes = [], gen = [], missed = [];
  for (const t of tactics){
    const m = Engine.createMatch(t.rules);
    Runner.applyPrefix(m, t.prefix, () => {});
    const p = Runner.makeSearchPlayer(Engine, { difficulty: diff, nodeLimit, weights: Engine.BOT_WEIGHTS });
    const t0 = process.hrtime.bigint();
    const r = p(m.getSnapshot()) || {};
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
    const tr = r.trace || {};
    if (Number.isFinite(tr.nodes)) nodes.push(tr.nodes);
    if (Number.isFinite(tr.genMs)) gen.push(tr.genMs);
    const mv = r.move;
    if (!mv || !t.expected.some(e => e.x === mv.x && e.y === mv.y)){ misses++; missed.push(t.id); }
  }
  report.variants[name] = { missRate: +(misses / Math.max(1, tactics.length)).toFixed(3), misses, missed,
    msP50: q(ms, 0.5), msP95: q(ms, 0.95), nodesP50: q(nodes, 0.5), nodesP95: q(nodes, 0.95),
    genMsP50: q(gen, 0.5), genMsP95: q(gen, 0.95) };
  const v = report.variants[name];
  console.log(`${name.padEnd(13)} miss=${v.misses}/${tactics.length} ms p50/p95=${v.msP50}/${v.msP95} nodes p50/p95=${v.nodesP50}/${v.nodesP95} genMs p50/p95=${v.genMsP50}/${v.genMsP95}`);
}
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
