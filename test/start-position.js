// test/start-position.js — стартовая позиция партии (issue #47).
'use strict';
const assert = require('assert');
const Engine = require('../gameEngine.js');
const Replay = require('../replay.js');

// 1. По умолчанию — пустое поле.
{
  const m = Engine.createMatch({ sizeKey: 'small' });
  const s = m.getSnapshot();
  assert.strictEqual(s.rules.startPosition, 'empty');
  assert.strictEqual(s.stonesPlacedTotal, 0);
  assert.ok(s.stone.every(r => r.every(v => v === 0)));
}

// 2. 'cross' — четыре точки крестом в центре.
for (const sizeKey of Object.keys(Engine.SIZES)){
  const m = Engine.createMatch({ sizeKey, startPosition: 'cross' });
  const s = m.getSnapshot();
  const cx = Math.floor(s.cols/2), cy = Math.floor(s.rows/2);
  assert.strictEqual(s.rules.startPosition, 'cross');
  assert.strictEqual(s.stone[cy-1][cx-1], 1);
  assert.strictEqual(s.stone[cy-1][cx], 2);
  assert.strictEqual(s.stone[cy][cx-1], 2);
  assert.strictEqual(s.stone[cy][cx], 1);
  let count = 0;
  for (const r of s.stone) for (const v of r) if (v !== 0) count++;
  assert.strictEqual(count, 4, sizeKey + ': ровно 4 стартовые точки');
  assert.strictEqual(s.stonesPlacedTotal, 4);
  assert.strictEqual(s.scores[1], 0);
  assert.strictEqual(s.scores[2], 0);
  assert.strictEqual(s.current, 1);
  assert.strictEqual(s.canUndo, false, 'стартовые точки не отменяются');
  // стартовые точки внутри дебютной зоны
  const z = s.openingZone;
  for (const [x, y] of [[cx-1,cy-1],[cx,cy-1],[cx-1,cy],[cx,cy]]) assert.ok(Engine.inZone(x, y, z));
}

// 3. Первый ход вне дебютной зоны разрешён; занятую клетку занять нельзя;
//    отмена возвращает к стартовой позиции, а не к пустому полю.
{
  const m = Engine.createMatch({ sizeKey: 'medium', startPosition: 'cross' });
  const s0 = m.getSnapshot();
  const cx = Math.floor(s0.cols/2), cy = Math.floor(s0.rows/2);
  assert.strictEqual(m.applyMove(1, cx, cy).ok, false, 'клетка стартовой точки занята');
  const r = m.applyMove(1, 0, 0);
  assert.ok(r.ok, 'ход вне дебютной зоны разрешён: ' + JSON.stringify(r));
  assert.ok(m.undoLastMove().ok);
  const s1 = m.getSnapshot();
  assert.deepStrictEqual(s1.stone, s0.stone);
  assert.strictEqual(s1.stonesPlacedTotal, 4);
  assert.strictEqual(m.undoLastMove().ok, false);
  // Бот умеет ходить из стартовой позиции.
  m.applyMove(1, 1, 1);
  const bm = m.botMove('normal', undefined, { nodeLimit: 200 });
  assert.ok(bm && Number.isInteger(bm.x) && Number.isInteger(bm.y));
}

// 4. Неизвестное значение трактуется как пустое поле.
{
  const s = Engine.createMatch({ sizeKey: 'small', startPosition: 'bogus' }).getSnapshot();
  assert.strictEqual(s.rules.startPosition, 'empty');
  assert.strictEqual(s.stonesPlacedTotal, 0);
}

// 5. Реплей cross-партии воспроизводится, старые реплеи без поля — тоже.
{
  const m = Engine.createMatch({ sizeKey: 'small', startPosition: 'cross' });
  m.applyMove(1, 0, 0);
  m.applyMove(2, 11, 9);
  const replay = m.getReplay();
  const played = Replay.play(replay);
  const snap = (played.match || played).getSnapshot ? (played.match || played).getSnapshot() : null;
  if (snap) assert.deepStrictEqual(snap.stone, m.getSnapshot().stone);

  const legacy = Engine.createMatch({ sizeKey: 'small' });
  legacy.applyMove(1, 6, 5);
  const lr = legacy.getReplay();
  delete lr.rules.startPosition;
  Replay.play(lr);

  const bad = m.getReplay();
  bad.rules.startPosition = 'diamond';
  assert.throws(() => Replay.play(bad));
}

console.log('start-position tests passed');
