'use strict';
// Offline diagnostic for issue #52. Never treats recorded moves as optimal labels.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Engine = require('../../gameEngine');
const Replay = require('../../replay');

const corpusDir = path.join(__dirname, 'corpus/human');
function loadGames() {
  const games = [];
  for (const file of ['issue52-replays01.json', 'issue52-replays02.json']) {
    const entries = JSON.parse(fs.readFileSync(path.join(corpusDir, file), 'utf8'));
    entries.forEach((entry, index) => {
      const replay = JSON.parse(JSON.stringify(entry.replay));
      // Attachments use legacy offline trace metadata, not replay.js decision
      // metadata. Keep the original files intact; omit only this diagnostic field.
      replay.events.forEach(e => { delete e.decision; });
      const end = Replay.play(replay).getSnapshot(); // validate rules, events and final scores
      games.push({ id: file + '#' + index, replay, original: entry.replay, end });
    });
  }
  return games;
}

function positions(game) {
  const match = Engine.createMatch({ sizeKey: game.replay.board.sizeKey, ...game.replay.rules });
  const out = [];
  game.replay.events.forEach((e, eventIndex) => {
    if (e.type === 'move') {
      out.push({ eventIndex, move: e, snapshot: match.getSnapshot() });
      assert(match.applyMove(e.player, e.x, e.y).ok);
    } else if (e.type === 'undo') {
      assert(match.undoLastMove().ok);
    } else if (e.type === 'end' && e.reason !== 'rule') {
      assert(match.endNow(e.reason).ok);
    }
  });
  return out;
}

function legalMoves(node) {
  const moves = [];
  for (let y = 0; y < node.rows; y++) for (let x = 0; x < node.cols; x++) {
    if (Engine.isTransitionLegal(node, x, y)) moves.push({ x, y });
  }
  return moves;
}

// Actual score loss now + on the next opposing move; not a two-pass threat
// with an invented turn. Terminal nodes and extra turns have no opposing reply.
function immediateLoss(node, move) {
  const p = node.current, opp = 3 - p;
  const t = Engine.applyTransition(node, p, move.x, move.y);
  assert(t.ok);
  let loss = t.node.scores[opp] - node.scores[opp], reply = null;
  if (!t.node.gameOver && t.node.current === opp) {
    for (const c of legalMoves(t.node)) {
      const u = Engine.applyTransition(t.node, opp, c.x, c.y);
      const value = u.node.scores[opp] - node.scores[opp];
      if (value > loss) { loss = value; reply = c; }
    }
  }
  return { loss, reply };
}

function analyze() {
  const report = { games: [], blunders: [] };
  for (const game of loadGames()) {
    const ps = positions(game);
    report.games.push({ id: game.id, size: game.replay.board.sizeKey,
      moves: ps.length, scores: game.end.scores, rules: game.replay.rules });
    for (const pos of ps) {
      // Both supplied attachments identify seat 2 as the strong bot.
      if (pos.move.player !== 2) continue;
      const node = Engine.createSearchNode(pos.snapshot);
      const recorded = immediateLoss(node, pos.move);
      if (recorded.loss <= 0) continue;
      let minimum = recorded.loss, best = [];
      for (const c of legalMoves(node)) {
        const risk = immediateLoss(node, c).loss;
        if (risk < minimum) { minimum = risk; best = [c]; }
        else if (risk === minimum) best.push(c);
      }
      report.blunders.push({ id: game.id, eventIndex: pos.eventIndex,
        recorded: { x: pos.move.x, y: pos.move.y }, ...recorded, minimum, best });
    }
  }
  return report;
}

if (require.main === module) console.log(JSON.stringify(analyze(), null, 2));
module.exports = { loadGames, positions, legalMoves, immediateLoss, analyze };
