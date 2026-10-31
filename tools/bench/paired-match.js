#!/usr/bin/env node
// tools/bench/paired-match.js
//
// S4 (issue #58, дорожная карта docs/MONITOR_ROADMAP.md): измерительная база —
// парный матч «кандидат против базы».
//
// Почему не benchmark.js: на корпусе fill30 8–9 партий из 12 кончаются 0:0,
// поэтому все кандидаты получают ровно 0.5. Здесь условия другие:
//   * полное поле, правила fill 64%, без порога очков, старт «крест»
//     (как в реальных партиях корпуса);
//   * дебюты — префиксы реальных партий частей dev/regression манифеста
//     tools/bench/corpus/human/manifest.json (holdout НЕ используется);
//   * каждая пара — две партии из одной позиции со сменой сторон;
//   * по умолчанию 50 пар (100 партий).
// Вывод: разность очков, доля партий не 0:0 и доля нерешённых вничью,
// ci95 доли очков кандидата (критерий проекта ci95.lo > 0.5), p95 времени
// хода и узлы, тактическая метрика S3 (#57: доля позиций «до вилки» из
// tools/bench/corpus/prefork.regression.json, где ход стороны — спасающий).
//
// Команды:
//   node tools/bench/paired-match.js --sensitivity --out r.json
//       кандидат strong/3000 узлов против normal/300: тест обязан их различить;
//   node tools/bench/paired-match.js --candidate strong:3000:cand.json --base strong:3000 --out r.json
//       сторона = уровень:лимитУзлов[:файл весов];
//   --pairs N (50) --min-ply K (4) --ply-step S (4) — набор дебютов;
//   --from A --to B — сыграть только пары [A, B) (шардирование под лимиты);
//   --merge a.json b.json ... --out r.json — склеить шарды и пересчитать сводку;
//   --no-tactics — не считать метрику S3; --max-moves N; --seed N; --resamples N.
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../../gameEngine.js');
const Runner = require('./runner.js');
const B = require('./benchmark.js');
const RB = require('./replay-blunders.js');

const PAIRED_VERSION = 1;
const MATCH_RULES = { targetScore: 0, targetFillPercent: 64, startPosition: 'cross', extraTurnOnCapture: false, undoAllowed: false };
const PLAY_SPLITS = ['dev', 'regression'];
const SENSITIVITY = { candidate: { difficulty: 'strong', nodeLimit: 3000 }, base: { difficulty: 'normal', nodeLimit: 300 } };

function parseSide(s){
  const parts = String(s).split(':');
  const side = { difficulty: parts[0], nodeLimit: Number(parts[1]) || 0 };
  if (!E.DIFFICULTY[side.difficulty]) throw new Error('неизвестный уровень: ' + side.difficulty);
  if (parts[2]) side.weightsFile = parts.slice(2).join(':');
  return side;
}

function loadWeights(side){
  if (!side.weightsFile) return side;
  const j = JSON.parse(fs.readFileSync(side.weightsFile, 'utf8'));
  side.weights = Object.assign({}, E.BOT_WEIGHTS, j.weights || j);
  return side;
}

function sideLabel(s){ return `${s.difficulty}/${s.nodeLimit}${s.weightsFile ? ':' + path.basename(s.weightsFile) : ''}`; }

function parseArgs(argv){
  const o = { candidate: null, base: null, sensitivity: false, pairs: 50, minPly: 4, plyStep: 4, from: 0, to: Infinity,
    maxMoves: 1000, seed: 58, resamples: 2000, tactics: true, out: null, merge: null,
    manifest: path.join(RB.CORPUS_DIR, 'manifest.json'), corpusDir: RB.CORPUS_DIR, quiet: false };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a === '--candidate') o.candidate = parseSide(argv[++i]);
    else if (a === '--base') o.base = parseSide(argv[++i]);
    else if (a === '--sensitivity') o.sensitivity = true;
    else if (a === '--pairs') o.pairs = Number(argv[++i]);
    else if (a === '--min-ply') o.minPly = Number(argv[++i]);
    else if (a === '--ply-step') o.plyStep = Number(argv[++i]);
    else if (a === '--from') o.from = Number(argv[++i]);
    else if (a === '--to') o.to = Number(argv[++i]);
    else if (a === '--max-moves') o.maxMoves = Number(argv[++i]);
    else if (a === '--seed') o.seed = Number(argv[++i]);
    else if (a === '--resamples') o.resamples = Number(argv[++i]);
    else if (a === '--no-tactics') o.tactics = false;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--manifest') o.manifest = argv[++i];
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--merge'){ o.merge = []; while (argv[i + 1] && !argv[i + 1].startsWith('--')) o.merge.push(argv[++i]); }
    else throw new Error('неизвестный параметр: ' + a);
  }
  if (o.sensitivity || (!o.candidate && !o.base)){
    o.candidate = o.candidate || Object.assign({}, SENSITIVITY.candidate);
    o.base = o.base || Object.assign({}, SENSITIVITY.base);
    if (!argv.includes('--candidate') && !argv.includes('--base')) o.sensitivity = true;
  }
  if (!o.candidate || !o.base) throw new Error('нужны обе стороны: --candidate и --base');
  return o;
}

// Дебюты: префиксы реальных партий dev/regression длиной minPly + plyStep*k.
// Партии берутся по кругу, так что разные пары — разные позиции.
function buildOpenings(opts){
  const manifest = RB.loadManifest(opts.manifest);
  const games = RB.selectGames(RB.listCorpusFiles(opts.corpusDir), manifest, null)
    .filter(g => PLAY_SPLITS.includes(g.split));
  if (!games.length) throw new Error('нет партий dev/regression в корпусе');
  const out = [];
  const maxTries = opts.pairs * 20 + games.length * 50;
  for (let k = 0; out.length < opts.pairs && k < maxTries; k++){
    const g = games[k % games.length];
    const ply = opts.minPly + opts.plyStep * Math.floor(k / games.length);
    const r = g.replay;
    const moves = r.events.filter(e => e.type === 'move');
    if (ply >= moves.length - 2) continue;
    const rules = Object.assign({ sizeKey: r.board.sizeKey, firstPlayer: (r.rules && r.rules.firstPlayer) || 2 }, MATCH_RULES);
    const prefix = moves.slice(0, ply).map(m => ({ x: m.x, y: m.y, seat: m.player }));
    try { Runner.applyPrefix(E.createMatch(rules), prefix, () => {}); } catch (e){ continue; }
    out.push({ id: `${g.id}@${ply}`, game: g.id, split: g.split, size: r.board.sizeKey, ply, rules, prefix });
  }
  if (out.length < opts.pairs) throw new Error(`набралось только ${out.length} дебютов из ${opts.pairs}`);
  return out;
}

function makePlayer(side){
  return Runner.makeSearchPlayer(E, { difficulty: side.difficulty, nodeLimit: side.nodeLimit, weights: side.weights });
}

function playOne(o, cand, base, candSeat, opts){
  const players = {}; players[candSeat] = makePlayer(cand); players[3 - candSeat] = makePlayer(base);
  const { result, lines } = Runner.playGame(E, { rules: o.rules, prefix: o.prefix, players, maxMoves: opts.maxMoves });
  const per = { 1: { ms: [], nodes: [] }, 2: { ms: [], nodes: [] } };
  for (const l of lines){
    const r = JSON.parse(l);
    if (r.type !== 'move') continue;
    per[r.seat].ms.push(Math.round(r.ms));
    per[r.seat].nodes.push(r.nodes || 0);
  }
  const cs = result.scores[candSeat], bs = result.scores[3 - candSeat];
  return { candSeat, end: result.end, scores: result.scores, candScore: cs, baseScore: bs,
    points: cs > bs ? 1 : (cs < bs ? 0 : 0.5), moves: result.moves,
    cand: per[candSeat], base: per[3 - candSeat] };
}

function playPair(o, cand, base, opts){
  return { id: o.id, game: o.game, split: o.split, size: o.size, ply: o.ply,
    games: [playOne(o, cand, base, 1, opts), playOne(o, cand, base, 2, opts)] };
}

// Тактическая метрика S3 (#57): позиции «до вилки», ход стороны с её
// уровнем/бюджетом/весами (тот же вызов поиска, что в партиях).
function tacticalMetric(side, file){
  file = file || RB.PREFORK_FILE;
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cache = new Map();
  const items = [];
  for (const p of data.positions || []){
    if (p.split === 'holdout') continue;
    const key = p.file;
    if (!cache.has(key)) cache.set(key, RB.loadGames(path.join(RB.CORPUS_DIR, p.file)));
    const g = cache.get(key)[p.index];
    if (!g) continue;
    const snap = RB.matchAtPly(g.replay, p.ply).getSnapshot();
    const out = makePlayer(side)(snap);
    const mv = out && out.move;
    const saved = !!mv && p.rescue.some(c => c.x === mv.x && c.y === mv.y);
    items.push({ id: `${p.id || p.file}#${p.ply}`, move: mv ? { x: mv.x, y: mv.y } : null, saved });
  }
  const saved = items.filter(i => i.saved).length;
  return { positions: items.length, saved, rate: items.length ? +(saved / items.length).toFixed(3) : 0, items };
}

function sideStats(games, key){
  const ms = [].concat(...games.map(g => g[key].ms));
  const nodes = [].concat(...games.map(g => g[key].nodes));
  return { moves: ms.length, msP50: B.quantile(ms, 0.5), msP95: B.quantile(ms, 0.95),
    nodesMean: nodes.length ? Math.round(nodes.reduce((a, b) => a + b, 0) / nodes.length) : null,
    nodesP95: B.quantile(nodes, 0.95) };
}

function r3(v){ return v === null || v === undefined ? null : +v.toFixed(3); }

function summarize(pairs, opts){
  const games = [].concat(...pairs.map(p => p.games));
  const pairPoints = pairs.map(p => (p.games[0].points + p.games[1].points) / 2);
  const ci = B.bootstrapPairs(pairPoints, opts.resamples, opts.seed);
  const byGame = new Map();
  pairs.forEach((p, i) => { if (!byGame.has(p.game)) byGame.set(p.game, []); byGame.get(p.game).push(pairPoints[i]); });
  const ciCl = B.bootstrapClusters([...byGame.values()], opts.resamples, opts.seed);
  const n = games.length || 1;
  const diffs = games.map(g => g.candScore - g.baseScore);
  const s = {
    pairs: pairs.length, games: games.length,
    wins: games.filter(g => g.points === 1).length, draws: games.filter(g => g.points === 0.5).length,
    losses: games.filter(g => g.points === 0).length,
    score: r3(ci.mean),
    scoreDiffMean: r3(diffs.reduce((a, b) => a + b, 0) / n),
    candPointsMean: r3(games.reduce((a, g) => a + g.candScore, 0) / n),
    basePointsMean: r3(games.reduce((a, g) => a + g.baseScore, 0) / n),
    nonZeroShare: r3(games.filter(g => g.scores[1] !== 0 || g.scores[2] !== 0).length / n),
    decisiveShare: r3(games.filter(g => g.points !== 0.5).length / n),
    truncated: games.filter(g => g.end && g.end.startsWith('truncated')).length,
    ci95: { lo: r3(ci.lo), hi: r3(ci.hi), resamples: ci.resamples, unit: 'pair' },
    ci95ByGame: { lo: r3(ciCl.lo), hi: r3(ciCl.hi), clusters: ciCl.clusters, unit: 'source-game (справочно)' },
    candidateBetter: ci.lo !== null && ci.lo > 0.5,
    timing: { candidate: sideStats(games, 'cand'), base: sideStats(games, 'base') }
  };
  return s;
}

function run(opts){
  loadWeights(opts.candidate); loadWeights(opts.base);
  const openings = buildOpenings(opts);
  const from = Math.max(0, opts.from), to = Math.min(openings.length, opts.to);
  const pairs = [];
  const t0 = Date.now();
  for (let i = from; i < to; i++){
    const p = playPair(openings[i], opts.candidate, opts.base, opts);
    p.index = i;
    pairs.push(p);
    if (!opts.quiet) console.log(`пара ${i} ${p.id}: ${p.games.map(g => `${g.candScore}:${g.baseScore}`).join(' / ')} (${Date.now() - t0} мс)`);
  }
  return finish({ pairs, opts, tactics: opts.tactics ? {
    candidate: tacticalMetric(opts.candidate), base: tacticalMetric(opts.base) } : null, ms: Date.now() - t0 });
}

function stripSide(s){ const o = Object.assign({}, s); delete o.weights; return o; }

function finish({ pairs, opts, tactics, ms }){
  const summary = summarize(pairs, opts);
  const report = {
    format: 'tochki-paired-match', version: PAIRED_VERSION,
    engineVersion: E.ENGINE_VERSION, botVersion: E.BOT_VERSION, weightsVersion: E.WEIGHTS_VERSION,
    params: { candidate: stripSide(opts.candidate), base: stripSide(opts.base), rules: MATCH_RULES, splits: PLAY_SPLITS,
      pairsRequested: opts.pairs, minPly: opts.minPly, plyStep: opts.plyStep, maxMoves: opts.maxMoves,
      seed: opts.seed, resamples: opts.resamples, sensitivity: !!opts.sensitivity },
    summary, tactics,
    sensitivity: opts.sensitivity ? { passed: summary.candidateBetter, rule: 'strong/3000 против normal/300: ci95.lo > 0.5' } : undefined,
    elapsedMs: ms, pairs
  };
  return report;
}

function merge(files, opts){
  const reps = files.map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
  const first = reps[0];
  const seen = new Map();
  for (const r of reps) for (const p of r.pairs) seen.set(p.index !== undefined ? p.index : p.id, p);
  const pairs = [...seen.values()].sort((a, b) => (a.index || 0) - (b.index || 0));
  const o = Object.assign({}, opts, { candidate: first.params.candidate, base: first.params.base,
    pairs: first.params.pairsRequested, minPly: first.params.minPly, plyStep: first.params.plyStep,
    maxMoves: first.params.maxMoves, sensitivity: first.params.sensitivity });
  const tactics = reps.map(r => r.tactics).find(t => t) || null;
  return finish({ pairs, opts: o, tactics, ms: reps.reduce((a, r) => a + (r.elapsedMs || 0), 0) });
}

function printSummary(rep){
  const s = rep.summary;
  console.log(`кандидат ${sideLabel(rep.params.candidate)} против базы ${sideLabel(rep.params.base)}: пар ${s.pairs}, партий ${s.games}`);
  console.log(`  +${s.wins} =${s.draws} -${s.losses}; доля очков ${s.score}, ci95 [${s.ci95.lo}, ${s.ci95.hi}] → ${s.candidateBetter ? 'кандидат лучше (ci95.lo > 0.5)' : 'разница не доказана'}`);
  console.log(`  разность очков ${s.scoreDiffMean} (кандидат ${s.candPointsMean}, база ${s.basePointsMean}); не 0:0 — ${s.nonZeroShare}, решительных (не ничья) — ${s.decisiveShare}; обрезано ${s.truncated}`);
  const t = s.timing;
  console.log(`  ход p95: кандидат ${t.candidate.msP95} мс / ${t.candidate.nodesP95} узлов (ср. ${t.candidate.nodesMean}), база ${t.base.msP95} мс / ${t.base.nodesP95} узлов (ср. ${t.base.nodesMean})`);
  if (rep.tactics) console.log(`  S3 «до вилки»: кандидат ${rep.tactics.candidate && rep.tactics.candidate.saved}/${rep.tactics.candidate && rep.tactics.candidate.positions}, база ${rep.tactics.base && rep.tactics.base.saved}/${rep.tactics.base && rep.tactics.base.positions}`);
  if (rep.sensitivity) console.log(`  чувствительность: ${rep.sensitivity.passed ? 'ПОДТВЕРЖДЕНА' : 'НЕ подтверждена'}`);
}

function main(){
  const opts = parseArgs(process.argv.slice(2));
  const rep = opts.merge ? merge(opts.merge, opts) : run(opts);
  printSummary(rep);
  if (opts.out){ fs.mkdirSync(path.dirname(opts.out), { recursive: true }); fs.writeFileSync(opts.out, JSON.stringify(rep) + '\n'); }
  if (rep.sensitivity && !rep.sensitivity.passed && rep.summary.pairs >= 50) process.exitCode = 2;
}

if (require.main === module) main();
module.exports = { PAIRED_VERSION, MATCH_RULES, PLAY_SPLITS, SENSITIVITY, parseArgs, parseSide, buildOpenings, playPair,
  tacticalMetric, summarize, run, merge };
