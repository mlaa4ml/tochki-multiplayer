// Exercise an on-disk pre-A02 schema and reopening the migrated database.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../db.js');
const { createGameLog } = require('../gamelog.js');
const Engine = require('../gameEngine.js');
const Replay = require('../replay.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tochki-replay-'));
const filename = path.join(dir, 'old.db');
let db;
try {
  db = openDatabase(filename);
  db.exec(`
    ALTER TABLE games DROP COLUMN replay_status;
    ALTER TABLE games DROP COLUMN replay_json;
    INSERT INTO games (room_code, size_key, target_score, target_fill_percent,
      status, started_at, ended_at)
    VALUES ('OLD', 'small', 5, 0, 'finished', 1, 2);
    INSERT INTO moves (game_id, move_index, seat, x, y, score1_after, score2_after, created_at)
    VALUES (1, 0, 1, 4, 3, 0, 0, 1);
  `);
  db.close();
  db = openDatabase(filename);
  let log = createGameLog(db);
  const old = log.getGameByRoomCode('OLD');
  assert.strictEqual(old.game.replay_status, 'legacy');
  assert.strictEqual(old.replay.exact, false);
  assert.match(old.replay.reason, /Missing original rules/);
  assert.strictEqual(old.moves.length, 1);
  assert.strictEqual(db.prepare('SELECT replay_json FROM games WHERE id=1').get().replay_json, null);
  assert.throws(() => Replay.play(old.replay), /Replay:/);
  assert.strictEqual(log.getFinishedGamesForTraining()[0].replay.exact, false);

  const room = {
    code: 'NEW', match: Engine.createMatch({ sizeKey: 'small', firstPlayer: 2,
      extraTurnOnCapture: true }), vsBot: false,
    playerUserIds: {}, playerNames: {}
  };
  room.gameId = log.startGame(room);
  assert.strictEqual(log.getGameByRoomCode('NEW').replay.exact, true);
  const expected = room.match.getReplay();
  db.close();
  db = openDatabase(filename); // migration is idempotent; exact data survives
  log = createGameLog(db);
  assert.strictEqual(log.getGameByRoomCode('OLD').replay.exact, false);
  const record = log.getGameByRoomCode('NEW');
  assert.deepStrictEqual(record.replay.data, expected);
  assert.deepStrictEqual(Replay.play(record.replay.data).getSnapshot(), room.match.getSnapshot());
  console.log('OK: on-disk migration, legacy reads, idempotency and exact replay persistence');
} finally {
  if (db && db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
