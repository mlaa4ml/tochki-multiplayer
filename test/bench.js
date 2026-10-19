// test/bench.js — быстрый smoke headless runner/benchmark (A07, issue #12).
// Только малое поле и крошечные лимиты узлов: полный турнир сюда НЕ входит
// (см. npm run bench:full и docs/BENCHMARK.md).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Engine = require('../gameEngine.js');
const Runner = require('../tools/bench/runner.js');
const Bench = require('../tools/bench/benchmark.js');

let passed = 0;
function test(name, fn){
  try { fn(); passed++; console.log('ok -', name); }
  catch (e){ console.error('FAIL -', name); console.error(e); process.exit(1); }
}

const RULES = { sizeKey: 'small', targetFillPercent: 8, firstPlayer: 1, undoAllowed: false };
const player = (w) => Runner.makeSearchPlayer(Engine, { difficulty: 'normal', nodeLimit: 120, weights: w });
const stripMs = (lines) => lines.map(l => { const r = JSON.parse(l); delete r.ms; return JSON.stringify(r); });

test('runner/benchmark не импортируют БД и не пишут веса', () => {
  for (const f of ['runner.js', 'benchmark.js']){
    const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'bench', f), 'utf8');
    assert(!/require\([^)]*(db|gamelog)\.js/.test(src), f + ' импортирует БД');
    assert(!/saveBotWeights/.test(src), f + ' сохраняет веса');
  }
});

let game;
test('штатно завершённая партия -> JSONL header/move/result', () => {
  game = Runner.playGame(Engine, { rules: RULES, players: { 1: player(), 2: player() }, maxMoves: 200 });
  assert.strictEqual(game.result.end, 'finished');
  assert.strictEqual(game.result.truncated, false);
  const recs = game.lines.map(l => JSON.parse(l));
  assert.strictEqual(recs[0].type, 'header');
  assert.strictEqual(recs[0].rules.sizeKey, 'small');
  assert.strictEqual(recs[recs.length - 1].type, 'result');
  assert(recs.some(r => r.type === 'move'));
});

test('replay JSONL воспроизводит счёт', () => {
  const r = Runner.replayLines(Engine, game.lines);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.scores, game.result.scores);
});

test('повторяемость при лимите узлов', () => {
  const again = Runner.playGame(Engine, { rules: RULES, players: { 1: player(), 2: player() }, maxMoves: 200 });
  assert.deepStrictEqual(stripMs(again.lines), stripMs(game.lines));
});

test('truncation по лимиту ходов отделён от завершения', () => {
  const g = Runner.playGame(Engine, { rules: { sizeKey: 'small', targetFillPercent: 50 }, players: { 1: player(), 2: player() }, maxMoves: 3 });
  assert.strictEqual(g.result.end, 'truncated-moves');
  assert.strictEqual(g.result.truncated, true);
  assert.strictEqual(g.result.moves, 3);
});

test('truncation по времени', () => {
  let t = 0;
  const g = Runner.playGame(Engine, { rules: { sizeKey: 'small', targetFillPercent: 50 }, players: { 1: player(), 2: player() },
    maxMs: 5, clock: () => (t += 10) });
  assert.strictEqual(g.result.end, 'truncated-time');
  assert.strictEqual(g.result.truncated, true);
});

test('невалидный ход бота -> InvalidMoveError, не ничья', () => {
  const bad = () => ({ move: { x: 6, y: 5 } }); // одна и та же клетка дважды
  assert.throws(() => Runner.playGame(Engine, { rules: RULES, players: { 1: bad, 2: bad }, maxMoves: 10 }),
    e => e instanceof Runner.InvalidMoveError);
});

test('null-ход при наличии легальных ходов -> InvalidMoveError, не штатное завершение', () => {
  const lazy = () => ({ move: null });
  assert.throws(() => Runner.playGame(Engine, { rules: RULES, players: { 1: lazy, 2: lazy }, maxMoves: 10 }),
    e => e instanceof Runner.InvalidMoveError && /no move/.test(e.message));
});

test('строгая проверка префикса дебюта', () => {
  const m = Engine.createMatch(RULES);
  assert.throws(() => Runner.applyPrefix(m, [{ x: 6, y: 5, seat: 1 }, { x: 6, y: 5, seat: 2 }], () => {}),
    e => e instanceof Runner.InvalidMoveError);
  const bad = { format: 'tochki-bench-corpus', openings: { small: { test: [{ id: 'x', rules: RULES, prefix: [{ x: 6, y: 5, seat: 2 }] }] } } };
  assert.throws(() => Bench.validateCorpus(bad), /corpus invalid/);
});

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'bench', 'corpus', 'openings.v1.json'), 'utf8'));
test('версионированный корпус валиден, сплиты не пересекаются', () => {
  assert.strictEqual(corpus.version, 1);
  assert.strictEqual(Bench.validateCorpus(corpus), true);
  for (const s of Object.values(corpus.openings)){
    const key = o => JSON.stringify(o.prefix);
    const tr = new Set(s.train.map(key));
    for (const o of s.validation.concat(s.test)) assert(!tr.has(key(o)), 'validation/test пересекается с train');
  }
});

test('bootstrap по парам: интервал содержит среднее', () => {
  const ci = Bench.bootstrapPairs([1, 0.5, 0.5, 0, 1, 1], 500, 7);
  assert(ci.lo <= ci.mean && ci.mean <= ci.hi);
  assert.deepStrictEqual(Bench.bootstrapPairs([0.5, 1], 300, 3), Bench.bootstrapPairs([0.5, 1], 300, 3));
});

test('мини-benchmark: машинный отчёт и запрет split=train', () => {
  const base = { id: 'baseline', weights: { ...Engine.BOT_WEIGHTS } };
  const opts = { corpus, split: 'validation', sizes: ['small'], difficulties: ['normal'], nodeLimit: 80, runs: 1, seed: 1,
    maxMoves: 12, maxMs: 0, bootstrap: 100, maxPairs: 1, candidate: { id: 'c', weights: { ...Engine.BOT_WEIGHTS } }, pool: [base] };
  const rep = Bench.runBenchmark(opts);
  assert.strictEqual(rep.errors.length, 0);
  const c = rep.configs[0];
  for (const k of ['W', 'D', 'L', 'truncationRate', 'scoreDiffMean', 'ci95', 'nodesPerMove', 'completedDepth', 'moveMs', 'tactics'])
    assert(k in c, 'нет поля ' + k);
  assert.strictEqual(c.games, 2);
  assert.strictEqual(typeof rep.acceptance.accepted, 'boolean');
  assert.throws(() => Bench.runBenchmark(Object.assign({}, opts, { split: 'train' })), /train/);
});

test('прогоны дают разные позиции; bootstrap кластеризует по дебюту', () => {
  const base = { id: 'baseline', weights: { ...Engine.BOT_WEIGHTS } };
  const rep = Bench.runBenchmark({ corpus, split: 'validation', sizes: ['small'], difficulties: ['normal'], nodeLimit: 60, runs: 2, seed: 3,
    maxMoves: 8, maxMs: 0, bootstrap: 100, maxPairs: 1, candidate: { id: 'c', weights: { ...Engine.BOT_WEIGHTS } }, pool: [base] });
  const c = rep.configs[0];
  assert.strictEqual(rep.errors.length, 0);
  assert.strictEqual(c.pairs, 2);
  assert.strictEqual(c.uniquePositions, 2, 'прогоны повторяют ту же позицию');
  assert.strictEqual(c.clusters, 1, 'прогоны одного дебюта должны быть одним кластером');
  assert.strictEqual(rep.vsBaseline.clusters, 1);
  // Один кластер -> интервал вырожден в его среднее, а не «сужен» повторами.
  assert.strictEqual(c.ci95.lo, c.ci95.hi);
});

test('кластерный bootstrap шире наивного при повторах', () => {
  const vals = [1, 0, 1, 0.5];
  const naive = Bench.bootstrapPairs(vals.concat(vals, vals), 1000, 5);
  const cl = Bench.bootstrapClusters(vals.map(v => [v, v, v]), 1000, 5);
  assert((cl.hi - cl.lo) > (naive.hi - naive.lo));
});

test('стратегический корпус: версионирован, строго валиден, ожидания пересчитываются движком', () => {
  const S = require('../tools/bench/strategic.js');
  const st = JSON.parse(fs.readFileSync(S.DEFAULT_PATH, 'utf8'));
  assert.strictEqual(st.format, 'tochki-bench-strategic');
  assert.strictEqual(st.version, 1);
  assert.strictEqual(S.validateStrategic(st, true), true);
  for (const kind of S.KINDS)
    assert(Object.values(st.positions).some(l => l.some(p => p.kind === kind)), 'нет позиций вида ' + kind);
  // Порча ожидаемого хода ловится глубокой проверкой.
  const broken = JSON.parse(JSON.stringify(st));
  const p = Object.values(broken.positions).find(l => l.length)[0];
  p.expected = p.expected.slice(1).concat(p.expected.length > 1 ? [] : [{ x: -1, y: -1 }]);
  assert.throws(() => S.validateStrategic(broken, true), /strategic corpus invalid/);
});

test('отчёт содержит стратегические пропуски по видам', () => {
  const base = { id: 'baseline', weights: { ...Engine.BOT_WEIGHTS } };
  const rep = Bench.runBenchmark({ corpus, split: 'validation', sizes: ['small'], difficulties: ['normal'], nodeLimit: 60, runs: 1, seed: 2,
    maxMoves: 4, maxMs: 0, bootstrap: 50, maxPairs: 1, candidate: { id: 'c', weights: { ...Engine.BOT_WEIGHTS } }, pool: [base] });
  const s = rep.configs[0].strategic;
  assert(s && s.total > 0, 'нет strategic в отчёте');
  for (const kind of ['defend-threat', 'endgame-fill']) assert(kind in s.byKind);
  assert.strictEqual(typeof s.misses, 'number');
});

console.log(`bench smoke: ${passed} passed`);
