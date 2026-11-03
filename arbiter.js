// S7: optional server-side arbitration. Disabled path is exactly searchMove.
'use strict';
const E = require('./gameEngine');
const { monitorPosition } = require('./tools/bench/monitor');
const { solveGroup } = require('./tools/bench/localSolver');

function arbiterMove(state, rows, cols, player, difficulty, weights, opts = {}){
  const result = E.searchMove(state, rows, cols, player, difficulty, weights, opts);
  if (opts.monitor !== true || !result.move) return result;
  const node = E.createSearchNode(Object.assign({}, state, {
    rows, cols, current: player, rules: opts.rules,
    stonesPlacedTotal: opts.stonesPlacedTotal, gameOver: opts.gameOver
  }));
  const budget = Math.min(
    Number(opts.alarmTimeLimit) > 0 ? Number(opts.alarmTimeLimit) : 10000,
    Number(opts.maxAlarmTimeLimit) > 0 ? Number(opts.maxAlarmTimeLimit) : 20000);
  const alarm = monitorPosition(node, player, { twoMove: false, withOpp: false }).groups
    .filter(g => g.cost <= 2).sort((a, b) => b.capture - a.capture || b.size - a.size)[0];
  const trace = { decision: 'base', budgetMs: budget };
  result.trace.arbiter = trace;
  if (!alarm) return result;
  const solved = solveGroup(node, player, alarm.stones, { timeLimit: budget });
  trace.solver = solved;
  trace.group = alarm.id;
  const score = move => {
    const t = E.applyTransition(node, player, move.x, move.y);
    return t.ok ? E.evaluateStatic(t.node.state, rows, cols, player, weights, t.node) : -Infinity;
  };
  const threshold = Number.isFinite(opts.threshold) ? Math.max(0, opts.threshold) : 2;
  if (solved.saved && solved.move && score(solved.move) >= score(result.move) - threshold){
    result.move = solved.move;
    trace.decision = 'rescue';
  } else if (!solved.saved && !solved.aborted && solved.loss > 0){
    // Never reinforce a lost group unless the move captures enemy stones.
    const safe = move => {
      if (!alarm.stones.some(s => Math.abs(s.x - move.x) <= 1 && Math.abs(s.y - move.y) <= 1)) return true;
      const t = E.applyTransition(node, player, move.x, move.y);
      return t.ok && t.result.gained.some(g => g.kind === 'captured');
    };
    if (!safe(result.move)){
      const moves = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++){
        const m = { x, y };
        if (E.isTransitionLegal(node, x, y) && safe(m)) moves.push({ move: m, score: score(m) });
      }
      moves.sort((a, b) => b.score - a.score);
      if (moves.length){ result.move = moves[0].move; trace.decision = 'avoid-lost'; }
    }
  } else if (solved.saved) trace.decision = 'reject-rescue';
  trace.move = result.move;
  return result;
}
module.exports = { arbiterMove };
