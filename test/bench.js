'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const E = require('../gameEngine');
const R = require('../tools/bench/runner');
const C = require('../tools/bench/corpus');
const B = require('../tools/bench/benchmark');
const corpus = require('../tools/bench/corpus/openings.v1.json');
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('ok - ' + name); }
const players = { 1: R.makeSearchPlayer({ nodeLimit: 4 }), 2: R.makeSearchPlayer({ nodeLimit: 4 }) };
const small = { options: { sizeKey: 'small', targetFillPercent: 4 }, players };
test('JSONL round trip and terminal outcome', () => {
  const result = R.runMatch(small);
  assert.equal(result.status, 'finished');
  assert.deepEqual(R.replayLines(result.jsonl), result.snapshot);
  assert.throws(() => R.replayLines(result.jsonl.replace('"winner":0', '"winner":3')));
});
test('deterministic moves and traces with node limits', () => {
  const a = R.runMatch(small), b = R.runMatch(small);
  const deterministic = r => r.decisions.map(d => ({ p: d.p, x: d.x, y: d.y,
    nodes: d.trace.nodes, depth: d.trace.completedDepth, reason: d.trace.stopReason }));
  assert.deepEqual(deterministic(a), deterministic(b));
  assert.deepEqual(a.snapshot, b.snapshot);
});
test('truncation is not a draw', () => {
  for (const limits of [{ maxMoves: 0 }, { maxTimeMs: 0 }]) {
    const r = R.runMatch({ ...small, ...limits });
    assert.equal(r.truncated, true); assert.equal(r.winner, null);
    R.replayLines(r.jsonl);
  }
});
test('bad/null/wrong-player moves and prefixes fail', () => {
  for (const move of [null, { x: -1, y: 0 }, { x: 4.5, y: 3 }, { p: 2, x: 4, y: 3 }])
    assert.throws(() => R.runMatch({ ...small, players: { 1: () => move } }), R.InvalidMoveError);
  assert.throws(() => R.runMatch({ ...small, prefix: [{ p: 2, x: 4, y: 3 }] }), R.InvalidMoveError);
  assert.throws(() => R.runMatch({ ...small, prefix: [{ p: 1, x: 4, y: 3 }, { p: 2, x: 4, y: 3 }] }), R.InvalidMoveError);
});
test('versioned corpus and generation agree', () => {
  C.validateCorpus(corpus);
  assert.deepEqual(corpus, C.generateCorpus());
});
test('strict corpus errors and split leakage', () => {
  const clone = () => JSON.parse(JSON.stringify(corpus));
  let c = clone(); c.openings[0].prefix[0].p = 2;
  assert.throws(() => C.validateCorpus(c));
  c = clone(); c.openings[8].prefix = c.openings[0].prefix;
  assert.throws(() => C.validateCorpus(c), /leakage/);
  c = clone(); c.openings[1].id = c.openings[0].id;
  assert.throws(() => C.validateCorpus(c), /Duplicate/);
});
test('paired clustered bootstrap excludes incomplete pairs', () => {
  const pairs = [
    { openingId: 'a', games: [{ result: 1 }, { result: 0 }] },
    { openingId: 'b', games: [{ result: .5 }, { result: .5 }] },
    { openingId: 'c', games: [{ truncated: true }, { result: 1 }] }
  ];
  const ci = B.bootstrap(pairs, 3);
  assert.equal(ci.clusters, 2); assert.equal(ci.lower, .5); assert.equal(ci.upper, .5);
  assert.deepEqual(ci, B.bootstrap(pairs, 3));
  assert.equal(B.bootstrap([], 3).lower, null);
});
test('train split forbidden and mini paired report reproducible', () => {
  assert.throws(() => B.runBenchmark({ corpus, split: 'train' }), /forbids train/);
  const config = { corpus, runs: 1, openingCount: 1, nodeLimit: 4 };
  const a = B.runBenchmark(config), b = B.runBenchmark(config);
  assert.equal(a.summary.errors, 0); assert.equal(a.summary.truncated, 0);
    assert.equal(a.summary.games, 2); assert.equal(a.accepted, false);
  assert.equal(a.audit.results.length, 0, 'validation must not expose test positions');
  const heldOutAudit = B.auditPositions(corpus, E.BOT_WEIGHTS, ['normal'], 4);
  assert.equal(heldOutAudit.errors, 0);
  assert.equal(heldOutAudit.results.length, corpus.positions.length);
  assert.deepEqual(a.baseline.interval95, b.baseline.interval95);
  assert.deepEqual(a.pairs.map(p => p.games.map(g => g.result)), b.pairs.map(p => p.games.map(g => g.result)));
  assert.deepEqual(a.pairs[0].games.map(g => g.candidateSeat), [1, 2]);
});
test('truncation excluded from WDL and confidence interval', () => {
  const r = B.runBenchmark({ corpus, runs: 1, openingCount: 1, nodeLimit: 1, maxMoves: 0 });
  assert.equal(r.summary.truncated, 2); assert.equal(r.summary.W + r.summary.D + r.summary.L, 0);
  assert.equal(r.baseline.interval95.lower, null); assert.equal(r.accepted, false);
});
test('browser uses the same runner without Node or SQLite', () => {
  const context = vm.createContext({ performance: { now: () => 0 } });
  vm.runInContext(fs.readFileSync(require.resolve('../gameEngine'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('../tools/bench/runner'), 'utf8'), context);
  const browser = vm.runInContext(`TochkiRunner.runMatch({
    options:{sizeKey:'small'},players:{},maxMoves:0}).jsonl`, context);
  assert.equal(R.replayLines(browser).sizeKey, 'small');
});
test('runner has no database dependency and weights unchanged', () => {
  const original = JSON.stringify(E.BOT_WEIGHTS);
  R.runMatch(small);
  assert.equal(JSON.stringify(E.BOT_WEIGHTS), original);
  assert(!Object.keys(require.cache).some(p => /[/\\](db\.js|better-sqlite3)[/\\]?/.test(p)));
});
console.log(`${checks} benchmark smoke checks passed`);
