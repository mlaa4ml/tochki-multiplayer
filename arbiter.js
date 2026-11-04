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
//   1. Общий поиск searchMove с обычным лимитом (diff.timeLimit, 2–3 с).
//   2. Монитор monitorPosition(node, mover) без полного twoMoveThreat
//      (единицы мс). Тревога — группа бота с cost <= alarmCost (2, фильтр из S5/S6).
//   3. Дополнительное время идёт ТОЛЬКО на локальный решатель solveGroup по
//      тревожным группам (крупные — первыми). Бюджет — alarmTimeLimit,
//      ограниченный сверху maxAlarmTimeLimit (настройка интерфейса).
//      При nodeLimit дополнительный бюджет также ограничен alarmTimeLimitNodes.
//   4. Спасение принимается для группы >= minRescueSize, если статическая
//      оценка позиции после спасения не хуже оценки после основного хода
//      минус threshold. Обе оценки — с точки зрения бота; root alpha-beta
//      bounds из trace.candidates для сравнения спасения не используются.
//      Каждый вызов решателя ограничен оставшимся бюджетом тревоги.
//   5. Только завершённый локальный поиск с потерей всей группы разрешает
//      ограничение ущерба (это вывод ограниченного поиска, не полный proof).
//      Тревога без решателя или прерванный поиск не означают потерю группы.
//      Если
//      ход общего поиска стоит рядом (8 соседей) с точкой потерянной группы и
//      ничего не берёт, выбирается лучший по оценке кандидат вне группы
//      (ограничение ущерба).
// Решение арбитра пишется в trace.arbiter.
'use strict';
const E = require('./gameEngine.js');
const M = require('./tools/bench/monitor.js');
const S = require('./tools/bench/localSolver.js');

const ARBITER_DEFAULTS = Object.freeze({
  alarmCost: 2,              // cost <= 2 — тревога (S5, фильтр запуска S6)
    alarmTimeLimit: 10000,     // мс на локальный поиск при тревоге
  alarmTimeLimitNodes: 1500, // дополнительный бюджет при детерминированном nodeLimit
  maxAlarmTimeLimit: 20000,  // верхний предел (настраивается в интерфейсе)
  threshold: 2,              // допустимое ухудшение глобальной оценки спасающего хода
  minRescueSize: 2,          // спасать без глобальной оценки — от 2 точек
  maxGroups: 3,              // не больше 3 тревожных групп за ход
  solverNodeLimit: 200000,   // лимит узлов решателя на группу
  solver: true               // false — абляция S8 «монитор без решателя» (#62)
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
  const ao = Object.assign({}, ARBITER_DEFAULTS, opts.arbiter || {});
  const trace = base.trace;
    const budgetMs = opts.nodeLimit > 0
    ? Math.min(alarmBudget(ao), Math.max(0, num(ao.alarmTimeLimitNodes, ARBITER_DEFAULTS.alarmTimeLimitNodes)))
    : alarmBudget(ao);
  const info = { alarm: false, groups: [], decision: 'base', budgetMs };
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
  const alarmed = mon.groups.filter(g => g.cost <= ao.alarmCost)
    .sort((a, b) => b.size - a.size || a.cost - b.cost).slice(0, ao.maxGroups);
  if (!alarmed.length) return base;
  info.alarm = true;

  const cands = trace.candidates || [];
  // Root alpha-beta scores can be bounds, not comparable move evaluations.
  // Compare both positions in the same static scale, from the bot's seat.
  const scoreOf = mv => {
    if (!E.isTransitionLegal(node, mv.x, mv.y)) return -Infinity;
    const t = E.applyTransition(node, mover, mv.x, mv.y);
    return t.ok ? E.evaluateStatic(t.node.state, rows, cols, mover, weights || E.BOT_WEIGHTS, t.node) : -Infinity;
  };
  const baseScore = scoreOf(base.move);
  const tLocal = nowMs();
  const lost = [];
  let rescue = null;
  for (const g of alarmed){
    if (nowMs() - tLocal >= info.budgetMs) { info.timeout = true; break; }
    // Каждый вызов решателя ограничен ОСТАВШИМСЯ бюджетом тревоги (timeLimit).
    const remain = Math.max(1, info.budgetMs - (nowMs() - tLocal));
    // A monitor alarm is a heuristic, not proof that a group is lost.
    const r = ao.solver === false
      ? { saved: false, move: null, loss: null, depth: 0, ms: 0, skipped: 'no-solver' }
      : S.solveGroup(node, mover, g.stones, { nodeLimit: ao.solverNodeLimit, timeLimit: remain });
    const gi = { size: g.size, cost: g.cost, saved: r.saved, move: r.move, loss: r.loss,
      depth: r.depth, ms: r.ms, incomplete: !!r.incomplete, skipped: r.skipped };
    info.groups.push(gi);
    if (r.incomplete) info.timeout = true;
    if (r.saved && r.move && !r.incomplete){
      const sc = scoreOf(r.move);
      gi.staticScore = sc;
      gi.staticBase = baseScore;
      const ok = g.size >= ao.minRescueSize && Number.isFinite(sc) && sc >= baseScore - ao.threshold;
      gi.accepted = ok;
      if (ok && !rescue) rescue = { move: r.move, size: g.size };
    } else if (!r.incomplete && !r.skipped && r.depth > 0 && r.loss >= g.size){
      lost.push(g);
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

  if (rescue) return pick(rescue.move, 'rescue');

  // Ограничение ущерба: не добавлять камни в потерянные группы.
  if (lost.length){
    const bad = mv => lost.some(g => nearGroup(mv, g.stones)) && !capturesAny(node, mover, mv);
    if (bad(base.move)){
      const alt = avoidLostMove(node, mover, weights, cands, lost.map(g => g.stones));
      if (alt){
        info.avoidSource = alt.source;
        return pick(alt, 'avoid-lost');
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
