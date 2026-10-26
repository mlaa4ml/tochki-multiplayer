'use strict';
// #52: real lost-game regressions; coordinates and event indexes are zero-based.
// Run: node test/human-replays.js
const assert = require('assert');
const E = require('../gameEngine');
const A = require('../tools/bench/analyze-human-replays');
const games = A.loadGames();
assert.strictEqual(games.length, 6);
assert.deepStrictEqual(games.map(g => g.end.scores[1]), [12, 16, 24, 27, 36, 35]);
assert(games.every(g => g.end.scores[2] === 0));

const game = games.find(g => g.id === 'issue52-replays02.json#3');
const ps = A.positions(game);
for (const eventIndex of [66, 68, 70]) {
  const s = ps.find(p => p.eventIndex === eventIndex).snapshot;
  const before = JSON.stringify(s);
  const node = E.createSearchNode(s);
  const run = diff => E.searchMove(s, s.rows, s.cols, s.current, diff, null,
    { nodeLimit: 5000, rules: s.rules, stonesPlacedTotal: s.stonesPlacedTotal, gameOver: s.gameOver });
  const old = run({ ...E.DIFFICULTY.strong, tacticalPly: 0 });
  const fixed = run(E.DIFFICULTY.strong);
  const again = run(E.DIFFICULTY.strong);
  assert(E.isTransitionLegal(node, fixed.move.x, fixed.move.y));
  assert.strictEqual(A.immediateLoss(node, fixed.move).loss, 0, `event ${eventIndex}: avoidable loss`);
  assert(A.immediateLoss(node, old.move).loss > 0, `event ${eventIndex}: ablation must expose bug`);
  assert.deepStrictEqual(fixed.move, again.move, 'deterministic fixed-node search');
  assert.strictEqual(fixed.trace.nodes, again.trace.nodes);
  assert(fixed.trace.nodes <= 5000);
  assert(fixed.trace.completedDepth > 0);
  assert.strictEqual(JSON.stringify(s), before, 'search must not mutate replay snapshot');
  console.log(`event ${eventIndex}: old loss=${A.immediateLoss(node, old.move).loss}, new=0`);
}

// The diagnostic must not invent an opposing move after termination.
const m = E.createMatch({ sizeKey: 'small', targetFillPercent: 1, startPosition: 'empty' });
const n = E.createSearchNode(m.getSnapshot());
const move = A.legalMoves(n)[0];
const t = E.applyTransition(n, n.current, move.x, move.y);
assert(t.node.gameOver, 'fixture must terminate on this move');
assert.strictEqual(A.immediateLoss(n, move).reply, null);
console.log('human-replays: OK');
