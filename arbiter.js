// arbiter.js — арбитр хода бота и распределение времени (issue #61, S7
// дорожной карты docs/MONITOR_ROADMAP.md). Только Node: монитор (S5) и
// локальный решатель (S6) лежат в tools/bench и используют process.hrtime.
//
// arbiterMove(state, rows, cols, mover, diff, weights, opts) — тот же
// интерфейс и формат ответа, что у gameEngine.searchMove.
//
// ФЛАГ. opts.monitor (по умолчанию false). При monitor:false арбитр ничего не
// делает и возвращает РОВНО результат searchMove с теми же аргументами, поэтому
// ходы совпадают с базой (при фиксированном nodeLimit — детерминированно).
// Это нужно для парных матчей «база против монитора» (S4/S8).
//
// При monitor:true:
//   1. Общий поиск searchMove с обычным лимитом (diff.timeLimit или nodeLimit).
//      Бюджет основного поиска арбитр не трогает: решатель работает ПОСЛЕ
//      поиска со своим лимитом узлов (solverNodeLimit) и времени.
//   2. Монитор monitorPosition(node, mover) без полного twoMoveThreat
//      (единицы мс). Тревога — группа бота с cost <= alarmCost (2, фильтр из S5/S6).
//   3. Дополнительное время идёт ТОЛЬКО на локальный решатель solveGroup по
//      тревожным группам (крупные — первыми). Бюджет — alarmTimeLimit,
//      ограниченный сверху maxAlarmTimeLimit (настройка интерфейса). При
//      заданном nodeLimit (матчи/бенчмарки) и без явного alarmTimeLimit
//      бюджет по умолчанию — alarmTimeLimitNodes (#77). Дедлайн соблюдается
//      и в проверке спасения (verify/forkCheck решателя, #77).
//   4. Спасение найдено -> играть спасающий ход, если статическая оценка
//      позиции после него не хуже оценки после хода общего поиска минус
//      threshold (и группа >= minRescueSize). Оба хода оцениваются ОДНИМ
//      способом и с точки зрения бота (#77: раньше спасение сравнивалось по
//      trace.candidates, где у всех ходов, кроме лучшего, — граница
//      альфа-бета, а не оценка).
//   5. Ограничение ущерба: только если решатель ДОКАЗАЛ потерю всей группы
//      (поиск завершил хотя бы одну глубину, не оборвался по времени,
//      loss >= размера группы), бот не добавляет в неё камни: если ход общего
//      поиска стоит рядом (8 соседей) с точкой потерянной группы и ничего не
//      берёт, выбирается лучший по оценке кандидат вне группы. Без
//      доказательства (решатель выключен, таймаут, частичная потеря) ход поиска
//      не подменяется (#77: раньше тревога cost<=2 без решателя сразу считалась
//      потерей, и бот запрещал себе защитные ходы — доля 0.0 в S8 no-solver).
// Решение арбитра пишется в trace.arbiter.
'use strict';
const E = require('./gameEngine.js');
const M = require('./tools/bench/monitor.js');
const S = require('./tools/bench/localSolver.js');

const ARBITER_DEFAULTS = Object.freeze({
  alarmCost: 2,              // cost <= 2 — тревога (S5, фильтр запуска S6)
  alarmTimeLimit: 10000,     // мс на локальный поиск при тревоге
  alarmTimeLimitNodes: 1500, // #77: бюджет тревоги по умолчанию при заданном nodeLimit
  maxAlarmTimeLimit: 20000,  // верхний предел (настраивается в интерфейсе)
  threshold: 2,              // допустимое ухудшение статической оценки спасающего хода
  minRescueSize: 2,          // спасать — от 2 точек
  maxGroups: 3,              // не больше 3 тревожных групп за ход
  solverNodeLimit: 200000,   // лимит узлов решателя на группу
    solver: true,              // false — абляция S8 «монитор без решателя» (#62)
  // #81: ранняя тревога для крупных групп (гипотеза 2). null — выключено.
  alarmCostLarge: null,      // например 3: cost <= 3 при size >= largeGroupSize
  largeGroupSize: 6,
  // #81 (гипотеза 1): как применять найденное спасение.
  //   'static' — как в #77: подмена хода после поиска по evaluateStatic;
  //   'root'   — повторный searchMove с ходами-спасениями первыми в корне
  //              (opts.rootFirst): поиск сам сравнивает их на полную глубину.
  rescueMode: 'static',
    rootNodeLimit: 0,          // узлы повторного поиска в режиме root (0 — как у базы)
  // #81: в режиме root подавать в корень и ход решателя, который спасает
  // группу частично (loss < size, без таймаута). false — как раньше.
  rescuePartial: false
});

function nowMs(){ const t = process.hrtime(); return t[0] * 1e3 + t[1] / 1e6; }
function num(v, d){ const n = Number(v); return Number.isFinite(n) ? n : d; }

// Итоговый бюджет локального поиска: alarmTimeLimit, но не больше maxAlarmTimeLimit.
function alarmBudget(ao){
  const cap = Math.max(0, num(ao.maxAlarmTimeLimit, ARBITER_DEFAULTS.maxAlarmTimeLimit));
  return Math.min(Math.max(0, num(ao.alarmTimeLimit, ARBITER_DEFAULTS.alarmTimeLimit)), cap);
}

function nearGroup(move, stones){
  for (const s of stones) if (Math.abs(s.x - move.x) <= 1 && Math.abs(s.y - move.y) <= 1) return true;
  return false;
}

function capturesAny(node, mover, mv){
  if (!E.isTransitionLegal(node, mv.x, mv.y)) return false;
  const t = E.applyTransition(node, mover, mv.x, mv.y);
  return !!(t.ok && t.result && Array.isArray(t.result.gained) && t.result.gained.some(q => q.kind === 'captured'));
}

function arbiterMove(state, rows, cols, mover, diff, weights, opts){
  opts = opts || {};
  const base = E.searchMove(state, rows, cols, mover, diff, weights, opts);
  if (opts.monitor !== true) return base; // monitor:false — ровно база
  const user = opts.arbiter || {};
  const ao = Object.assign({}, ARBITER_DEFAULTS, user);
  if (opts.nodeLimit > 0 && user.alarmTimeLimit === undefined) ao.alarmTimeLimit = ao.alarmTimeLimitNodes;
  const trace = base.trace;
  const info = { alarm: false, groups: [], decision: 'base', budgetMs: alarmBudget(ao) };
  trace.arbiter = info;
  if (!base.move) return base;

  const node = E.createSearchNode({
    stone: state.stone, dead: state.dead, territory: state.territory, rows, cols,
    current: mover, stonesPlacedTotal: opts.stonesPlacedTotal, gameOver: opts.gameOver, rules: opts.rules
  });
  if (node.gameOver) return base;
  const t0 = nowMs();
  const mon = M.monitorPosition(node, mover, { twoMove: false, withOpp: false });
  info.monitorMs = +(nowMs() - t0).toFixed(1);
    // #81 (гипотеза 2): для крупных групп тревога раньше — cost <= alarmCostLarge
  // при size >= largeGroupSize. По умолчанию alarmCostLarge = null (как раньше).
  const costLimit = g => (Number.isFinite(ao.alarmCostLarge) && g.size >= ao.largeGroupSize)
    ? Math.max(ao.alarmCost, ao.alarmCostLarge) : ao.alarmCost;
  const alarmed = mon.groups.filter(g => g.cost <= costLimit(g))
    .sort((a, b) => b.size - a.size || a.cost - b.cost).slice(0, ao.maxGroups);
  if (!alarmed.length) return base;
  info.alarm = true;

  const cands = trace.candidates || [];
  // Статическая оценка позиции после хода — с точки зрения бота (mover),
  // одна шкала для хода спасения и хода общего поиска.
  const ev = mv => {
    if (!E.isTransitionLegal(node, mv.x, mv.y)) return -Infinity;
    const t = E.applyTransition(node, mover, mv.x, mv.y);
    if (!t.ok) return -Infinity;
    return E.evaluateStatic(t.node.state, rows, cols, mover, weights || E.BOT_WEIGHTS, t.node);
  };
  let sbCache;
  const staticBase = () => (sbCache === undefined ? (sbCache = ev(base.move)) : sbCache);
  const tLocal = nowMs();
  const lost = [];
  let rescue = null;
  for (const g of alarmed){
    if (nowMs() - tLocal >= info.budgetMs) { info.timeout = true; break; }
    // Каждый вызов решателя ограничен ОСТАВШИМСЯ бюджетом тревоги (timeLimit).
    const remain = Math.max(1, info.budgetMs - (nowMs() - tLocal));
    // S8 (#62), абляция «без решателя»: arbiter.solver:false — решатель не
    // вызывается. Потеря группы тогда не доказана, и ход поиска не
    // подменяется (#77).
    const r = ao.solver === false
      ? { saved: false, move: null, loss: 0, depth: 0, ms: 0, skipped: 'no-solver' }
      : S.solveGroup(node, mover, g.stones, { nodeLimit: ao.solverNodeLimit, timeLimit: remain });
    const gi = { size: g.size, cost: g.cost, saved: r.saved, move: r.move, loss: r.loss, depth: r.depth, ms: r.ms };
    if (r.timedOut) { gi.timedOut = true; info.timeout = true; }
    if (r.skipped) gi.skipped = r.skipped;
    info.groups.push(gi);
    if (r.saved && r.move){
      const sr = ev(r.move), sb = staticBase();
      gi.staticScore = sr; gi.staticBase = sb;
      const ok = g.size >= ao.minRescueSize && Number.isFinite(sr) && sr >= sb - ao.threshold;
      gi.accepted = ok;
      if (ok && !rescue) rescue = { move: r.move, size: g.size };
    } else if (!r.saved){
      const proven = !r.skipped && !r.timedOut && r.depth > 0 && Number.isFinite(r.loss) && r.loss >= g.size;
      gi.lostProven = proven;
      if (proven) lost.push(g);
    }
  }
  info.localMs = +(nowMs() - tLocal).toFixed(1);

  const pick = (mv, decision) => {
    info.decision = decision;
    if (mv.x === base.move.x && mv.y === base.move.y) return base;
    info.overridden = { from: { x: base.move.x, y: base.move.y }, to: { x: mv.x, y: mv.y } };
    trace.move = { x: mv.x, y: mv.y };
    return { move: { x: mv.x, y: mv.y }, trace };
  };

    if (ao.rescueMode === 'root'){
    // #81 (гипотеза 1): ходы-спасения подаются в корень повторного поиска
    // первыми кандидатами. Поиск оценивает их на полную глубину в одной
    // шкале с остальными ходами, без подмены по одноходовой статике.
    // rescuePartial: решатель не спас группу целиком, но нашёл ход, после
    // которого потеря меньше размера группы, — это тоже кандидат «спасения»
    // (минимизация ущерба; #81, позиция issue52-r01-g1@42: loss 6 из 14).
    const useGi = gi => gi.move && gi.size >= ao.minRescueSize &&
      (gi.saved || (ao.rescuePartial && !gi.timedOut && Number.isFinite(gi.loss) && gi.loss < gi.size));
    const rmv = info.groups.filter(useGi).map(gi => ({ x: gi.move.x, y: gi.move.y }));
    if (rmv.length){
      const o2 = Object.assign({}, opts, { rootFirst: rmv });
      if (ao.rootNodeLimit > 0) o2.nodeLimit = ao.rootNodeLimit;
      const r2 = E.searchMove(state, rows, cols, mover, diff, weights, o2);
      info.rescueMode = 'root';
      info.rootFirst = r2.trace.rootFirst || [];
      info.rootNodes = r2.trace.nodes;
      info.rootCompletedDepth = r2.trace.completedDepth;
      if (r2.move) return pick(r2.move, 'rescue');
    }
  } else if (rescue) return pick(rescue.move, 'rescue');

  // Ограничение ущерба: не добавлять камни в доказанно потерянные группы.
  if (lost.length){
    const bad = mv => lost.some(g => nearGroup(mv, g.stones)) && !capturesAny(node, mover, mv);
    if (bad(base.move)){
      const alt = avoidLostMove(node, mover, weights, cands, lost.map(g => g.stones));
      if (alt){
        info.avoidSource = alt.source;
        return pick(alt, 'limit'); // #77: decision=limit — ограничение ущерба
      }
      info.avoidSource = 'none'; // вне групп легальных ходов нет вовсе
    }
  }
  return base;
}

// Ход вне потерянных групп (ограничение ущерба). Сначала — лучший по оценке
// общего поиска кандидат из trace.candidates. Если такого нет, перебираются
// ВСЕ легальные ходы поля, и берётся лучший по статической оценке позиции
// после хода. Ход «рядом с группой» допустим, только если он что-то берёт.
// Возвращает {x, y, source} или null, если вне групп нет ни одного легального хода.
function avoidLostMove(node, mover, weights, cands, lostStones){
  const bad = mv => lostStones.some(st => nearGroup(mv, st)) && !capturesAny(node, mover, mv);
  const alt = (cands || []).slice().sort((a, b) => b.score - a.score)
    .find(c => E.isTransitionLegal(node, c.x, c.y) && !bad(c));
  if (alt) return { x: alt.x, y: alt.y, source: 'candidates' };
  let best = null, bestV = -Infinity;
  for (let y = 0; y < node.rows; y++) for (let x = 0; x < node.cols; x++){
    if (!E.isTransitionLegal(node, x, y)) continue;
    const mv = { x, y };
    if (bad(mv)) continue;
    const t = E.applyTransition(node, mover, x, y);
    if (!t.ok) continue;
    let v = E.evaluateStatic(t.node.state, node.rows, node.cols, mover, weights || E.BOT_WEIGHTS, t.node);
    if (!Number.isFinite(v)) v = -1e15;
    if (best === null || v > bestV){ best = mv; bestV = v; }
  }
  return best ? { x: best.x, y: best.y, source: 'all-legal' } : null;
}

module.exports = { arbiterMove, alarmBudget, avoidLostMove, ARBITER_DEFAULTS };
