#!/usr/bin/env node
// tools/bench/monitor-report.js — отчёт монитора опасных групп по таймлайну
// партий корпуса (issue #59, S5 дорожной карты). Ходы бота НЕ меняются:
// партия проигрывается по записи, монитор только смотрит на позиции.
//
// Использование:
//   node tools/bench/monitor-report.js --split dev|regression|holdout
//        [--json out.json] [--timeline] [--min-loss 1] [--lead 5] [--horizon 10]
//        [--no-twomove] [--game id]
//
// Таймлайн: после КАЖДОГО хода бота (ход противника — худший момент для
// бота) считается monitorPosition(node, botSeat). Взятие у бота — ход
// противника, пленивший >= --min-loss точек бота.
// Метрики для каждого правила тревоги из monitor.js (правила заданы заранее):
//   lead      — для каждого взятия: сколько ходов бота подряд перед взятием
//               тревога горела на пленённых точках (или на всю позицию).
//               Взятие «предупреждено», если lead >= --lead (по умолчанию 5);
//   falseRate — ложные тревоги на 10 ходов бота. Тревога ложная, если за
//               следующие --horizon ходов бота ни одна отмеченная точка не
//               была пленена (для тревоги на всю позицию — не было взятий);
//   ms        — время расчёта (среднее и p95, отдельно с twoMoveThreat).
// Критерии #59: большинство взятий с lead >= 5, falseRate <= 1, ms — единицы.
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../../gameEngine.js');
const M = require('./monitor.js');

const CORPUS_DIR = path.join(__dirname, 'corpus', 'human');
const SPLITS = ['dev', 'regression', 'holdout'];

function parseArgs(argv){
  const o = { split: null, json: null, timeline: false, minLoss: 1, lead: 5, horizon: 10, twoMove: true, game: null,
    manifest: path.join(CORPUS_DIR, 'manifest.json') };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a === '--split'){ o.split = argv[++i]; if (!SPLITS.includes(o.split)) throw new Error('--split: ' + SPLITS.join('|')); }
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--timeline') o.timeline = true;
    else if (a === '--min-loss') o.minLoss = Number(argv[++i]) || 1;
    else if (a === '--lead') o.lead = Number(argv[++i]) || 5;
    else if (a === '--horizon') o.horizon = Number(argv[++i]) || 10;
    else if (a === '--no-twomove') o.twoMove = false;
    else if (a === '--game') o.game = argv[++i];
    else if (a === '--manifest') o.manifest = argv[++i];
    else throw new Error('неизвестный аргумент ' + a);
  }
  return o;
}

function loadGames(opts){
  const man = JSON.parse(fs.readFileSync(opts.manifest, 'utf8'));
  const def = man.defaultSplit || 'holdout';
  const files = fs.readdirSync(CORPUS_DIR).filter(f => f.endsWith('.json') && f !== 'manifest.json').sort();
  const out = [];
  for (const f of files){
    const j = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, f), 'utf8'));
    (Array.isArray(j) ? j : [j]).forEach((g, index) => {
      const e = man.games.find(m => m.file === f && m.index === index);
      const split = e ? e.split : def;
      const id = e ? e.id : f.replace(/\.json$/, '') + '#' + index;
      if (opts.split && split !== opts.split) return;
      if (opts.game && id !== opts.game) return;
      out.push({ id, split, file: f, index, replay: g.replay || g });
    });
  }
  return out;
}

function startNode(r){
  const rules = r.rules || {};
  const m = E.createMatch({
    sizeKey: r.board.sizeKey, firstPlayer: rules.firstPlayer, startPosition: rules.startPosition,
    targetScore: rules.targetScore, targetFillPercent: rules.targetFillPercent,
    extraTurnOnCapture: rules.extraTurnOnCapture
  });
  return E.createSearchNode(m.getSnapshot());
}

// Проигрывает партию и строит таймлайн: позиции после ходов бота и взятия.
function runGame(g, opts){
  const r = g.replay;
  const moves = r.events.filter(e => e.type === 'move');
  const botSeat = (moves.find(e => e.decision) || {}).player || 2;
  const opp = botSeat === 1 ? 2 : 1;
  let node = startNode(r);
  const points = [];   // { ply, botIdx, res }
  const losses = [];   // { ply, botIdx (ходов бота сыграно до взятия), cells:Set }
  let botIdx = 0;
  for (let i = 0; i < moves.length; i++){
    const mv = moves[i];
    const t = E.applyTransition(node, mv.player, mv.x, mv.y);
    if (!t.ok) break;
    if (mv.player === opp){
      const cells = new Set();
      for (const c of t.result.gained) if (c.kind === 'captured') cells.add(c.x + ',' + c.y);
      if (cells.size >= opts.minLoss) losses.push({ ply: i, botIdx, cells, n: cells.size });
    }
    node = t.node;
    if (mv.player === botSeat){
      botIdx++;
      if (node.gameOver) break;
      const before = JSON.stringify(node.state);
            const prev = points.length ? points[points.length - 1].res : null;
      const res = M.monitorPosition(node, botSeat, { twoMove: opts.twoMove, prev });
      if (JSON.stringify(node.state) !== before) throw new Error('монитор изменил узел');
      points.push({ ply: i, botIdx, res });
    }
    if (node.gameOver) break;
  }
  return { id: g.id, split: g.split, size: r.board.sizeKey, botSeat, botMoves: botIdx, points, losses };
}

// Оценка одного правила на одной партии.
function evalRule(G, rule, opts){
  const al = G.points.map(pt => M.alarmOf(pt.res, rule));
  const leads = G.losses.map(L => {
    // позиции до взятия: points с botIdx <= L.botIdx, идём назад
    let lead = 0;
    for (let k = G.points.length - 1; k >= 0; k--){
      if (G.points[k].botIdx > L.botIdx) continue;
      const a = al[k];
      const hit = a.all || [...L.cells].some(c => a.stones.has(c));
      if (!hit) break;
      lead++;
    }
    return { ply: L.ply, n: L.n, lead };
  });
  let alarms = 0, falses = 0;
  G.points.forEach((pt, k) => {
    const a = al[k];
    if (!a.on) return;
    alarms++;
    const fut = G.losses.filter(L => L.botIdx >= pt.botIdx && L.botIdx < pt.botIdx + opts.horizon);
    const ok = a.all ? fut.length > 0 : fut.some(L => [...L.cells].some(c => a.stones.has(c)));
    if (!ok) falses++;
  });
  return { leads, alarms, falses };
}

function pct(arr, q){
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
const r2 = x => Math.round(x * 100) / 100;

function main(){
  const opts = parseArgs(process.argv.slice(2));
  const games = loadGames(opts);
  if (!games.length){ console.error('нет партий для выбранной части'); process.exit(1); }
  const runs = games.map(g => runGame(g, opts));
  const cheap = [], two = [], local = [];
  for (const G of runs) for (const pt of G.points){ cheap.push(pt.res.msCheap); local.push(pt.res.msLocal || 0); if (opts.twoMove) two.push(pt.res.msTwoMove); }
  console.log(`время локального twoMoveThreat (входит в «без twoMove»): ср ${r2(local.reduce((a, b) => a + b, 0) / (local.length || 1))} мс, p95 ${r2(pct(local, 0.95))} мс`);
  const botMoves = runs.reduce((s, G) => s + G.botMoves, 0);
  const nLoss = runs.reduce((s, G) => s + G.losses.length, 0);
  const report = { split: opts.split, games: runs.map(G => ({ id: G.id, size: G.size, botSeat: G.botSeat, botMoves: G.botMoves, losses: G.losses.length })),
    params: { minLoss: opts.minLoss, lead: opts.lead, horizon: opts.horizon },
    botMoves, losses: nLoss,
    ms: { cheapMean: r2(cheap.reduce((a, b) => a + b, 0) / (cheap.length || 1)), cheapP95: r2(pct(cheap, 0.95)),
      twoMoveMean: r2(two.reduce((a, b) => a + b, 0) / (two.length || 1)), twoMoveP95: r2(pct(two, 0.95)) },
    rules: {} };
  for (const rule of Object.keys(M.RULES)){
    if (!opts.twoMove && M.NEEDS_TWOMOVE.has(rule)) continue;
    let warned = 0, alarms = 0, falses = 0;
    const perGame = [];
    for (const G of runs){
      const e = evalRule(G, rule, opts);
      warned += e.leads.filter(l => l.lead >= opts.lead).length;
      alarms += e.alarms; falses += e.falses;
      perGame.push({ id: G.id, leads: e.leads, alarms: e.alarms, falses: e.falses });
    }
    const warnedShare = nLoss ? warned / nLoss : 0;
    const falseRate = botMoves ? 10 * falses / botMoves : 0;
    report.rules[rule] = { desc: M.RULES[rule].desc, warned, warnedShare: r2(warnedShare), alarms, falses, falseRate: r2(falseRate),
      pass: { lead: warnedShare > 0.5, falseAlarms: falseRate <= 1 }, perGame };
  }
  console.log(`монитор S5: часть=${opts.split || 'все'}, партий ${runs.length}, ходов бота ${botMoves}, взятий у бота ${nLoss} (>= ${opts.minLoss} точек)`);
  console.log(`время: без twoMove ср ${report.ms.cheapMean} мс, p95 ${report.ms.cheapP95} мс; twoMoveThreat ср ${report.ms.twoMoveMean} мс, p95 ${report.ms.twoMoveP95} мс`);
  for (const [k, v] of Object.entries(report.rules)){
    console.log(`${k.padEnd(9)} [${v.desc}] предупреждено ${v.warned}/${nLoss} (${v.warnedShare}) ${v.pass.lead ? 'OK' : 'НЕТ'}; тревог ${v.alarms}, ложных ${v.falses}, на 10 ходов ${v.falseRate} ${v.pass.falseAlarms ? 'OK' : 'НЕТ'}`);
    for (const pg of v.perGame) console.log(`    ${pg.id}: взятия (ply:точек:lead) ${pg.leads.map(l => l.ply + ':' + l.n + ':' + l.lead).join(' ') || '—'}; ложных ${pg.falses}/${pg.alarms}`);
  }
  if (opts.timeline){
    for (const G of runs){
      console.log(`\nтаймлайн ${G.id} (бот ${G.botSeat})`);
      for (const pt of G.points){
        const r = pt.res;
        const worst = r.groups.filter(g => g.cost !== Infinity).sort((a, b) => a.cost - b.cost)[0];
        const loss = G.losses.find(L => L.botIdx === pt.botIdx);
        console.log(`  ply ${pt.ply} ход бота ${pt.botIdx}: групп ${r.groups.length}, minCost ${r.minCost}, twoMove ${r.twoMove}` +
          (worst ? `, худшая: size ${worst.size} exits ${worst.exits} cost ${worst.cost} ring ${r2(worst.ringProgress)} capture ${worst.capture}` : '') +
          (loss ? `  <<< взятие ${loss.n} на ply ${loss.ply}` : ''));
      }
    }
  }
  if (opts.json){
    const slim = JSON.parse(JSON.stringify(report));
    fs.writeFileSync(opts.json, JSON.stringify(slim, null, 2) + '\n');
    console.log('JSON: ' + opts.json);
  }
}

if (require.main === module) main();
module.exports = { runGame, evalRule, loadGames };
