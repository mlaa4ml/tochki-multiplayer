#!/usr/bin/env node
// tools/mcts/experiment.js
//
// B06 (issue #29): парный эксперимент UCT-MCTS против замороженного baseline
// (Engine.searchMove + tools/bench/baseline/weights.v1.json) при равном
// бюджете узлов. Протокол зафиксирован в docs/B06_MCTS.md ДО запуска.
// Не импортирует БД, ничего не публикует.
//
//   node tools/mcts/experiment.js --gen-corpus tools/bench/corpus/openings.b06.json --seed 20240629
//   node tools/mcts/experiment.js --from 0 --count 4 --out tools/mcts/reports/part0.json
//   node tools/mcts/experiment.js --merge tools/mcts/reports/part0.json,... --out tools/mcts/reports/b06.json

const fs = require('fs');
const path = require('path');
const Engine = require('../../gameEngine.js');
const Runner = require('../bench/runner.js');
const Bench = require('../bench/benchmark.js');
const MCTS = require('./mcts.js');

const DEFAULT_CORPUS = path.join(__dirname, '..', 'bench', 'corpus', 'openings.b06.json');
const DEFAULT_BASELINE = path.join(__dirname, '..', 'bench', 'baseline', 'weights.v1.json');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const nx = argv[i + 1];
    if (nx === undefined || nx.startsWith('--')) a[k.slice(2)] = true;
    else { a[k.slice(2)] = nx; i++; }
  }
  return a;
}

function quantile(arr, q) { return Bench.quantile(arr, q); }

// Обёртка: время и прирост heapUsed на ход, максимальный размер дерева.
function instrument(chooseMove, acc) {
  return function (snap) {
    const h0 = process.memoryUsage().heapUsed;
    const t0 = process.hrtime.bigint();
    const out = chooseMove(snap);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const dh = process.memoryUsage().heapUsed - h0;
    acc.ms.push(ms);
    acc.heap.push(dh);
    const tr = (out && out.trace) || {};
    acc.nodes.push(tr.nodes || 0);
    if (tr.treeSize) acc.treeMax = Math.max(acc.treeMax, tr.treeSize);
    return out;
  };
}

function newAcc() { return { ms: [], heap: [], nodes: [], treeMax: 0 }; }

function runPart(opts) {
  const corpus = JSON.parse(fs.readFileSync(opts.corpus, 'utf8'));
  Bench.validateCorpus(corpus);
  const bl = JSON.parse(fs.readFileSync(opts.baseline, 'utf8'));
  const blWeights = bl.weights || bl.baseline || bl;
  const list = corpus.openings[opts.size][opts.split];
  if (opts.split === 'train') throw new Error('train split is not measured');
  const slice = list.slice(opts.from, opts.from + opts.count);
  const accC = newAcc(), accB = newAcc();
  const pairs = [], errors = [];
  for (const o of slice) {
    const games = [];
    try {
      for (const candSeat of [1, 2]) {
        const cand = instrument(MCTS.makeMctsPlayer(Engine, { nodeLimit: opts.nodeLimit, seed: 29 }), accC);
        const base = instrument(Runner.makeSearchPlayer(Engine, { difficulty: opts.difficulty, nodeLimit: opts.nodeLimit, weights: blWeights }), accB);
        const players = candSeat === 1 ? { 1: cand, 2: base } : { 1: base, 2: cand };
        const { result } = Runner.playGame(Engine, { rules: o.rules, players, prefix: o.prefix, maxMoves: 1000, meta: { id: o.id, candSeat } });
        const oppSeat = candSeat === 1 ? 2 : 1;
        const pts = result.winner === candSeat ? 1 : (result.winner === 0 ? 0.5 : 0);
        games.push({ candSeat, end: result.end, truncated: result.truncated, winner: result.winner,
          scores: result.scores, candScore: pts, scoreDiff: result.scores[candSeat] - result.scores[oppSeat], moves: result.moves });
      }
      pairs.push({ id: o.id, ruleset: o.ruleset, games, pairScore: (games[0].candScore + games[1].candScore) / 2 });
    } catch (e) {
      errors.push({ id: o.id, name: e.name, message: e.message, details: e.details || null });
    }
  }
  return { format: 'tochki-b06-part', mctsVersion: MCTS.MCTS_VERSION, engineVersion: Engine.ENGINE_VERSION,
    params: { corpus: path.basename(opts.corpus), corpusSeed: corpus.seed, split: opts.split, size: opts.size,
      difficulty: opts.difficulty, nodeLimit: opts.nodeLimit, mcts: Object.assign({}, MCTS.DEFAULTS, { nodeLimit: opts.nodeLimit }), from: opts.from, count: opts.count },
    pairs, errors, raw: { candidate: accC, baseline: accB } };
}

function costSummary(acc) {
  const heapKB = acc.heap.map(v => v / 1024);
  return { moves: acc.ms.length,
    moveMs: { p50: quantile(acc.ms, 0.5), p95: quantile(acc.ms, 0.95), mean: acc.ms.length ? acc.ms.reduce((a, b) => a + b, 0) / acc.ms.length : null },
    nodesPerMove: acc.nodes.length ? acc.nodes.reduce((a, b) => a + b, 0) / acc.nodes.length : null,
    heapDeltaKB: { p50: quantile(heapKB, 0.5), p95: quantile(heapKB, 0.95) },
    treeMax: acc.treeMax || null };
}

function merge(parts) {
  const pairs = [].concat(...parts.map(p => p.pairs));
  const errors = [].concat(...parts.map(p => p.errors));
  const accC = newAcc(), accB = newAcc();
  for (const p of parts) for (const [acc, src] of [[accC, p.raw.candidate], [accB, p.raw.baseline]]) {
    acc.ms.push(...src.ms); acc.heap.push(...src.heap); acc.nodes.push(...src.nodes); acc.treeMax = Math.max(acc.treeMax, src.treeMax);
  }
  const games = [].concat(...pairs.map(p => p.games));
  const wdl = { W: games.filter(g => g.candScore === 1).length, D: games.filter(g => g.candScore === 0.5).length, L: games.filter(g => g.candScore === 0).length };
  const pairWdl = { W: pairs.filter(p => p.pairScore > 0.5).length, D: pairs.filter(p => p.pairScore === 0.5).length, L: pairs.filter(p => p.pairScore < 0.5).length };
  const ci95 = Bench.bootstrapPairs(pairs.map(p => p.pairScore), 10000, 29);
  const byRuleset = {};
  for (const p of pairs) (byRuleset[p.ruleset] = byRuleset[p.ruleset] || []).push(p.pairScore);
  const lo = ci95.lo;
  const verdict = errors.length ? 'invalid (errors)' : (lo > 0.5 ? 'stronger' : (lo >= 0.5 ? 'not-weaker' : (ci95.hi < 0.5 ? 'weaker' : 'inconclusive')));
  const codeBytes = fs.statSync(path.join(__dirname, 'mcts.js')).size;
  return { format: 'tochki-b06-report', mctsVersion: MCTS.MCTS_VERSION, engineVersion: Engine.ENGINE_VERSION,
    botVersion: Engine.BOT_VERSION, params: Object.assign({}, parts[0].params, { from: undefined, count: undefined, parts: parts.length }),
    pairsTotal: pairs.length, wdl, pairWdl, score: ci95.mean, ci95: { lo: ci95.lo, hi: ci95.hi, resamples: 10000, seed: 29, method: 'bootstrap over pairs' },
    scoreDiffMean: games.length ? games.reduce((a, g) => a + g.scoreDiff, 0) / games.length : null,
    truncated: games.filter(g => g.truncated).length,
    byRuleset: Object.fromEntries(Object.entries(byRuleset).map(([k, v]) => [k, { pairs: v.length, score: v.reduce((a, b) => a + b, 0) / v.length }])),
    errors, verdict,
    cost: { training: { timeMs: 0, modelParamsBytes: 0, note: 'MCTS не обучается' }, codeBytes,
      candidate: costSummary(accC), baseline: costSummary(accB) },
    pairs };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a['gen-corpus']) {
    const seed = Number(a.seed || 20240629);
    const c = Bench.generateCorpus(seed);
    Bench.validateCorpus(c);
    fs.writeFileSync(a['gen-corpus'], JSON.stringify(c, null, 1) + '\n');
    console.log('corpus written', a['gen-corpus'], 'seed', seed);
    return;
  }
  if (a.merge) {
    const parts = String(a.merge).split(',').map(f => JSON.parse(fs.readFileSync(f.trim(), 'utf8')));
    const rep = merge(parts);
    if (a.out) { fs.mkdirSync(path.dirname(a.out), { recursive: true }); fs.writeFileSync(a.out, JSON.stringify(rep, null, 1) + '\n'); }
    const { pairs, ...short } = rep;
    console.log(JSON.stringify(short, null, 1));
    return;
  }
  const opts = { corpus: a.corpus || DEFAULT_CORPUS, baseline: a.baseline || DEFAULT_BASELINE,
    split: a.split || 'test', size: a.size || 'small', difficulty: a.difficulty || 'normal',
    nodeLimit: Number(a['node-limit'] || 300), from: Number(a.from || 0), count: Number(a.count || 1000) };
  const t0 = Date.now();
  const part = runPart(opts);
  part.wallMs = Date.now() - t0;
  if (a.out) { fs.mkdirSync(path.dirname(a.out), { recursive: true }); fs.writeFileSync(a.out, JSON.stringify(part) + '\n'); }
  console.log(JSON.stringify({ pairs: part.pairs.map(p => [p.id, p.pairScore]), errors: part.errors, wallMs: part.wallMs }));
}

if (require.main === module) main();
module.exports = { runPart, merge, costSummary };
