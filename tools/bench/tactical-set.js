#!/usr/bin/env node
// tools/bench/tactical-set.js — тактический набор «найдёт ли бот спасение» (issue #81, #83).
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
//   node tools/bench/tactical-set.js --check [--split train|validation|test]
//        -> #83: проверка восстановления позиций (ход за ботом) и легальности меток rescue[].
//   node tools/bench/tactical-set.js [--node-limit 3000] [--configs base,static,root,...]
//        [--split train|validation|test] [--offset N] [--limit N]
//        [--json tools/bench/reports/tactical-81.json]
//        -> для каждой конфигурации арбитра: сколько позиций набора решено
//           (ход бота входит в rescue[]), по частям split, время хода, нелегальные ходы.
//
// Разбиение #83 (tools/bench/corpus/tactical.split83.json) — ПО ЦЕЛЫМ ПАРТИЯМ
// (поле game позиции): train — настройка, validation — выбор конфигурации,
// test — только новые, ещё не просмотренные партии (defaultSplit). Не включать
// вариант в игровой путь по результату только на train.
//
// Конфигурации (арбитр arbiter.js, strong, фиксированный nodeLimit):
//   base         — monitor:false (ровно searchMove);
//   static       — монитор #77: подмена хода по evaluateStatic;
//   root         — #81: спасения решателя подаются в корень повторного поиска;
//   static-large — static + ранняя тревога cost<=3 для групп >= 6;
//   root-large   — root + ранняя тревога cost<=3 для групп >= 6;
//   fork         — #81: детектор спасения по forkLoss4 для групп >= 6, 3 с;
//   fork4        — #83: fork для групп >= 4 (минимальное взятие набора), до 4 групп;
//   fork4-r2     — #83: fork4 + кандидаты в радиусе 2 (цепь соперника вокруг группы), 6 с;
//   fork4-10s    — #83: fork4-r2 с бюджетом 10 с (проверка «больше времени на спасение»).
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../../gameEngine.js');
const A = require('../../arbiter.js');
const RB = require('./replay-blunders.js');

const SET_FILE = path.join(__dirname, 'corpus', 'tactical.v1.json');
const SPLIT_FILE = path.join(__dirname, 'corpus', 'tactical.split83.json');

const FORK4 = { alarmCostLarge: 3, largeGroupSize: 4, forkMinSize: 4, maxGroups: 4, forkRescue: true };
const CONFIGS = {
  base: { monitor: false },
  static: { monitor: true, arbiter: { rescueMode: 'static' } },
  root: { monitor: true, arbiter: { rescueMode: 'root' } },
  'static-large': { monitor: true, arbiter: { rescueMode: 'static', alarmCostLarge: 3, largeGroupSize: 6 } },
  'root-large': { monitor: true, arbiter: { rescueMode: 'root', alarmCostLarge: 3, largeGroupSize: 6 } },
  // #81: детектор спасения по forkLoss4 для крупных тревожных групп.
  fork: { monitor: true, arbiter: { alarmCostLarge: 3, largeGroupSize: 6, forkRescue: true, forkTimeLimit: 3000 } },
  // #81: root + ранняя тревога + частичное спасение (минимизация потери).
  'root-partial': { monitor: true, arbiter: { rescueMode: 'root', alarmCostLarge: 3, largeGroupSize: 6, rescuePartial: true } },
  // #83: усиленный тактический поиск (без запоминания координат).
  fork4: { monitor: true, arbiter: Object.assign({}, FORK4, { forkTimeLimit: 3000 }) },
  'fork4-r2': { monitor: true, arbiter: Object.assign({}, FORK4, { forkRadius: 2, forkTimeLimit: 6000 }) },
  'fork4-10s': { monitor: true, arbiter: Object.assign({}, FORK4, { forkRadius: 2, forkTimeLimit: 10000 }) }
};

function parseArgs(argv){
  const o = { build: false, check: false, files: [], minLoss: 4, maxBack: 8, radius: 1, forkCap: 1e6, nodeLimit: 3000,
    configs: Object.keys(CONFIGS), json: null, set: SET_FILE, splitFile: SPLIT_FILE, split: null,
    level: 'strong', limit: 0, offset: 0 };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a === '--build') o.build = true;
    else if (a === '--check') o.check = true;
    else if (a === '--min-loss') o.minLoss = Number(argv[++i]) || 4;
    else if (a === '--max-back') o.maxBack = Number(argv[++i]) || 8;
    else if (a === '--radius') o.radius = Number(argv[++i]) || 1;
    else if (a === '--fork-cap') o.forkCap = Number(argv[++i]) || 1e6;
    else if (a === '--node-limit') o.nodeLimit = Number(argv[++i]) || 3000;
    else if (a === '--configs') o.configs = argv[++i].split(',').filter(Boolean);
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--set') o.set = argv[++i];
    else if (a === '--split-file') o.splitFile = argv[++i];
    else if (a === '--split') o.split = argv[++i];
    else if (a === '--level') o.level = argv[++i];
    else if (a === '--limit') o.limit = Number(argv[++i]) || 0;
    else if (a === '--offset') o.offset = Number(argv[++i]) || 0;
    else o.files.push(a);
  }
  if (!o.files.length) o.files = RB.listCorpusFiles();
  for (const c of o.configs) if (!CONFIGS[c]) throw new Error('неизвестная конфигурация ' + c);
  return o;
}

// #83: разбиение по партиям. Возвращает функцию game -> часть.
function loadSplit(file){
  const f = file || SPLIT_FILE;
  const d = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { games: {}, defaultSplit: 'test', splits: ['train', 'validation', 'test'] };
  const def = d.defaultSplit || 'test';
  for (const [g, s] of Object.entries(d.games || {}))
    if (!(d.splits || []).includes(s)) throw new Error(`партия ${g}: неизвестная часть ${s}`);
  return { data: d, of: game => (d.games && d.games[game]) || def };
}

// Построение набора: позиции «до вилки» из ВСЕХ партий (без фильтра по части).
function buildSet(o){
  const games = RB.selectGames(o.files, RB.loadManifest(path.join(RB.CORPUS_DIR, 'manifest.json')), null);
  const positions = [];
  // #81: инкрементальная сборка — набор пишется после каждой партии,
  // уже обработанные партии (doneGames) при повторном запуске пропускаются.
  let prev = null;
  if (fs.existsSync(o.set)) prev = JSON.parse(fs.readFileSync(o.set, 'utf8'));
  const doneGames = new Set((prev && prev.doneGames) || []);
  const flush = () => {
    const ids = new Set(positions.map(p => p.id));
    const all = positions.concat(((prev && prev.positions) || []).filter(p => !ids.has(p.id)))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    fs.writeFileSync(o.set, JSON.stringify({ format: 'tochki-tactical-set', version: 1,
      description: 'Тактический набор #81 (частичная сборка, см. doneGames)', doneGames: [...doneGames], positions: all }, null, 1) + '\n');
  };
  for (const g of games){
    if (doneGames.has(g.id)){ console.log(`${g.id}: уже в наборе`); continue; }
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
    doneGames.add(g.id);
    flush();
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
    doneGames: [...doneGames], positions };
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

// Позиции набора с учётом --split/--offset/--limit; каждой проставлена часть part.
function selectPositions(o){
  const set = JSON.parse(fs.readFileSync(o.set, 'utf8'));
  const sp = loadSplit(o.splitFile);
  let ps = set.positions.map(p => Object.assign({}, p, { part: sp.of(p.game) }));
  if (o.split) ps = ps.filter(p => p.part === o.split);
  if (o.offset > 0) ps = ps.slice(o.offset);
  if (o.limit > 0) ps = ps.slice(0, o.limit);
  return ps;
}

// #83: восстановить позицию p. Возвращает { snap, node } или null.
function restore(replay, p){
  const m = RB.matchAtPly(replay, p.ply);
  const s = m.getSnapshot();
  return { snap: s, node: E.createSearchNode(s) };
}

// #83: проверка позиции: ход за ботом, метки rescue[] легальны и не повторяются.
function checkPosition(replay, p){
  const errors = [];
  const { node } = restore(replay, p);
  if (node.gameOver) errors.push('партия окончена');
  if (node.current !== p.botSeat) errors.push(`ход не за ботом (current=${node.current}, botSeat=${p.botSeat})`);
  if (!Array.isArray(p.rescue) || !p.rescue.length) errors.push('пустой rescue[]');
  const seen = new Set();
  for (const r of p.rescue || []){
    const k = r.x + ',' + r.y;
    if (seen.has(k)) errors.push('повтор метки ' + k);
    seen.add(k);
    if (!E.isTransitionLegal(node, r.x, r.y)) errors.push('нелегальная метка ' + k);
  }
  return errors;
}

function check(o){
  const ps = selectPositions(o);
  let bad = 0;
  for (const p of ps){
    const replay = findReplay(o.files, p.file, p.index);
    const errs = replay ? checkPosition(replay, p) : ['реплей не найден'];
    if (errs.length){ bad++; console.log(`${p.id} [${p.part}]: ${errs.join('; ')}`); }
  }
  console.log(`проверено позиций: ${ps.length}, с ошибками: ${bad}`);
  return { positions: ps.length, bad };
}

// Ход арбитра конфигурации cfg в позиции p.
function moveAt(replay, p, cfg, o){
  const { snap: s, node } = restore(replay, p);
  const st = { stone: s.stone, dead: s.dead, territory: s.territory };
  const opts = Object.assign({ nodeLimit: o.nodeLimit, stonesPlacedTotal: s.stonesPlacedTotal, gameOver: s.gameOver, rules: s.rules },
    { monitor: cfg.monitor, arbiter: cfg.arbiter });
  const t0 = Date.now();
  const r = A.arbiterMove(st, s.rows, s.cols, p.botSeat, E.DIFFICULTY[o.level], null, opts);
  const ms = Date.now() - t0;
  const mv = r.move ? { x: r.move.x, y: r.move.y } : null;
  const ar = r.trace && r.trace.arbiter;
  return { move: mv, ms, legal: !!mv && E.isTransitionLegal(node, mv.x, mv.y),
    alarm: !!(ar && ar.alarm), decision: ar ? ar.decision : 'base',
    solverSaved: ar ? ar.groups.some(g => g.saved) : false,
    // #83: диагностика детектора forkRescue (потеря хода поиска, лучший кандидат, таймаут).
    fork: ar && ar.fork ? { baseLoss: ar.fork.baseLoss, best: ar.fork.best || null, timeout: !!ar.fork.timeout,
      checked: ar.fork.checked, aborted: ar.fork.aborted, ms: ar.fork.ms } : null };
}

function emptyStat(){ return { solved: 0, positions: 0, alarms: 0, solverSaved: 0, illegal: 0, msMax: 0, msSum: 0, bySplit: {} }; }

function evaluate(o){
  const ps = selectPositions(o);
  const rows = [];
  const summary = {};
  for (const c of o.configs) summary[c] = emptyStat();
  for (const p of ps){
    const replay = findReplay(o.files, p.file, p.index);
    if (!replay){ console.log(`${p.id}: реплей не найден`); continue; }
    const row = { id: p.id, game: p.game, part: p.part, captured: p.captured, rescue: p.rescue.map(r => r.x + ',' + r.y), res: {} };
    for (const c of o.configs){
      const r = moveAt(replay, p, CONFIGS[c], o);
      r.solved = !!r.move && p.rescue.some(q => q.x === r.move.x && q.y === r.move.y);
      row.res[c] = r;
      const S = summary[c];
      S.positions++; if (r.solved) S.solved++; if (r.alarm) S.alarms++; if (r.solverSaved) S.solverSaved++;
      if (!r.legal) S.illegal++;
      S.msMax = Math.max(S.msMax, r.ms); S.msSum += r.ms;
      const B = S.bySplit[p.part] || (S.bySplit[p.part] = { solved: 0, positions: 0 });
      B.positions++; if (r.solved) B.solved++;
    }
    rows.push(row);
    console.log(`${p.id} [${p.part}] (взятие ${p.captured}; спасения ${row.rescue.join(' ')}): ` +
      o.configs.map(c => `${c}=${row.res[c].move ? row.res[c].move.x + ',' + row.res[c].move.y : '-'}${row.res[c].solved ? '✓' : ''}${row.res[c].legal ? '' : '!'} ${row.res[c].ms}мс`).join(' '));
  }
  for (const c of o.configs){
    const S = summary[c];
    S.rate = S.positions ? +(S.solved / S.positions).toFixed(3) : 0;
    S.msMean = S.positions ? Math.round(S.msSum / S.positions) : 0;
    delete S.msSum;
  }
  console.log('Итог:', JSON.stringify(summary));
  const report = { format: 'tochki-tactical-report', version: 2, set: path.basename(o.set),
    splitFile: path.basename(o.splitFile), split: o.split || 'all', offset: o.offset, limit: o.limit, level: o.level,
    nodeLimit: o.nodeLimit, configs: Object.fromEntries(o.configs.map(c => [c, CONFIGS[c]])), summary, positions: rows };
  if (o.json) fs.writeFileSync(o.json, JSON.stringify(report, null, 1) + '\n');
  return report;
}

function main(){
  const o = parseArgs(process.argv.slice(2));
  if (o.build) buildSet(o);
  else if (o.check){ const r = check(o); if (r.bad) process.exitCode = 1; }
  else evaluate(o);
}

if (require.main === module) main();
module.exports = { CONFIGS, buildSet, evaluate, check, checkPosition, moveAt, parseArgs, loadSplit, selectPositions, SET_FILE, SPLIT_FILE };
