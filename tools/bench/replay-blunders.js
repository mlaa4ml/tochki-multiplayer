#!/usr/bin/env node
// tools/bench/replay-blunders.js — поиск зевков бота в сохранённых реплеях (issue #52).
//
// Использование:
//   node tools/bench/replay-blunders.js [файлы-реплеев...] [--json out.json] [--search strong|normal]
//   node tools/bench/replay-blunders.js --prefork out.json [--split regression] [--game id]
//        [--max-back 3] [--radius 2] [--min-loss 4] [--fork-cap 40] [--node-limit N]
// По умолчанию берутся tools/bench/corpus/human/*.json (экспорт «Сохранённые
// партии» из клиента: массив { name, summary, replay }).
//
// Для каждого хода бота считается по ПОЛНЫМ правилам (applyTransition):
//   threatAfter — сколько точек соперник может пленить ОДНИМ ходом сразу после
//                 хода бота (лучший ответ соперника);
//   bestThreat  — минимум этой величины по всем легальным ходам бота
//                 (лучшая достижимая защита на 1 ход);
//   lost        — сколько соперник реально пленил своим следующим ходом;
//   missedCapture — сколько бот мог пленить сам, но не пленил.
// Зевок = threatAfter > bestThreat (бот мог защититься, но не стал) или
// missedCapture > 0. С --search дополнительно запускается текущий поиск
// движка в позиции зевка, чтобы проверить, повторяет ли его бот сейчас.
//
// Режим --prefork (issue #57, S3 дорожной карты): поиск позиций «до вилки».
// От каждого взятия у бота (соперник пленил >= --min-loss точек одним ходом)
// идём НАЗАД по ходам бота (не дальше --max-back) и ищем последний ход бота,
// после которого спасение ещё существовало. Решатель «есть ли защита»:
//   loss(m) = forkLoss4 после хода бота m минус собственный захват ходом m.
//   Это 6 полуходов: ход бота m -> ответ соперника -> защита бота -> два хода
//   соперника подряд (между ними бот пасует — пессимистичная оценка за бота;
//   вместе с перебором защит это верхняя граница потери на 6 полуходов).
//   Если forkLoss4 обрывается по бюджету (--fork-cap), берётся twoMoveThreat
//   после хода (3 полухода), поле measure = 'twoMove'.
// Ходы бота перебираются в радиусе --radius от пленённых точек и от хода-взятия
// (плюс сыгранный ход). Спасение существует, если minLoss <= captured/2 и
// сыгранный ход хуже минимума хотя бы на 3 точки. Спасающие ходы — все с
// loss <= minLoss + 1. Для каждой позиции текущий поиск normal/strong с
// фиксированным nodeLimit классифицирует причину ошибки (классификация #52):
//   not-in-candidates — ни один спасающий ход не попал в корневые кандидаты;
//   width             — не попал, а корневой список заполнен до candidateCap
//                       (отрезан по ширине);
//   time              — спасающий ход в кандидатах, но итеративное углубление
//                       остановлено бюджетом до maxDepth (не исследован);
//   misjudged         — исследован до maxDepth, но оценён хуже другого хода.
// Результат дописывается (слиянием по партии и ходу) в файл --prefork,
// по умолчанию tools/bench/corpus/prefork.regression.json.
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../../gameEngine.js');

// Корпус реальных партий делится ПО ПАРТИЯМ на части dev / regression / holdout
// (issue #56). Разбиение задаёт tools/bench/corpus/human/manifest.json; партия,
// которой нет в манифесте, считается holdout (defaultSplit).
//   --split dev|regression|holdout — анализировать только партии этой части;
//   --manifest путь                — другой файл манифеста.
const CORPUS_DIR = path.join(__dirname, 'corpus', 'human');
const MANIFEST_NAME = 'manifest.json';
const SPLITS = ['dev', 'regression', 'holdout'];
const DEFAULT_SPLIT = 'holdout';
const PREFORK_FILE = path.join(__dirname, 'corpus', 'prefork.regression.json');
// Фиксированные бюджеты узлов уровней (как в S4: strong 3000, normal 300).
const PREFORK_NODE_LIMITS = { normal: 300, strong: 3000 };

function listCorpusFiles(dir){
  dir = dir || CORPUS_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== MANIFEST_NAME).sort().map(f => path.join(dir, f));
}

function parseArgs(argv){
  const out = { files: [], json: null, search: null, nodeLimit: 0, split: null, manifest: path.join(CORPUS_DIR, MANIFEST_NAME),
    prefork: null, game: null, maxBack: 5, radius: 2, minLoss: 4, forkCap: 40 };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a === '--json') out.json = argv[++i];
    else if (a === '--search') out.search = argv[++i];
    else if (a === '--node-limit') out.nodeLimit = Number(argv[++i]) || 0;
    else if (a === '--split'){
      out.split = argv[++i];
      if (!SPLITS.includes(out.split)) throw new Error(`--split: ожидается ${SPLITS.join('|')}, получено ${out.split}`);
    }
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--prefork'){
      const v = argv[i + 1];
      if (v && !v.startsWith('--')){ out.prefork = v; i++; } else out.prefork = PREFORK_FILE;
    }
    else if (a === '--game') out.game = argv[++i];
    else if (a === '--max-back') out.maxBack = Number(argv[++i]) || 3;
    else if (a === '--radius') out.radius = Number(argv[++i]) || 2;
    else if (a === '--min-loss') out.minLoss = Number(argv[++i]) || 4;
    else if (a === '--fork-cap') out.forkCap = Number(argv[++i]) || 40;
    else out.files.push(a);
  }
  if (!out.files.length) out.files = listCorpusFiles(CORPUS_DIR);
  return out;
}

function loadManifest(file){
  if (!file || !fs.existsSync(file)) return null;
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!m || !Array.isArray(m.games)) throw new Error(`манифест ${file}: нет массива games`);
  return m;
}

// Часть, к которой относится партия (file — имя или путь файла, index — номер партии в файле).
function splitOf(manifest, file, index){
  const base = path.basename(file);
  const def = (manifest && manifest.defaultSplit) || DEFAULT_SPLIT;
  const e = manifest ? manifest.games.find(g => g.file === base && g.index === index) : null;
  return e ? { split: e.split, id: e.id } : { split: def, id: null };
}

// Все партии из файлов с пометкой части; при split — только партии этой части.
function selectGames(files, manifest, split){
  const out = [];
  for (const f of files) for (const g of loadGames(f)){
    const s = splitOf(manifest, g.file, g.index);
    g.split = s.split;
    g.id = s.id || (g.file.replace(/\.json$/, '') + '#' + g.index);
    if (!split || g.split === split) out.push(g);
  }
  return out;
}

function loadGames(file){
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const arr = Array.isArray(j) ? j : [j];
  return arr.map((g, i) => ({ file: path.basename(file), index: i, name: g.name || ('#' + i), replay: g.replay || g }));
}

function nodeFromMatch(match){
  const s = match.getSnapshot();
  return E.createSearchNode(s);
}

function makeMatch(r){
  const rules = r.rules || {};
  return E.createMatch({
    sizeKey: r.board.sizeKey, firstPlayer: rules.firstPlayer, startPosition: rules.startPosition,
    targetScore: rules.targetScore, targetFillPercent: rules.targetFillPercent,
    extraTurnOnCapture: rules.extraTurnOnCapture
  });
}

// Матч, доведённый до позиции перед полуходом ply.
function matchAtPly(r, ply){
  const m = makeMatch(r);
  const moves = r.events.filter(e => e.type === 'move');
  for (let k = 0; k < ply; k++) m.applyMove(moves[k].player, moves[k].x, moves[k].y);
  return m;
}

// Лучший немедленный захват игрока player в узле (как если бы ходил он).
function bestImmediateCapture(node, player){
  const n = E.cloneSearchNode(node);
  n.current = player;
  n.gameOver = false;
  let best = 0, at = null;
  for (let y = 0; y < n.rows; y++) for (let x = 0; x < n.cols; x++){
    if (!E.isTransitionLegal(n, x, y)) continue;
    const t = E.applyTransition(n, player, x, y);
    if (!t.ok) continue;
    let g = 0;
    for (const c of t.result.gained) if (c.kind === 'captured') g++;
    if (g > best){ best = g; at = { x, y }; }
  }
  return { best, at };
}

function analyzeGame(g, opts){
  const r = g.replay;
  const rules = r.rules || {};
  const match = E.createMatch({
    sizeKey: r.board.sizeKey, firstPlayer: rules.firstPlayer, startPosition: rules.startPosition,
    targetScore: rules.targetScore, targetFillPercent: rules.targetFillPercent,
    extraTurnOnCapture: rules.extraTurnOnCapture
  });
  const moves = r.events.filter(e => e.type === 'move');
  const botSeat = (moves.find(e => e.decision) || {}).player || 2;
  const opp = botSeat === 1 ? 2 : 1;
  const rows = [];
  for (let i = 0; i < moves.length; i++){
    const mv = moves[i];
    if (mv.player === botSeat){
      const node = nodeFromMatch(match);
      const own = bestImmediateCapture(node, botSeat);
      // threatAfter для каждого легального хода бота
      let bestThreat = Infinity, bestMove = null, threatAfter = null;
      for (let y = 0; y < node.rows; y++) for (let x = 0; x < node.cols; x++){
        if (!E.isTransitionLegal(node, x, y)) continue;
        const t = E.applyTransition(node, botSeat, x, y);
        if (!t.ok) continue;
        let mine = 0;
        for (const c of t.result.gained) if (c.kind === 'captured') mine++;
        const th = t.node.gameOver ? 0 : bestImmediateCapture(t.node, opp).best;
        const net = th - mine;
        if (x === mv.x && y === mv.y) threatAfter = { th, mine, net };
        if (net < bestThreat){ bestThreat = net; bestMove = { x, y }; }
      }
      const res = match.applyMove(mv.player, mv.x, mv.y);
      const next = moves[i + 1];
      let lost = 0;
      if (next && next.player === opp){
        const before = match.getSnapshot().scores[opp];
        const r2 = E.createSearchNode(match.getSnapshot());
        const t2 = E.applyTransition(r2, opp, next.x, next.y);
        if (t2.ok) lost = t2.node.scores[opp] - before;
      }
      const row = {
        ply: i, move: { x: mv.x, y: mv.y }, decision: mv.decision || null,
        threatAfter: threatAfter ? threatAfter.th : null, gainedNow: threatAfter ? threatAfter.mine : 0,
        bestNet: bestThreat, bestMove, lost, missedCapture: Math.max(0, own.best - (threatAfter ? threatAfter.mine : 0)),
        captureAt: own.at
      };
      row.blunder = !!threatAfter && (threatAfter.net > bestThreat);
      if (opts.search && row.blunder){
        const m2 = E.createMatch({
          sizeKey: r.board.sizeKey, firstPlayer: rules.firstPlayer, startPosition: rules.startPosition,
          targetScore: rules.targetScore, targetFillPercent: rules.targetFillPercent,
          extraTurnOnCapture: rules.extraTurnOnCapture
        });
        for (let k = 0; k < i; k++) m2.applyMove(moves[k].player, moves[k].x, moves[k].y);
        const so = opts.nodeLimit ? { nodeLimit: opts.nodeLimit } : {};
        const s = m2.botSearch(opts.search, null, so);
        row.nowMove = s.move;
        const nd = nodeFromMatch(m2);
        const t = s.move ? E.applyTransition(nd, botSeat, s.move.x, s.move.y) : null;
        row.nowThreat = t && t.ok ? bestImmediateCapture(t.node, opp).best : null;
      }
      rows.push(row);
      if (!res || res.ok === false) break;
    } else {
      match.applyMove(mv.player, mv.x, mv.y);
    }
  }
  const snap = match.getSnapshot();
  return { file: g.file, index: g.index, name: g.name, size: r.board.sizeKey, botSeat, scores: snap.scores, moves: rows };
}

// ---------- issue #57: позиции «до вилки» ----------

function countCaptured(t){ let n = 0; for (const c of t.result.gained) if (c.kind === 'captured') n++; return n; }

// Решатель «есть ли защита»: потеря бота после его хода (x,y) в node.
// Возвращает { loss, measure } или null, если ход нелегален.
function preforkLoss(node, mover, x, y, cap){
  if (!E.isTransitionLegal(node, x, y)) return null;
  const t = E.applyTransition(node, mover, x, y);
  if (!t.ok) return null;
  if (t.node.gameOver){
    return { loss: t.node.winner && t.node.winner !== mover ? 100 : 0, measure: 'terminal' };
  }
  if (t.node.current === mover) return { loss: 0, measure: 'extra-turn' };
  const opp = mover === 1 ? 2 : 1;
  const mine = countCaptured(t);
  const ctx = { calls: 0, cap: cap || 40, thr: 3, aborted: false };
  const r = E.twoMoveThreat.forkLoss4(t.node, opp, mover, ctx);
  if (r) return { loss: Math.max(0, r.loss - mine), measure: 'forkLoss4' };
  return { loss: Math.max(0, E.twoMoveThreat(t.node, opp) - mine), measure: 'twoMove' };
}

// Легальные клетки в радиусе R от заданных клеток.
function cellsNear(node, cells, R){
  const seen = new Set(), out = [];
  for (const c of cells) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++){
    const x = c.x + dx, y = c.y + dy;
    if (x < 0 || y < 0 || x >= node.cols || y >= node.rows) continue;
    const k = y * node.cols + x;
    if (seen.has(k)) continue;
    seen.add(k);
    if (E.isTransitionLegal(node, x, y)) out.push({ x, y });
  }
  return out;
}

// Причина, по которой поиск уровня не выбрал спасающий ход.
function classifyMiss(trace, rescue){
  const inSet = (c) => rescue.some(r => r.x === c.x && r.y === c.y);
  const cands = (trace && trace.candidates) || [];
  if (!cands.some(inSet)){
    const cap = trace && trace.params ? trace.params.candidateCap : null;
    return cap && cands.length >= cap ? 'width' : 'not-in-candidates';
  }
  const maxDepth = trace && trace.params ? trace.params.maxDepth : null;
  if (trace && trace.stopReason !== 'max-depth' && maxDepth && trace.completedDepth < maxDepth) return 'time';
  return 'misjudged';
}

// Ход текущего поиска уровня level в позиции перед полуходом ply и его разбор.
function evalLevel(r, ply, level, nodeLimit, rescue){
  const m = matchAtPly(r, ply);
  const s = m.botSearch(level, null, { nodeLimit });
  const move = s && s.move ? { x: s.move.x, y: s.move.y } : null;
  const saved = !!move && rescue.some(c => c.x === move.x && c.y === move.y);
  return { nodeLimit, move, saved, cause: saved ? null : classifyMiss(s && s.trace, rescue) };
}

function analyzePreFork(g, opts){
  const r = g.replay;
  const moves = r.events.filter(e => e.type === 'move');
  const botSeat = (moves.find(e => e.decision) || {}).player || 2;
  const opp = botSeat === 1 ? 2 : 1;
  const match = makeMatch(r);
  const nodes = [];
  for (let i = 0; i < moves.length; i++){
    nodes.push(nodeFromMatch(match));
    const res = match.applyMove(moves[i].player, moves[i].x, moves[i].y);
    if (!res || res.ok === false) break;
  }
  // Взятия у бота.
  const captures = [];
  for (let i = 0; i < nodes.length; i++){
    if (moves[i].player !== opp) continue;
    const t = E.applyTransition(nodes[i], opp, moves[i].x, moves[i].y);
    if (!t.ok) continue;
    const cells = t.result.gained.filter(c => c.kind === 'captured' && Number.isInteger(c.x) && Number.isInteger(c.y)).map(c => ({ x: c.x, y: c.y }));
    const n = countCaptured(t);
    if (n >= opts.minLoss) captures.push({ ply: i, count: n, cells: cells.concat([{ x: moves[i].x, y: moves[i].y }]) });
  }
  const positions = [];
  const done = new Set();
  for (const cap of captures){
    let back = 0;
    for (let j = cap.ply - 1; j >= 0 && back < opts.maxBack; j--){
      if (moves[j].player !== botSeat) continue;
      back++;
      const node = nodes[j];
      if (node.current !== botSeat) continue;
      const played = { x: moves[j].x, y: moves[j].y };
      const pl = preforkLoss(node, botSeat, played.x, played.y, opts.forkCap);
      if (!pl) continue;
      const evals = [];
      for (const c of cellsNear(node, cap.cells, opts.radius)){
        const l = (c.x === played.x && c.y === played.y) ? pl : preforkLoss(node, botSeat, c.x, c.y, opts.forkCap);
        if (l) evals.push({ x: c.x, y: c.y, loss: l.loss, measure: l.measure });
      }
      if (!evals.length) continue;
      const minLoss = Math.min(...evals.map(e => e.loss));
      if (minLoss <= Math.floor(cap.count / 2) && pl.loss - minLoss >= 3){
        if (done.has(j)) break;
        done.add(j);
        const rescue = evals.filter(e => e.loss <= minLoss + 1);
        const pos = { id: g.id, file: g.file, index: g.index, split: g.split, ply: j, botSeat,
          captureAt: cap.ply, captured: cap.count, played, playedLoss: pl.loss, playedMeasure: pl.measure,
          minLoss, rescue, levels: {} };
        for (const level of Object.keys(PREFORK_NODE_LIMITS)){
          const nl = opts.nodeLimit || PREFORK_NODE_LIMITS[level];
          pos.levels[level] = evalLevel(r, j, level, nl, rescue);
        }
        positions.push(pos);
        break; // последний ход бота, после которого спасение существовало
      }
    }
  }
  return { id: g.id, captures: captures.map(c => ({ ply: c.ply, count: c.count })), positions };
}

function preforkKey(p){ return `${p.file}#${p.index}#${p.ply}`; }

function summarizePrefork(positions){
  const out = {};
  for (const level of Object.keys(PREFORK_NODE_LIMITS)){
    const ps = positions.filter(p => p.levels && p.levels[level]);
    const saved = ps.filter(p => p.levels[level].saved).length;
    const causes = {};
    for (const p of ps){ const c = p.levels[level].cause; if (c) causes[c] = (causes[c] || 0) + 1; }
    out[level] = { positions: ps.length, saved, rate: ps.length ? +(saved / ps.length).toFixed(3) : 0, causes };
  }
  return out;
}

function runPrefork(opts){
  const split = opts.split || 'regression';
  let games = selectGames(opts.files, loadManifest(opts.manifest), split);
  if (opts.game) games = games.filter(g => g.id === opts.game);
  let data = { format: 'tochki-prefork-regression', version: 1, positions: [] };
  if (fs.existsSync(opts.prefork)) data = JSON.parse(fs.readFileSync(opts.prefork, 'utf8'));
  data.description = 'Позиции «до вилки» (issue #57): последний ход бота перед взятием, после которого спасение ещё существовало. rescue — спасающие ходы (loss <= minLoss+1), levels — ход текущего поиска при фиксированном nodeLimit и причина ошибки. Генерируется: node tools/bench/replay-blunders.js --prefork';
  data.params = { split, maxBack: opts.maxBack, radius: opts.radius, minLoss: opts.minLoss, forkCap: opts.forkCap,
    nodeLimits: opts.nodeLimit ? { normal: opts.nodeLimit, strong: opts.nodeLimit } : PREFORK_NODE_LIMITS };
  const byKey = new Map(data.positions.map(p => [preforkKey(p), p]));
  for (const g of games){
    const t0 = Date.now();
    const a = analyzePreFork(g, opts);
    console.log(`${g.id}: взятий ${a.captures.length}, позиций «до вилки» ${a.positions.length} (${Date.now() - t0} мс)`);
    for (const p of a.positions){
      byKey.set(preforkKey(p), p);
      const lv = Object.keys(p.levels).map(l => `${l}: (${p.levels[l].move ? p.levels[l].move.x + ',' + p.levels[l].move.y : '-'}) ${p.levels[l].saved ? 'спас' : p.levels[l].cause}`).join('; ');
      console.log(`  ход ${p.ply} (взятие ${p.captured} на ходу ${p.captureAt}): сыграно (${p.played.x},${p.played.y}) потеря ${p.playedLoss}, минимум ${p.minLoss}, спасающих ${p.rescue.length} | ${lv}`);
    }
  }
  data.positions = [...byKey.values()].sort((a, b) => preforkKey(a) < preforkKey(b) ? -1 : 1);
  data.baseline = summarizePrefork(data.positions);
  fs.writeFileSync(opts.prefork, JSON.stringify(data, null, 1) + '\n');
  console.log('База:', JSON.stringify(data.baseline));
  return data;
}

function main(){
  const opts = parseArgs(process.argv.slice(2));
  if (opts.prefork){ runPrefork(opts); return; }
  const report = [];
  const games = selectGames(opts.files, loadManifest(opts.manifest), opts.split);
  if (opts.split) console.log(`часть ${opts.split}: партий ${games.length} (${games.map(g => g.id).join(', ')})`);
  for (const g of games){
    const a = analyzeGame(g, opts);
    a.id = g.id; a.split = g.split;
    report.push(a);
  }
  let total = 0, blunders = 0, missed = 0, lost = 0, nowFixed = 0, nowChecked = 0;
  for (const g of report){
    const bl = g.moves.filter(m => m.blunder);
    total += g.moves.length; blunders += bl.length;
    missed += g.moves.filter(m => m.missedCapture > 0).length;
    lost += g.moves.reduce((s, m) => s + m.lost, 0);
    console.log(`${g.file}#${g.index} ${g.size} счёт ${g.scores[1]}:${g.scores[2]} — ходов бота ${g.moves.length}, зевков ${bl.length}`);
    for (const m of bl){
      let line = `  ход ${m.ply}: (${m.move.x},${m.move.y}) угроза после ${m.threatAfter}, лучше ${m.bestNet} ходом (${m.bestMove.x},${m.bestMove.y}), отдал ${m.lost}`;
      if (m.nowMove !== undefined){
        nowChecked++;
        if (m.nowThreat !== null && m.nowThreat - 0 <= m.bestNet + 0) nowFixed++;
        line += ` | сейчас: (${m.nowMove ? m.nowMove.x + ',' + m.nowMove.y : '-'}) угроза ${m.nowThreat}`;
      }
      console.log(line);
    }
  }
  console.log(`ИТОГО: ходов бота ${total}, зевков на 1 ход ${blunders}, упущенных захватов ${missed}, отдано точек сразу ${lost}`);
  if (nowChecked) console.log(`Текущий поиск исправляет ${nowFixed}/${nowChecked} зевков`);
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(report, null, 2));
}

if (require.main === module) main();
module.exports = { analyzeGame, loadGames, bestImmediateCapture, parseArgs, listCorpusFiles, loadManifest, splitOf, selectGames, SPLITS, DEFAULT_SPLIT, CORPUS_DIR,
  makeMatch, matchAtPly, preforkLoss, cellsNear, classifyMiss, evalLevel, analyzePreFork, runPrefork, summarizePrefork,
  PREFORK_FILE, PREFORK_NODE_LIMITS };
