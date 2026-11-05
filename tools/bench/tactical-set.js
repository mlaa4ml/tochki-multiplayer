#!/usr/bin/env node
// tools/bench/tactical-set.js — тактический набор «найдёт ли бот спасение» (issue #81).
//
// Набор строится из реальных партий против человека (tools/bench/corpus/human/*.json
// и любые файлы реплеев, переданные аргументами) логикой режима --prefork из
// replay-blunders.js (#57). Позиция попадает в набор, если перед крупным взятием
// у бота (>= --min-loss точек) был ход бота, после которого спасение ещё
// существовало (forkLoss4, 6 полуходов). rescue[] — спасающие ходы.
//
// Использование:
//   node tools/bench/tactical-set.js --build [--min-loss 4] [--max-back 8] [файлы...]
//        -> tools/bench/corpus/tactical.v1.json (все части корпуса: dev/regression/holdout)
//   node tools/bench/tactical-set.js [--node-limit 3000] [--configs base,static,root,...]
//        [--json tools/bench/reports/tactical-81.json]
//        -> для каждой конфигурации арбитра: сколько позиций набора решено
//           (ход бота входит в rescue[]).
//
// Конфигурации (арбитр arbiter.js, strong, фиксированный nodeLimit):
//   base         — monitor:false (ровно searchMove);
//   static       — монитор #77: подмена хода по evaluateStatic;
//   root         — #81: спасения решателя подаются в корень повторного поиска;
//   static-large — static + ранняя тревога cost<=3 для групп >= 6;
//   root-large   — root + ранняя тревога cost<=3 для групп >= 6.
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../../gameEngine.js');
const A = require('../../arbiter.js');
const RB = require('./replay-blunders.js');

const SET_FILE = path.join(__dirname, 'corpus', 'tactical.v1.json');

const CONFIGS = {
  base: { monitor: false },
  static: { monitor: true, arbiter: { rescueMode: 'static' } },
  root: { monitor: true, arbiter: { rescueMode: 'root' } },
  'static-large': { monitor: true, arbiter: { rescueMode: 'static', alarmCostLarge: 3, largeGroupSize: 6 } },
  'root-large': { monitor: true, arbiter: { rescueMode: 'root', alarmCostLarge: 3, largeGroupSize: 6 } }
};

function parseArgs(argv){
  const o = { build: false, files: [], minLoss: 4, maxBack: 8, radius: 1, forkCap: 1e6, nodeLimit: 3000,
    configs: Object.keys(CONFIGS), json: null, set: SET_FILE, level: 'strong', limit: 0 };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a === '--build') o.build = true;
    else if (a === '--min-loss') o.minLoss = Number(argv[++i]) || 4;
    else if (a === '--max-back') o.maxBack = Number(argv[++i]) || 8;
    else if (a === '--radius') o.radius = Number(argv[++i]) || 1;
    else if (a === '--fork-cap') o.forkCap = Number(argv[++i]) || 1e6;
    else if (a === '--node-limit') o.nodeLimit = Number(argv[++i]) || 3000;
    else if (a === '--configs') o.configs = argv[++i].split(',').filter(Boolean);
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--set') o.set = argv[++i];
    else if (a === '--level') o.level = argv[++i];
    else if (a === '--limit') o.limit = Number(argv[++i]) || 0;
    else o.files.push(a);
  }
  if (!o.files.length) o.files = RB.listCorpusFiles();
  for (const c of o.configs) if (!CONFIGS[c]) throw new Error('неизвестная конфигурация ' + c);
  return o;
}

// Построение набора: позиции «до вилки» из ВСЕХ партий (без фильтра по части).
function buildSet(o){
  const games = RB.selectGames(o.files, RB.loadManifest(path.join(RB.CORPUS_DIR, 'manifest.json')), null);
  const positions = [];
  for (const g of games){
    const t0 = Date.now();
    let a;
    try { a = RB.analyzePreFork(g, { minLoss: o.minLoss, maxBack: o.maxBack, radius: o.radius, forkCap: o.forkCap, nodeLimit: 0 }); }
    catch (e){ console.log(`${g.id}: ошибка ${e.message}`); continue; }
    console.log(`${g.id}: взятий ${a.captures.length}, позиций ${a.positions.length} (${Date.now() - t0} мс)`);
    for (const p of a.positions){
      // Реплей в набор не копируется: позиция восстанавливается по file/index/ply.
      positions.push({ id: p.id + '@' + p.ply, game: p.id, file: p.file, index: p.index, split: p.split, ply: p.ply,
        botSeat: p.botSeat, captureAt: p.captureAt, captured: p.captured, played: p.played, playedLoss: p.playedLoss,
        minLoss: p.minLoss, rescue: p.rescue.map(r => ({ x: r.x, y: r.y, loss: r.loss })) });
    }
  }
    // Слияние с уже построенным набором по id: набор можно собирать по одному
  // файлу реплеев за запуск (forkLoss4 дорогой, лимит времени команды).
  if (fs.existsSync(o.set)){
    const old = JSON.parse(fs.readFileSync(o.set, 'utf8'));
    const ids = new Set(positions.map(p => p.id));
    for (const p of (old.positions || [])) if (!ids.has(p.id)) positions.push(p);
    positions.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  const data = { format: 'tochki-tactical-set', version: 1,
    description: 'Тактический набор #81: позиции из партий против человека, где перед крупным взятием у бота спасение ещё существовало (forkLoss4, 6 полуходов). Решено — ход бота входит в rescue. Генерируется: node tools/bench/tactical-set.js --build',
    params: { minLoss: o.minLoss, maxBack: o.maxBack, radius: o.radius, forkCap: o.forkCap, files: o.files.map(f => path.basename(f)) },
    positions };
  fs.writeFileSync(o.set, JSON.stringify(data, null, 1) + '\n');
  console.log(`набор: ${positions.length} позиций -> ${o.set}`);
  return data;
}

function findReplay(files, file, index){
  const f = files.find(x => path.basename(x) === file);
  if (!f) return null;
  const g = RB.loadGames(f)[index];
  return g ? g.replay : null;
}

// Ход арбитра конфигурации cfg в позиции p.
function moveAt(replay, p, cfg, o){
  const m = RB.matchAtPly(replay, p.ply);
  const s = m.getSnapshot();
  const st = { stone: s.stone, dead: s.dead, territory: s.territory };
  const opts = Object.assign({ nodeLimit: o.nodeLimit, stonesPlacedTotal: s.stonesPlacedTotal, gameOver: s.gameOver, rules: s.rules },
    { monitor: cfg.monitor, arbiter: cfg.arbiter });
  const t0 = Date.now();
  const r = A.arbiterMove(st, s.rows, s.cols, p.botSeat, E.DIFFICULTY[o.level], null, opts);
  const ms = Date.now() - t0;
  const mv = r.move ? { x: r.move.x, y: r.move.y } : null;
  const ar = r.trace && r.trace.arbiter;
  return { move: mv, ms, alarm: !!(ar && ar.alarm), decision: ar ? ar.decision : 'base',
    solverSaved: ar ? ar.groups.some(g => g.saved) : false };
}

function evaluate(o){
  const set = JSON.parse(fs.readFileSync(o.set, 'utf8'));
  let ps = set.positions;
  if (o.limit > 0) ps = ps.slice(0, o.limit);
  const rows = [];
  const summary = {};
  for (const c of o.configs) summary[c] = { solved: 0, positions: 0, alarms: 0, solverSaved: 0, msMax: 0 };
  for (const p of ps){
    const replay = findReplay(o.files, p.file, p.index);
    if (!replay){ console.log(`${p.id}: реплей не найден`); continue; }
    const row = { id: p.id, captured: p.captured, rescue: p.rescue.map(r => r.x + ',' + r.y), res: {} };
    for (const c of o.configs){
      const r = moveAt(replay, p, CONFIGS[c], o);
      r.solved = !!r.move && p.rescue.some(q => q.x === r.move.x && q.y === r.move.y);
      row.res[c] = r;
      const S = summary[c];
      S.positions++; if (r.solved) S.solved++; if (r.alarm) S.alarms++; if (r.solverSaved) S.solverSaved++;
      S.msMax = Math.max(S.msMax, r.ms);
    }
    rows.push(row);
    console.log(`${p.id} (взятие ${p.captured}; спасения ${row.rescue.join(' ')}): ` +
      o.configs.map(c => `${c}=${row.res[c].move ? row.res[c].move.x + ',' + row.res[c].move.y : '-'}${row.res[c].solved ? '✓' : ''}`).join(' '));
  }
  for (const c of o.configs){ const S = summary[c]; S.rate = S.positions ? +(S.solved / S.positions).toFixed(3) : 0; }
  console.log('Итог:', JSON.stringify(summary));
  const report = { format: 'tochki-tactical-report', version: 1, set: path.basename(o.set), level: o.level,
    nodeLimit: o.nodeLimit, configs: Object.fromEntries(o.configs.map(c => [c, CONFIGS[c]])), summary, positions: rows };
  if (o.json) fs.writeFileSync(o.json, JSON.stringify(report, null, 1) + '\n');
  return report;
}

function main(){
  const o = parseArgs(process.argv.slice(2));
  if (o.build) buildSet(o); else evaluate(o);
}

if (require.main === module) main();
module.exports = { CONFIGS, buildSet, evaluate, moveAt, parseArgs, SET_FILE };
