#!/usr/bin/env node
// tools/bench/benchmark.js
//
// Независимый парный benchmark ботов (A07, issue #12). Это ИЗМЕРЕНИЕ, а не
// подбор весов: файл не импортирует db.js/gamelog.js и никогда не пишет и не
// публикует веса. Подбор весов — tools/train-bot.js (он корпус не читает).
//
// Команды:
//   node tools/bench/benchmark.js --gen-corpus tools/bench/corpus/openings.v1.json
//   node tools/bench/benchmark.js --split validation --sizes small --difficulties normal --runs 1 --out r.json
//   node tools/bench/benchmark.js --full --out tools/bench/reports/full.json   (долго)
// Подробности и статистические ограничения — docs/BENCHMARK.md.

const fs = require('fs');
const path = require('path');
const Engine = require('../../gameEngine.js');
const Runner = require('./runner.js');

const BENCH_VERSION = 1;
const DEFAULT_CORPUS = path.join(__dirname, 'corpus', 'openings.v1.json');
const DEFAULT_BASELINE = path.join(__dirname, 'baseline', 'weights.v1.json');

// ---------- ГПСЧ (xorshift32) ----------
function makeRng(seed){
  let s = (seed >>> 0) || 1;
  return function(){
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ---------- Генерация корпуса ----------
const RULESETS = [
  { id: 'fill30', targetFillPercent: 30 },
  { id: 'fill30-extra', targetFillPercent: 30, extraTurnOnCapture: true },
  { id: 'score3-fill45', targetScore: 3, targetFillPercent: 45 }
];

function matchRules(sizeKey, rs){
  return { sizeKey, targetScore: rs.targetScore || 0, targetFillPercent: rs.targetFillPercent,
    firstPlayer: 1, extraTurnOnCapture: rs.extraTurnOnCapture === true, undoAllowed: false };
}

// Случайный легальный ход (перебор клеток в случайном порядке через applyMove
// на копии — сам матч не изменяется, если ход нелегален).
function randomLegalPrefix(rules, len, rng){
  const match = Engine.createMatch(rules);
  const prefix = [];
  for (let i = 0; i < len; i++){
    const snap = match.getSnapshot();
    if (snap.gameOver) break;
    const cells = [];
    for (let y = 0; y < snap.rows; y++) for (let x = 0; x < snap.cols; x++) cells.push({ x, y });
    for (let k = cells.length - 1; k > 0; k--){ const j = Math.floor(rng() * (k + 1)); [cells[k], cells[j]] = [cells[j], cells[k]]; }
    let done = false;
    for (const c of cells){
      const res = match.applyMove(snap.current, c.x, c.y);
      if (res.ok){
        if (res.gameOver) return null;
        prefix.push({ x: c.x, y: c.y, seat: snap.current }); done = true; break;
      }
    }
    if (!done) break;
  }
  return prefix;
}

function replayPrefix(rules, prefix){
  const match = Engine.createMatch(rules);
  for (const mv of prefix){ const r = match.applyMove(mv.seat, mv.x, mv.y); if (!r.ok || r.gameOver) return null; }
  return match;
}

// Тактическая позиция: у ходящего есть ход с немедленным захватом. Ожидаемые
// ходы — ВСЕ клетки, дающие прирост очков (проверено реальным applyMove).
function capturingMoves(rules, prefix){
  const base = replayPrefix(rules, prefix);
  if (!base) return [];
  const snap = base.getSnapshot();
  const seat = snap.current, before = snap.scores[seat];
  const out = [];
  for (let y = 0; y < snap.rows; y++) for (let x = 0; x < snap.cols; x++){
    if (snap.stone[y][x]) continue;
    const m = replayPrefix(rules, prefix);
    const r = m.applyMove(seat, x, y);
    if (r.ok && r.scores[seat] > before) out.push({ x, y });
  }
  return out;
}

function generateCorpus(seed){
  const rng = makeRng(seed);
  const corpus = { format: 'tochki-bench-corpus', version: 1, seed, engineVersion: Engine.ENGINE_VERSION,
    note: 'Генерируется --gen-corpus; файл версионирован и не меняется. Новая версия корпуса = новый файл.',
    rulesets: RULESETS, openings: {}, tactics: {} };
  const splits = { train: 8, validation: 8, test: 12 };
  for (const sizeKey of ['small', 'medium']){
    corpus.openings[sizeKey] = { train: [], validation: [], test: [] };
    let n = 0;
    for (const [split, count] of Object.entries(splits)){
      while (corpus.openings[sizeKey][split].length < count){
        const rs = RULESETS[n % RULESETS.length];
        const rules = matchRules(sizeKey, rs);
        const prefix = randomLegalPrefix(rules, 4 + Math.floor(rng() * 3), rng);
        if (!prefix || prefix.length < 4) continue;
        corpus.openings[sizeKey][split].push({ id: `${sizeKey}-${split}-${corpus.openings[sizeKey][split].length}`, ruleset: rs.id, rules, prefix });
        n++;
      }
    }
    // Тактика: короткие случайные партии, где появился захват в один ход.
    corpus.tactics[sizeKey] = [];
    let attempts = 0;
    while (corpus.tactics[sizeKey].length < 6 && attempts < 400){
      attempts++;
      const rules = matchRules(sizeKey, RULESETS[0]);
      const prefix = randomLegalPrefix(rules, 10 + Math.floor(rng() * 16), rng);
      if (!prefix || prefix.length < 6) continue;
      const exp = capturingMoves(rules, prefix);
      if (!exp.length) continue;
      corpus.tactics[sizeKey].push({ id: `${sizeKey}-tactic-${corpus.tactics[sizeKey].length}`, kind: 'capture-in-1', rules, prefix, expected: exp });
    }
  }
  return corpus;
}

// Строгая проверка корпуса: каждый префикс должен целиком проигрываться.
function validateCorpus(corpus){
  if (corpus.format !== 'tochki-bench-corpus') throw new Error('bad corpus format');
  const errors = [];
  for (const [sizeKey, splits] of Object.entries(corpus.openings)){
    const ids = new Set();
    for (const [split, list] of Object.entries(splits)) for (const o of list){
      if (ids.has(o.id)) errors.push('duplicate id ' + o.id);
      ids.add(o.id);
      try { Runner.applyPrefix(Engine.createMatch(o.rules), o.prefix, () => {}); }
      catch (e){ errors.push(`${o.id} (${split}): ${e.message}`); }
    }
  }
  for (const list of Object.values(corpus.tactics || {})) for (const t of list){
    try { Runner.applyPrefix(Engine.createMatch(t.rules), t.prefix, () => {}); }
    catch (e){ errors.push(`${t.id}: ${e.message}`); }
  }
  if (errors.length) throw new Error('corpus invalid:\n' + errors.join('\n'));
  return true;
}

// ---------- Статистика ----------
function quantile(arr, q){
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}
function mean(a){ return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

// Кластерный bootstrap (A07, issue #12). Кластер — все пары, выросшие из
// ОДНОГО исходного дебюта корпуса (все прогоны и сложности). Они не
// независимы, поэтому ресэмплируются целиком: ширина интервала определяется
// числом исходных дебютов, а не числом сыгранных партий.
function bootstrapClusters(clusters, resamples, seed){
  clusters = clusters.filter(c => c && c.length);
  const all = [].concat(...clusters);
  if (!clusters.length) return { lo: null, hi: null, mean: null, n: 0, clusters: 0 };
  const rng = makeRng(seed ^ 0x9e3779b9);
  const means = [];
  for (let b = 0; b < resamples; b++){
    let s = 0, n = 0;
    for (let i = 0; i < clusters.length; i++){
      const c = clusters[Math.floor(rng() * clusters.length)];
      for (const v of c) s += v;
      n += c.length;
    }
    means.push(s / n);
  }
  return { mean: mean(all), lo: quantile(means, 0.025), hi: quantile(means, 0.975), resamples, n: all.length, clusters: clusters.length };
}

// Bootstrap по независимым парам (каждая пара — отдельный кластер).
function bootstrapPairs(pairScores, resamples, seed){
  return bootstrapClusters(pairScores.map(v => [v]), resamples, seed);
}

function hashStr(s){
  let h = 2166136261;
  for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Продолжение префикса `plies` случайными легальными ходами (не заканчивая партию).
function extendPrefix(rules, prefix, plies, rng){
  const match = replayPrefix(rules, prefix);
  if (!match) return null;
  const out = prefix.slice();
  for (let i = 0; i < plies; i++){
    const snap = match.getSnapshot();
    if (snap.gameOver) return null;
    const cells = [];
    for (let y = 0; y < snap.rows; y++) for (let x = 0; x < snap.cols; x++) if (!snap.stone[y][x]) cells.push({ x, y });
    for (let k = cells.length - 1; k > 0; k--){ const j = Math.floor(rng() * (k + 1)); [cells[k], cells[j]] = [cells[j], cells[k]]; }
    let done = false;
    for (const c of cells){
      const res = match.applyMove(snap.current, c.x, c.y);
      if (res.ok){
        if (res.gameOver) return null;
        out.push({ x: c.x, y: c.y, seat: snap.current }); done = true; break;
      }
    }
    if (!done) return null;
  }
  return out;
}

// Позиция прогона: run 0 — исходный дебют; run > 0 — дебют, продолженный
// `plies` случайными легальными ходами (seed прогона + id дебюта). Без этого
// при детерминированном лимите узлов все прогоны повторяли бы те же партии.
// Обе партии пары (смена цветов) играются из одной и той же позиции.
function derivePosition(o, run, runSeed, plies){
  if (run === 0 || !(plies > 0)) return o;
  const rng = makeRng((runSeed ^ hashStr(o.id)) >>> 0);
  for (let p = plies; p >= 1; p--) for (let a = 0; a < 8; a++){
    const ext = extendPrefix(o.rules, o.prefix, p, rng);
    if (ext) return Object.assign({}, o, { id: o.id + '#r' + run, baseId: o.id, prefix: ext });
  }
  return null;
}

// Старый наивный вариант (каждая пара независима) — оставлен для сравнения.
function bootstrapPairsNaive(pairScores, resamples, seed){
  if (!pairScores.length) return { lo: null, hi: null, mean: null };
  const rng = makeRng(seed ^ 0x9e3779b9);
  const means = [];
  for (let b = 0; b < resamples; b++){
    let s = 0;
    for (let i = 0; i < pairScores.length; i++) s += pairScores[Math.floor(rng() * pairScores.length)];
    means.push(s / pairScores.length);
  }
  return { mean: mean(pairScores), lo: quantile(means, 0.025), hi: quantile(means, 0.975), resamples };
}

// ---------- Парный матч ----------
function points(winner, seat){ return winner === 0 ? 0.5 : (winner === seat ? 1 : 0); }

function playPair(opening, cand, opp, cfg, jsonlOut){
  const games = [];
  for (const candSeat of [1, 2]){
    const pCand = Runner.makeSearchPlayer(Engine, { difficulty: cfg.difficulty, nodeLimit: cfg.nodeLimit, emergencyMs: cfg.emergencyMs, weights: cand.weights });
    const pOpp = Runner.makeSearchPlayer(Engine, { difficulty: cfg.difficulty, nodeLimit: cfg.nodeLimit, emergencyMs: cfg.emergencyMs, weights: opp.weights });
    const players = candSeat === 1 ? { 1: pCand, 2: pOpp } : { 1: pOpp, 2: pCand };
    const { result, lines } = Runner.playGame(Engine, { rules: opening.rules, prefix: opening.prefix, players,
      maxMoves: cfg.maxMoves, maxMs: cfg.maxMs,
      meta: { opening: opening.id, candidate: cand.id, opponent: opp.id, candSeat, difficulty: cfg.difficulty, nodeLimit: cfg.nodeLimit, run: cfg.run } });
    if (jsonlOut) jsonlOut.push(...lines);
    games.push({ candSeat, result });
  }
  return games;
}

function evalTactics(tactics, weights, cfg){
  let misses = 0; const missed = [];
  for (const t of tactics){
    const m = Engine.createMatch(t.rules);
    Runner.applyPrefix(m, t.prefix, () => {});
    const p = Runner.makeSearchPlayer(Engine, { difficulty: cfg.difficulty, nodeLimit: cfg.nodeLimit, weights });
    const { move } = p(m.getSnapshot());
    if (!move || !t.expected.some(e => e.x === move.x && e.y === move.y)){ misses++; missed.push(t.id); }
  }
  return { total: tactics.length, misses, missed };
}

function codeVersion(){
  try { return require('child_process').execSync('git rev-parse HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (_){ return null; }
}

// ---------- Benchmark ----------
// opts: corpus, split, sizes[], difficulties[], nodeLimit, runs, seed, maxMoves,
// maxMs, candidate{id,weights}, pool[{id,weights}], bootstrap, maxPairs, jsonl[]
function runBenchmark(opts){
  validateCorpus(opts.corpus);
  if (opts.split === 'train') throw new Error('split=train предназначен для подбора весов, benchmark его не измеряет');
  const report = { format: 'tochki-bench-report', benchVersion: BENCH_VERSION, runnerVersion: Runner.RUNNER_VERSION,
    createdAt: new Date().toISOString(), code: { commit: codeVersion(), engineVersion: Engine.ENGINE_VERSION, botVersion: Engine.BOT_VERSION, weightsVersion: Engine.WEIGHTS_VERSION },
    corpus: { version: opts.corpus.version, seed: opts.corpus.seed, split: opts.split },
    params: { sizes: opts.sizes, difficulties: opts.difficulties, nodeLimit: opts.nodeLimit, runs: opts.runs, seed: opts.seed,
      maxMoves: opts.maxMoves, maxMs: opts.maxMs, bootstrap: opts.bootstrap, maxPairs: opts.maxPairs || null,
      difficultyParams: Object.fromEntries(opts.difficulties.map(d => [d, Engine.DIFFICULTY[d]])) },
    candidate: opts.candidate, pool: opts.pool,
    acceptance: { rule: 'lower bound of 95% pair-bootstrap CI of candidate score vs baseline > 0.5, and zero correctness errors (invalid moves / replay mismatch)' },
    configs: [], errors: [] };
  const allBaselinePairs = [];
  for (const sizeKey of opts.sizes){
    let openings = (opts.corpus.openings[sizeKey] || {})[opts.split] || [];
    if (opts.maxPairs) openings = openings.slice(0, opts.maxPairs);
    const tactics = (opts.corpus.tactics || {})[sizeKey] || [];
    for (const difficulty of opts.difficulties){
      for (const opp of opts.pool){
        const runsOut = [];
        const runPlies = opts.runPlies == null ? 2 : opts.runPlies;
        report.params.runPlies = runPlies;
        const clusters = new Map(); const uniquePositions = new Set();
        const pairScores = []; const g = { W: 0, D: 0, L: 0, truncated: 0, diff: [], nodes: [], depth: [], ms: [], games: 0 };
        for (let run = 0; run < opts.runs; run++){
          // Независимые прогоны: свой seed, свой порядок дебютов и СВОИ позиции
          // (см. derivePosition) — иначе при лимите узлов партии повторялись бы.
          const runSeed = (opts.seed + run * 7919) >>> 0;
          const rng = makeRng(runSeed);
          const order = openings.slice();
          for (let k = order.length - 1; k > 0; k--){ const j = Math.floor(rng() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
          const cfg = { difficulty, nodeLimit: opts.nodeLimit, maxMoves: opts.maxMoves, maxMs: opts.maxMs, run };
          const runPairs = [];
          for (const o of order){
            const pos = derivePosition(o, run, runSeed, runPlies);
            if (!pos){ (report.skipped = report.skipped || []).push({ sizeKey, difficulty, opponent: opp.id, opening: o.id, run, reason: 'cannot derive run position' }); continue; }
            const posKey = JSON.stringify(pos.prefix);
            let games;
            try { games = playPair(pos, opts.candidate, opp, cfg, opts.jsonl); }
            catch (e){ report.errors.push({ sizeKey, difficulty, opponent: opp.id, opening: pos.id, run, error: e.name + ': ' + e.message }); continue; }
            uniquePositions.add(posKey);
            const ckey = sizeKey + ':' + o.id;
            if (!clusters.has(ckey)) clusters.set(ckey, []);
            let pts = 0;
            for (const { candSeat, result } of games){
              const p = points(result.winner, candSeat); pts += p;
              g.games++; if (p === 1) g.W++; else if (p === 0) g.L++; else g.D++;
              if (result.truncated) g.truncated++;
              g.diff.push(result.scores[candSeat] - result.scores[3 - candSeat]);
              const st = result.stats[candSeat];
              if (st.moves){ g.nodes.push(st.nodes / st.moves); g.depth.push(st.depthSum / st.moves); }
              g.ms.push(...st.times);
            }
            runPairs.push(pts / 2);
            clusters.get(ckey).push(pts / 2);
          }
          pairScores.push(...runPairs);
          runsOut.push({ run, seed: runSeed, pairs: runPairs.length, score: mean(runPairs) });
        }
        // Интервал — кластерный bootstrap по исходным дебютам (прогоны одного
        // дебюта коррелированы и ресэмплируются вместе).
        const ci = bootstrapClusters([...clusters.values()], opts.bootstrap, opts.seed);
        const isBaseline = opp.id === 'baseline';
        // allBaselinePairs: [ключ исходного дебюта, значения] — сводный интервал
        // объединяет сложности/прогоны одного дебюта в один кластер.
        if (isBaseline) for (const [k, v] of clusters) allBaselinePairs.push([k, v]);
        report.configs.push({ sizeKey, difficulty, opponent: opp.id, pairs: pairScores.length, games: g.games,
          clusters: clusters.size, uniquePositions: uniquePositions.size,
          W: g.W, D: g.D, L: g.L, truncationRate: g.games ? g.truncated / g.games : null,
          scoreDiffMean: mean(g.diff), score: ci.mean, ci95: { lo: ci.lo, hi: ci.hi, method: 'cluster bootstrap over source openings (runs of one opening resampled together)' },
          nodesPerMove: mean(g.nodes), completedDepth: mean(g.depth),
          moveMs: { p50: quantile(g.ms, 0.5), p95: quantile(g.ms, 0.95) },
          tactics: isBaseline ? evalTactics(tactics, opts.candidate.weights, { difficulty, nodeLimit: opts.nodeLimit }) : undefined,
          runs: runsOut });
      }
    }
  }
  const merged = new Map();
  for (const [k, v] of allBaselinePairs){ if (!merged.has(k)) merged.set(k, []); merged.get(k).push(...v); }
  const overall = bootstrapClusters([...merged.values()], opts.bootstrap, opts.seed + 1);
  report.vsBaseline = { pairs: overall.n, clusters: overall.clusters, score: overall.mean,
    ci95: { lo: overall.lo, hi: overall.hi, method: 'cluster bootstrap over source openings' } };
  report.acceptance.correctnessErrors = report.errors.length;
  report.acceptance.accepted = overall.lo !== null && overall.lo > 0.5 && report.errors.length === 0;
  report.acceptance.note = 'Только отчёт: benchmark не публикует и не сохраняет веса.';
  return report;
}

function loadJson(p){ return JSON.parse(fs.readFileSync(p, 'utf8')); }

function parseArgs(argv){
  const o = { corpus: DEFAULT_CORPUS, baseline: DEFAULT_BASELINE, split: 'validation', sizes: ['small'], difficulties: ['normal'],
    nodeLimit: 1500, runs: 1, seed: 12345, maxMoves: 300, maxMs: 0, bootstrap: 2000, maxPairs: 0, out: null, jsonl: null, candidate: null, genCorpus: null };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i], v = () => argv[++i];
    if (a === '--corpus') o.corpus = v();
    else if (a === '--baseline') o.baseline = v();
    else if (a === '--split') o.split = v();
    else if (a === '--sizes') o.sizes = v().split(',');
    else if (a === '--difficulties') o.difficulties = v().split(',');
    else if (a === '--node-limit') o.nodeLimit = parseInt(v(), 10);
    else if (a === '--runs') o.runs = parseInt(v(), 10);
    else if (a === '--seed') o.seed = parseInt(v(), 10) >>> 0;
    else if (a === '--max-moves') o.maxMoves = parseInt(v(), 10);
    else if (a === '--max-ms') o.maxMs = parseInt(v(), 10);
    else if (a === '--bootstrap') o.bootstrap = parseInt(v(), 10);
    else if (a === '--max-pairs') o.maxPairs = parseInt(v(), 10);
    else if (a === '--out') o.out = v();
    else if (a === '--jsonl') o.jsonl = v();
    else if (a === '--candidate') o.candidate = v();
    else if (a === '--gen-corpus') o.genCorpus = v();
    else if (a === '--full'){ o.split = 'test'; o.sizes = ['small', 'medium']; o.difficulties = ['normal', 'strong']; o.runs = 3; o.nodeLimit = 4000; }
    else throw new Error('unknown arg ' + a);
  }
  return o;
}

function main(){
  const a = parseArgs(process.argv.slice(2));
  if (a.genCorpus){
    const c = generateCorpus(a.seed);
    validateCorpus(c);
    fs.mkdirSync(path.dirname(a.genCorpus), { recursive: true });
    fs.writeFileSync(a.genCorpus, JSON.stringify(c, null, 1) + '\n');
    console.log('corpus written:', a.genCorpus);
    return;
  }
  const baseline = loadJson(a.baseline);
  const pool = [{ id: 'baseline', weights: baseline.weights }].concat((baseline.pool || []).map(p => ({ id: p.id, weights: p.weights })));
  const candidate = a.candidate ? { id: path.basename(a.candidate), weights: loadJson(a.candidate).weights || loadJson(a.candidate) }
    : { id: 'engine-default', weights: { ...Engine.BOT_WEIGHTS } };
  const jsonl = a.jsonl ? [] : null;
  const report = runBenchmark({ corpus: loadJson(a.corpus), split: a.split, sizes: a.sizes, difficulties: a.difficulties,
    nodeLimit: a.nodeLimit, runs: a.runs, seed: a.seed, maxMoves: a.maxMoves, maxMs: a.maxMs, bootstrap: a.bootstrap,
    maxPairs: a.maxPairs, candidate, pool, jsonl });
  const text = JSON.stringify(report, null, 2) + '\n';
  if (a.out){ fs.mkdirSync(path.dirname(a.out), { recursive: true }); fs.writeFileSync(a.out, text); console.log('report written:', a.out); }
  else process.stdout.write(text);
  if (jsonl){ fs.mkdirSync(path.dirname(a.jsonl), { recursive: true }); fs.writeFileSync(a.jsonl, jsonl.join('\n') + '\n'); }
  console.error(`vsBaseline score=${report.vsBaseline.score} ci95=[${report.vsBaseline.ci95.lo}, ${report.vsBaseline.ci95.hi}] errors=${report.errors.length} accepted=${report.acceptance.accepted}`);
}

if (require.main === module) main();

module.exports = { BENCH_VERSION, makeRng, generateCorpus, validateCorpus, bootstrapPairs, quantile, playPair, evalTactics, runBenchmark, RULESETS };
