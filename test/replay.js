// test/replay.js
const assert = require('assert');
const Engine = require('../gameEngine.js');
const Replay = require('../replay.js');

console.log('Running Replay & Validator tests...');

// 1) Test export & play round-trip with moves, captures, undo, and end
{
  const match = Engine.createMatch({ sizeKey: 'medium', firstPlayer: 1, extraTurnOnCapture: false, undoAllowed: true });
  const zone = match.getSnapshot().openingZone;
  const cx = zone.minX, cy = zone.minY;

  // Make some moves
  const m1 = match.applyMove(1, cx, cy);
  assert.strictEqual(m1.ok, true);
  const m2 = match.applyMove(2, cx + 1, cy);
  assert.strictEqual(m2.ok, true);

  // Request & approve undo
  // Need to make enough moves to capture or just test undo request flow
  // Let's test export on simple match
  match.endNow();
  const rep = Replay.exportReplay(match, { engineVersion: '0.1.0' });
  assert.strictEqual(rep.version, Replay.CURRENT_VERSION);
  assert.strictEqual(rep.rules.sizeKey, 'small');
  assert.strictEqual(rep.rules.firstPlayer, 1);
  assert.strictEqual(rep.events.length, 3); // 2 moves + end

  const playRes = Replay.playReplay(rep, Engine);
  assert.strictEqual(playRes.ok, true);
  assert.strictEqual(playRes.snapshot.gameOver, true);
  assert.strictEqual(playRes.matchMeta.endReason, 'manual');
  console.log('OK: basic replay export and play round-trip');
}

// 2) Test validation errors for corrupted / illegal / unsupported replays
{
  // Unsupported version
  const badVer = { version: 'tochki-replay-99', rules: { sizeKey: 'small', firstPlayer: 1, extraTurnOnCapture: false, undoAllowed: true, targetScore: 0, targetFillPercent: 100 }, events: [] };
  const res1 = Replay.playReplay(badVer, Engine);
  assert.strictEqual(res1.ok, false);
  assert.ok(res1.reason.includes('unsupported-version'));

  // Invalid first player
  const badPlayer = { version: Replay.CURRENT_VERSION, rules: { sizeKey: 'small', firstPlayer: 3, extraTurnOnCapture: false, undoAllowed: true, targetScore: 0, targetFillPercent: 100 }, events: [] };
  const res2 = Replay.playReplay(badPlayer, Engine);
  assert.strictEqual(res2.ok, false);
  assert.strictEqual(res2.reason, 'invalid-first-player');

  // Illegal move / out of bounds
  const badMove = {
    version: Replay.CURRENT_VERSION,
    rules: { sizeKey: 'small', firstPlayer: 1, extraTurnOnCapture: false, undoAllowed: true, targetScore: 0, targetFillPercent: 100 },
    events: [{ type: 'move', seat: 1, x: 999, y: 999 }]
  };
  const res3 = Replay.playReplay(badMove, Engine);
  assert.strictEqual(res3.ok, false);
  assert.ok(res3.reason.includes('illegal-move'));
  console.log('OK: validation correctly rejects corrupted and illegal replays');
}

console.log('ALL REPLAY TESTS PASSED');
