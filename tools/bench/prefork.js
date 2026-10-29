'use strict';
// Six-ply, rules-faithful bounded proof search. A budget exhaustion is UNKNOWN,
// never a safe leaf. No two-consecutive-opponent-moves approximation is used.
const E = require('../../gameEngine');
const key = m => `${m.x},${m.y}`;

function legalMoves(n, focus){
  const out = [];
  for (let y = 0; y < n.rows; y++) for (let x = 0; x < n.cols; x++){
    if (E.isTransitionLegal(n, x, y)) out.push({ x, y });
  }
  // Ordering only: distant moves are NOT removed from the proof tree.
  if (focus && focus.length) out.sort((a, b) => {
    const dist = m => Math.min(...focus.map(f => Math.max(Math.abs(m.x-f.x), Math.abs(m.y-f.y))));
    return dist(a)-dist(b) || a.y-b.y || a.x-b.x;
  });
  return out;
}

function createDefenceSolver(root, opts = {}){
  const depth = opts.depth === undefined ? 6 : opts.depth;
  if (!Number.isInteger(depth) || depth < 6 || depth > 8) throw new Error('defence depth must be 6..8');
  const bot = root.current, opp = 3-bot;
  const threshold = opts.lossThreshold === undefined ? 4 : opts.lossThreshold;
  if (!(threshold > 0)) throw new Error('lossThreshold must be positive');
  const limit = opts.proofNodeLimit || 2000000;
  const base = root.scores[opp];
  const focus = opts.focus || [];
  // Independent budget for each proposed root move; reproducible across runs.
  function after(move){
    let nodes = 0, exhausted = false;
    const memo = new Map();
    function visit(n, left){
      if (++nodes > limit){ exhausted = true; return null; }
      if (n.scores[opp]-base >= threshold) return false;
      if (n.gameOver) return n.winner !== opp;
      if (left === 0) return true;
      const hash = JSON.stringify([left, n.current, n.stonesPlacedTotal, n.state.stone,
        n.state.dead, n.state.territory, n.scores]);
      if (memo.has(hash)) return memo.get(hash);
      const defending = n.current === bot;
      let unknown = false, any = false;
      for (const m of legalMoves(n, focus)){
        const t = E.applyTransition(n, n.current, m.x, m.y);
        if (!t.ok) continue;
        any = true;
        const v = visit(t.node, left-1);
        if (v === defending){ memo.set(hash, defending); return defending; }
        if (v === null) unknown = true;
        if (exhausted) return null;
      }
      const result = unknown ? null : (!any || !defending);
      if (result !== null) memo.set(hash, result);
      return result;
    }
    const t = E.applyTransition(root, bot, move.x, move.y);
    if (!t.ok) return { safe: false, nodes: 0, illegal: true };
    const safe = visit(t.node, depth-1);
    return { safe, nodes, exhausted };
  }
  return { after, depth, threshold, bot, legalMoves: () => legalMoves(root, focus) };
}

// Evidence is tied to the actual root beam and completed iteration, not merely
// to the configured candidateCap or the existence of a stopReason.
function classifyMiss(root, diff, result, savingMoves){
  const full = E.legalCandidates(root, diff);
  const beam = E.searchCandidates(root, diff, diff.candidateCap);
  const has = (list, m) => list.some(c => key(c) === key(m));
  const generated = savingMoves.filter(m => has(full, m));
  const retained = savingMoves.filter(m => has(beam, m));
  const trace = result.trace;
  const evaluated = retained.filter(m => has(trace.candidates, m));
  let reason;
  if (savingMoves.some(m => key(m) === key(result.move || {}))) reason = 'saved';
  else if (!generated.length) reason = 'not-in-candidates';
  else if (!retained.length) reason = 'width';
  else if (trace.stopReason === 'node-limit' && (!evaluated.length || trace.completedDepth < diff.maxDepth)) reason = 'time';
  else reason = 'misjudged';
  return { reason, move: result.move && { x: result.move.x, y: result.move.y },
    detail: { generated: generated.map(key), retained: retained.map(key), evaluated: evaluated.map(key),
      completedDepth: trace.completedDepth, maxDepth: diff.maxDepth, stopReason: trace.stopReason } };
}

module.exports = { createDefenceSolver, classifyMiss, legalMoves, key };
