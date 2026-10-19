'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const E = require('../../gameEngine');
const R = require('./runner');
const { validateCorpus, fingerprint } = require('./corpus');
const frozen = require('./baseline/weights.v1.json');

function random(seed) {
  let s = seed >>> 0;
  return () => { s += 0x6D2B79F5; let t = s;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function quantile(values, q) {
  if (!values.length) return null;
  const a = values.slice().sort((a, b) => a - b);
  return a[Math.floor((a.length - 1) * q)];
}
function shuffle(values, rng) {
  const a = values.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function bootstrap(pairs, seed, iterations = 2000) {
  const clusters = new Map();
  // Any incomplete pair is excluded as a unit.
  for (const pair of pairs) {
    if (pair.games.length !== 2 || pair.games.some(g => g.error || g.truncated)) continue;
    const values = clusters.get(pair.openingId) || [];
    values.push(...pair.games.map(g => g.result));
    clusters.set(pair.openingId, values);
  }
  const groups = [...clusters.values()];
  if (!groups.length) return { estimate: null, lower: null, upper: null, clusters: 0, iterations };
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const estimate = mean(groups.flat());
  const rng = random(seed), samples = [];
  for (let i = 0; i < iterations; i++) {
    const drawn = [];
    for (let j = 0; j < groups.length; j++) drawn.push(...groups[Math.floor(rng() * groups.length)]);
    samples.push(mean(drawn));
  }
  return { estimate, lower: quantile(samples, .025), upper: quantile(samples, .975),
    clusters: groups.length, iterations, unit: 'opening-id (both colours, all runs/configurations)' };
}
function summarize(pairs, seed) {
  const games = pairs.flatMap(p => p.games);
  const valid = games.filter(g => !g.error && !g.truncated);
  const decisions = games.flatMap(g => g.decisions || []);
  return {
    games: games.length, errors: games.filter(g => g.error).length,
    truncated: games.filter(g => g.truncated).length,
    truncationRate: games.length ? games.filter(g => g.truncated).length / games.length : null,
    W: valid.filter(g => g.result === 1).length,
    D: valid.filter(g => g.result === .5).length,
    L: valid.filter(g => g.result === 0).length,
    meanScoreDifference: valid.length ? valid.reduce((s, g) => s + g.scoreDifference, 0) / valid.length : null,
    search: {
      decisions: decisions.length,
      totalNodes: decisions.reduce((s, d) => s + (d.trace?.nodes || 0), 0),
      meanCompletedDepth: decisions.length ? decisions.reduce((s, d) => s + (d.trace?.completedDepth || 0), 0) / decisions.length : null,
      p50Ms: quantile(decisions.map(d => d.elapsedMs), .5),
      p95Ms: quantile(decisions.map(d => d.elapsedMs), .95)
    },
    interval95: bootstrap(pairs, seed)
  };
}
function auditPositions(corpus, weights, difficulties, nodeLimit) {
  const results = [];
  for (const position of corpus.positions.filter(p => p.split === 'test')) for (const difficulty of difficulties) {
    try {
      const match = R.prefixMatch(position.options, position.prefix);
      const s = match.getSnapshot();
      const response = R.makeSearchPlayer({ weights, difficulty, nodeLimit })(s);
      const m = response.move;
      if (!m || !match.applyMove(s.current, m.x, m.y).ok) throw new R.InvalidMoveError('audit illegal move');
      const same = a => a.x === m.x && a.y === m.y;
      const miss = position.kind === 'tactical'
        ? !position.bestMoves.some(same) ||
          match.getSnapshot().scores[s.current] - s.scores[s.current] < position.minScoreGain
        : position.forbiddenMoves.some(same);
      results.push({ id: position.id, kind: position.kind, difficulty, miss, move: m, trace: response.trace });
    } catch (e) {
      results.push({ id: position.id, kind: position.kind, difficulty, error: e.name + ': ' + e.message });
    }
  }
  return { results, errors: results.filter(r => r.error).length,
    tacticalMisses: results.filter(r => r.kind === 'tactical' && r.miss).length,
    strategicMisses: results.filter(r => r.kind === 'strategic' && r.miss).length };
}
function runBenchmark({ corpus, split = 'validation', seed = 12012, runs = 2,
  nodeLimit = 60, openingCount = 2, full = false, maxMoves = 1000,
  maxTimeMs = Infinity, candidateWeights = E.BOT_WEIGHTS, onGame = () => {} } = {}) {
  const corpusHash = validateCorpus(corpus);
  if (!['validation', 'test'].includes(split)) throw new Error('Independent benchmark forbids train split');
  for (const n of [runs, nodeLimit, openingCount]) if (!Number.isInteger(n) || n < 1) throw new Error('Invalid benchmark count');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Invalid seed');
  if (Object.keys(E.BOT_WEIGHTS).some(k => !Number.isFinite(candidateWeights[k]))) throw new Error('Invalid candidate weights');
  const sizes = full ? Object.keys(E.SIZES) : ['small'];
  const difficulties = full ? ['normal', 'strong'] : ['normal'];
  const ruleSets = full ? [
    { id: 'standard', options: {} },
    { id: 'extra-turn', options: { extraTurnOnCapture: true } },
    { id: 'score-3', options: { targetScore: 3 } }
  ] : [{ id: 'fill-20', options: { targetFillPercent: 20 } }];
  const opponents = full ? [{ id: frozen.id, weights: frozen.weights }, ...frozen.pool]
    : [{ id: frozen.id, weights: frozen.weights }];
  const pairs = [], runSeeds = [];
  // Select the held-out sample once, independently of observed outcomes.
  const chosen = sizes.flatMap(sizeKey => shuffle(corpus.openings.filter(o => o.split === split &&
    o.sizeKey === sizeKey), random(seed ^ E.SIZES[sizeKey].rows)).slice(0, openingCount));
  for (let run = 0; run < runs; run++) {
    const runSeed = (seed + Math.imul(run + 1, 2654435761)) >>> 0;
    runSeeds.push(runSeed);
    for (const opening of shuffle(chosen, random(runSeed))) for (const difficulty of difficulties)
      for (const rules of ruleSets) for (const opponent of opponents) {
        const pair = { id: `${run}/${opening.id}/${difficulty}/${rules.id}/${opponent.id}`,
          openingId: opening.id, run, runSeed, difficulty, rules, opponent: opponent.id, games: [] };
        for (const candidateSeat of [1, 2]) {
          const weights = { [candidateSeat]: candidateWeights, [3 - candidateSeat]: opponent.weights };
          const metadata = { pairId: pair.id, candidateSeat, runSeed, nodeLimit, difficulty, weights };
          let game;
          try {
            const result = R.runMatch({ options: { sizeKey: opening.sizeKey, ...rules.options },
              prefix: opening.prefix, players: {
                1: R.makeSearchPlayer({ weights: weights[1], difficulty, nodeLimit }),
                2: R.makeSearchPlayer({ weights: weights[2], difficulty, nodeLimit })
              }, maxMoves, maxTimeMs, metadata });
            R.replayLines(result.jsonl);
            game = { candidateSeat, status: result.status, truncated: result.truncated,
              result: result.truncated ? null : result.winner === 0 ? .5 : result.winner === candidateSeat ? 1 : 0,
              scoreDifference: result.snapshot.scores[candidateSeat] - result.snapshot.scores[3 - candidateSeat],
              decisions: result.decisions };
            onGame({ metadata, records: result.records });
          } catch (e) {
            game = { candidateSeat, error: e.name + ': ' + e.message };
            onGame({ metadata, error: game.error });
          }
          pair.games.push(game);
        }
        pairs.push(pair);
      }
  }
  const summary = summarize(pairs, seed);
  const baseline = summarize(pairs.filter(p => p.opponent === frozen.id), seed);
  const audit = auditPositions(corpus, candidateWeights, difficulties, nodeLimit);
  const baselineAudit = auditPositions(corpus, frozen.weights, difficulties, nodeLimit);
  let commit = 'unknown';
  try { commit = cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch (_) { /* source archive */ }
  const hashes = Object.fromEntries(['gameEngine.js', 'tools/bench/runner.js', 'tools/bench/benchmark.js',
    'tools/bench/corpus.js'].map(p => [p, fingerprint(fs.readFileSync(path.join(__dirname, '../..', p), 'utf8'))]));
  return { format: 'tochki-benchmark', version: 1,
    criterion: 'test baseline paired-opening bootstrap lower95 > 0.5; no errors/truncations or corpus regressions',
    accepted: split === 'test' && baseline.interval95.lower > .5 && summary.errors === 0 &&
      summary.truncated === 0 && audit.errors === 0 &&
      audit.results.every(r => !r.miss || baselineAudit.results.some(b => b.id === r.id &&
        b.difficulty === r.difficulty && b.miss)),
    provenance: { commit, hashes, corpusHash, corpusVersion: corpus.version,
      engineVersion: E.ENGINE_VERSION, botVersion: E.BOT_VERSION, weightsVersion: E.WEIGHTS_VERSION,
      candidateWeights, frozen, seed, runSeeds },
    parameters: { split, runs, nodeLimit, openingCount, full, maxMoves,
      maxTimeMs: Number.isFinite(maxTimeMs) ? maxTimeMs : null, sizes, difficulties,
      search: Object.fromEntries(difficulties.map(d => [d, { ...E.DIFFICULTY[d], timeLimit: null, nodeLimit }])),
      ruleSets, openings: chosen.map(o => o.id) },
    summary, baseline, audit, baselineAudit, pairs };
}
module.exports = { random, quantile, bootstrap, summarize, auditPositions, runBenchmark };
if (require.main === module) {
  const args = process.argv.slice(2), config = {};
  let out = 'tools/bench/reports/trial.json';
  const names = { '--split': 'split', '--seed': 'seed', '--runs': 'runs', '--nodes': 'nodeLimit',
    '--openings': 'openingCount' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--full') { config.full = true; continue; }
    const key = args[i], value = args[++i];
    if (value === undefined) throw new Error('Missing argument for ' + key);
    if (key === '--out') out = value;
    else if (names[key]) config[names[key]] = key === '--split' ? value : Number(value);
    else throw new Error('Unknown argument ' + key);
  }
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'corpus/openings.v1.json')));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fd = fs.openSync(out + '.games.jsonl', 'w');
  try {
    const report = runBenchmark({ ...config, corpus,
      onGame: game => fs.writeSync(fd, JSON.stringify(game) + '\n') });
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ out, summary: report.summary, accepted: report.accepted }, null, 2));
    if (report.summary.errors || report.audit.errors) process.exitCode = 1;
  } finally { fs.closeSync(fd); }
}
