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
//   4. Спасение найдено -> играть спасающий ход, если его глобальная оценка
//      (score из trace.candidates общего поиска) не хуже, чем
//      bestScore - threshold. Если общий поиск этот ход не оценил, ход
//      принимается при размере группы >= minRescueSize.
//   5. Группа потеряна в любом случае -> бот не добавляет в неё камни: если
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
  maxAlarmTimeLimit: 20000,  // верхний предел (настраивается в интерфейсе)
  threshold: 2,              // допустимое ухудшение глобальной оценки спасающего хода
  minRescueSize: 2,          // спасать без глобальной оценки — от 2 точек
  maxGroups: 3,              // не больше 3 тревожных групп за ход
  solverNodeLimit: 200000    // лимит узлов решателя на группу
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
  const alarmed = mon.groups.filter(g => g.cost <= ao.alarmCost)
    .sort((a, b) => b.size - a.size || a.cost - b.cost).slice(0, ao.maxGroups);
  if (!alarmed.length) return base;
  info.alarm = true;

  const cands = trace.candidates || [];
  const bestScore = cands.reduce((m, c) => Math.max(m, c.score), -Infinity);
  const scoreOf = mv => { const c = cands.find(q => q.x === mv.x && q.y === mv.y); return c ? c.score : undefined; };
  const tLocal = nowMs();
  const lost = [];
  let rescue = null;
  for (const g of alarmed){
    if (nowMs() - tLocal >= info.budgetMs) { info.timeout = true; break; }
    // Каждый вызов решателя ограничен ОСТАВШИМСЯ бюджетом тревоги (timeLimit).
    const remain = Math.max(1, info.budgetMs - (nowMs() - tLocal));
    const r = S.solveGroup(node, mover, g.stones, { nodeLimit: ao.solverNodeLimit, timeLimit: remain });
    const gi = { size: g.size, cost: g.cost, saved: r.saved, move: r.move, loss: r.loss, depth: r.depth, ms: r.ms };
    info.groups.push(gi);
    if (r.saved && r.move){
      // Глобальная оценка спасающего хода проверяется ВСЕГДА: по оценке общего
      // поиска (trace.candidates), а если поиск ход не оценил — по статической
      // оценке позиции после хода против позиции после хода общего поиска.
      const sc = scoreOf(r.move);
      let ok;
      if (sc !== undefined){
        gi.score = sc;
        ok = sc >= bestScore - ao.threshold;
      } else {
        const ev = mv => {
          if (!E.isTransitionLegal(node, mv.x, mv.y)) return -Infinity;
          const t = E.applyTransition(node, mover, mv.x, mv.y);
          if (!t.ok) return -Infinity;
          return E.evaluateStatic(t.node.state, rows, cols, mover, weights || E.BOT_WEIGHTS, t.node);
        };
        const sr = ev(r.move), sb = ev(base.move);
        gi.score = null; gi.staticScore = sr; gi.staticBase = sb;
        ok = g.size >= ao.minRescueSize && Number.isFinite(sr) && sr >= sb - ao.threshold;
      }
      gi.accepted = ok;
      if (ok && !rescue) rescue = { move: r.move, size: g.size };
    } else if (!r.saved){
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
      const alt = cands.slice().sort((a, b) => b.score - a.score)
        .find(c => !bad(c) && E.isTransitionLegal(node, c.x, c.y));
      if (alt) return pick(alt, 'avoid-lost');
    }
  }
  return base;
}

module.exports = { arbiterMove, alarmBudget, ARBITER_DEFAULTS };
