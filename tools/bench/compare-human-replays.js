'use strict';
// #52: diagnostic ablation, NOT an independent strength benchmark.
// node tools/bench/compare-human-replays.js > tools/bench/reports/issue52-replies.json
const E = require('../../gameEngine');
const A = require('./analyze-human-replays');

function compare() {
  const analysis = A.analyze();
  const report = {
    nodeLimit: 5000, difficulty: 'strong',
    metric: 'maximum opposing score gain through the next legal opposing move',
    games: analysis.games,
    positions: []
  };
  for (const game of A.loadGames()) {
    const ps = A.positions(game);
    for (const b of analysis.blunders.filter(b => b.id === game.id)) {
      const s = ps.find(p => p.eventIndex === b.eventIndex).snapshot;
      const node = E.createSearchNode(s);
      const row = { id: b.id, eventIndex: b.eventIndex,
        recordedLoss: b.loss, minimumLoss: b.minimum, variants: {} };
      for (const tacticalPly of [0, 1]) {
        const r = E.searchMove(s, s.rows, s.cols, s.current,
          { ...E.DIFFICULTY.strong, tacticalPly }, null,
          { nodeLimit: report.nodeLimit, rules: s.rules,
            stonesPlacedTotal: s.stonesPlacedTotal, gameOver: s.gameOver });
        row.variants[tacticalPly] = { move: r.move,
          loss: A.immediateLoss(node, r.move).loss,
          nodes: r.trace.nodes, completedDepth: r.trace.completedDepth,
          stopReason: r.trace.stopReason, elapsedMs: r.trace.elapsedMs };
      }
      report.positions.push(row);
    }
  }
  report.summary = { improved: 0, worsened: 0, equal: 0 };
  for (const p of report.positions) {
    const delta = p.variants[1].loss - p.variants[0].loss;
    report.summary[delta < 0 ? 'improved' : delta > 0 ? 'worsened' : 'equal']++;
  }
  return report;
}
if (require.main === module) console.log(JSON.stringify(compare(), null, 2));
module.exports = { compare };
