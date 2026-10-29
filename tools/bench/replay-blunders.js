#!/usr/bin/env node
// tools/bench/replay-blunders.js — поиск зевков бота в сохранённых реплеях (issue #52).
//
// Использование:
//   node tools/bench/replay-blunders.js [файлы-реплеев...] [--json out.json] [--search strong|normal]
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

function listCorpusFiles(dir){
  dir = dir || CORPUS_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== MANIFEST_NAME).sort().map(f => path.join(dir, f));
}

function parseArgs(argv){
  const out = { files: [], json: null, search: null, nodeLimit: 0, split: null, manifest: path.join(CORPUS_DIR, MANIFEST_NAME) };
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

function main(){
  const opts = parseArgs(process.argv.slice(2));
  const report = [];
  for (const f of opts.files) for (const g of loadGames(f)) report.push(analyzeGame(g, opts));
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
module.exports = { analyzeGame, loadGames, bestImmediateCapture };
