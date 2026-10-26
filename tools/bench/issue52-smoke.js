'use strict';
// Small paired smoke check, NOT a strength acceptance gate.
// node tools/bench/issue52-smoke.js > tools/bench/reports/issue52-smoke.json
const E = require('../../gameEngine');
const R = require('./runner');
const nodeLimit = 300;
const games = [];
for (const candidateSeat of [1, 2]) {
  const players = {};
  for (const seat of [1, 2]) players[seat] = R.makeSearchPlayer(E, {
    difficulty: { ...E.DIFFICULTY.strong, tacticalPly: seat === candidateSeat ? 1 : 0 },
    nodeLimit
  });
  const { result } = R.playGame(E, {
    rules: { sizeKey: 'small', startPosition: 'cross', targetFillPercent: 64,
      targetScore: 0, firstPlayer: 2, extraTurnOnCapture: false },
    players, maxMoves: 150
  });
  if (result.truncated) throw new Error('smoke game did not finish');
  games.push({ candidateSeat, ...result });
}
console.log(JSON.stringify({ nodeLimit, purpose: 'paired legality/performance smoke, not statistical evidence', games }, null, 2));
