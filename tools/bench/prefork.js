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

function replayPosition(g, ply){
  const r = g.replay, rules = r.rules || {};
  const match = E.createMatch({ sizeKey: r.board.sizeKey, ...rules });
  const moves = r.events.filter(e => e.type === 'move');
  for (let i = 0; i < ply; i++){
    const m = moves[i], t = match.applyMove(m.player, m.x, m.y);
    if (!t || t.ok === false) throw new Error(`invalid replay ${g.id} ply ${i}`);
  }
  return { match, node: E.createSearchNode(match.getSnapshot()), moves };
}

function main(argv){
  const fs = require('fs'), path = require('path');
  const R = require('./replay-blunders');
  const opt = { depth: 6, proofNodeLimit: 200000, lossThreshold: 4 };
  let gameId, onlyPly, output;
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a === '--prefork') continue;
    if (a === '--game') gameId = argv[++i];
    else if (a === '--ply') onlyPly = Number(argv[++i]);
    else if (a === '--depth') opt.depth = Number(argv[++i]);
    else if (a === '--proof-node-limit') opt.proofNodeLimit = Number(argv[++i]);
    else if (a === '--min-loss') opt.lossThreshold = Number(argv[++i]);
    else if (a === '--json') output = argv[++i];
    else throw new Error(`unknown prefork argument ${a}`);
  }
  const games = R.selectGames(R.listCorpusFiles(), R.loadManifest(path.join(R.CORPUS_DIR, 'manifest.json')), 'regression')
    .filter(g => !gameId || g.id === gameId);
  if (!games.length) throw new Error('no regression games selected');
  const report = { format: 'tochki-prefork-regression', version: 1, options: opt,
    positions: [], captures: [], baseline: {} };
  for (const g of games){
    const { moves } = replayPosition(g, 0);
    const bot = (moves.find(m => m.decision) || {}).player;
    for (let c = 0; c < moves.length; c++){
      if (moves[c].player === bot) continue;
      const p = replayPosition(g, c), m = moves[c];
      const t = E.applyTransition(p.node, m.player, m.x, m.y);
      const captured = t.result.gained.filter(v => v.kind === 'captured');
      if (captured.length < opt.lossThreshold) continue;
      const capture = { game: g.id, ply: c, lost: captured.length, checked: [] };
      report.captures.push(capture);
      for (let ply = c-1; ply >= 0; ply--){
        if (moves[ply].player !== bot || (onlyPly !== undefined && ply !== onlyPly)) continue;
        const { node, match } = replayPosition(g, ply);
        const solver = createDefenceSolver(node, { ...opt, focus: captured });
        const played = { x: moves[ply].x, y: moves[ply].y };
        const playedProof = solver.after(played);
        const check = { ply, playedProof, safe: [], unknown: [] };
        capture.checked.push(check);
        if (playedProof.safe !== false){
          console.log(g.id, c, ply, 'played', playedProof);
          continue;
        }
        for (const move of solver.legalMoves()){
          if (key(move) === key(played)) continue;
          const proof = solver.after(move);
          if (proof.safe === true) check.safe.push({ ...move, proof });
          if (proof.safe === null) check.unknown.push(move);
        }
        console.log(g.id, c, ply, 'safe', check.safe.length, 'unknown', check.unknown.length);
        if (!check.safe.length) continue;
        const searches = {};
        for (const [level, nodeLimit] of [['normal', 300], ['strong', 3000]]){
          const result = match.botSearch(level, null, { nodeLimit });
          searches[level] = { nodeLimit, ...classifyMiss(node, E.DIFFICULTY[level], result, check.safe) };
        }
        report.positions.push({ game: g.id, file: g.file, index: g.index, ply,
          capturePly: c, captured: captured.length, played, playedProof,
          savingMoves: check.safe, unknownMoves: check.unknown, searches });
        break;
      }
    }
  }
  for (const level of ['normal', 'strong']){
    report.baseline[level] = { saved: report.positions.filter(p => p.searches[level].reason === 'saved').length,
      total: report.positions.length };
  }
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.baseline));
  return report;
}

module.exports = { createDefenceSolver, classifyMiss, legalMoves, key, replayPosition, main };
