'use strict';
const assert = require('node:assert/strict');
const E = require('../gameEngine');
const Replay = require('../replay');
const { createLocalSession } = require('../offline/localSession');
const { createStorage } = require('../offline/storage');

async function main(){
  const source = E.createMatch({ sizeKey: 'small', firstPlayer: 2, extraTurnOnCapture: true });
  // Capture the enemy centre; verify nonzero scores as well as turn/end.
  for (const [x, y] of [[2, 2], [2, 1], [8, 8], [1, 2], [8, 7], [3, 2], [8, 6], [2, 3]]){
    const snap = source.getSnapshot();
    assert.equal(source.applyMove(snap.current, x, y).ok, true);
  }
  assert.ok(source.getSnapshot().scores[1] > 0);
  source.endNow('manual');
  const session = createLocalSession();
  session.newGame({ controllers: { 1: 'human', 2: 'human' } });
  session.importReplay(Replay.stringify(source));
  assert.deepEqual(session.snapshot(), source.getSnapshot());
  const roundtrip = Replay.play(session.exportReplay());
  assert.deepEqual(roundtrip.getSnapshot(), source.getSnapshot());
  const before = session.snapshot(), status = session.status();
  for (const invalid of ['{broken', { format: 'private-format' }, {
    ...source.getReplay(), events: [...source.getReplay().events, { type: 'undo' }]
  }]){
    assert.throws(() => session.importReplay(invalid), /Replay:/);
    assert.deepEqual(session.snapshot(), before);
    assert.deepEqual(session.status(), status);
  }
  session.importReplay(source.getReplay(), 0);
  assert.equal(session.snapshot().current, 2);
  assert.equal(session.snapshot().gameOver, false);
  assert.deepEqual(session.snapshot().scores, { 1: 0, 2: 0 });
  assert.equal(session.status().running, false);

  // A rule-terminal move requires its adjacent end event even while scrubbing.
  const terminal = E.createMatch({ sizeKey: 'small', targetFillPercent: 1 });
  terminal.applyMove(1, 0, 0);
  const events = terminal.getReplay().events;
  assert.equal(events[events.length - 1].reason, 'rule');
  session.importReplay(terminal.getReplay(), events.length - 1);
  assert.equal(session.snapshot().gameOver, true);

  let warnings = 0;
  const storage = createStorage({
    localStorage: { getItem(){ throw Error('denied'); }, setItem(){ throw Error('QuotaExceededError'); } },
    indexedDB: { open(){ throw Error('denied'); } },
    onError(){ warnings++; }
  });
  assert.equal(storage.load('settings'), null);
  assert.equal(storage.save('autosave', {}), false);
  assert.deepEqual(await storage.list(), []);
  assert.equal(await storage.put('game', {}), null);
  await storage.remove(1);
  assert.ok(warnings >= 5);
  session.newGame({ controllers: { 1: 'human', 2: 'human' } });
  session.subscribe(() => storage.save('autosave', session.getReplay()));
  assert.equal(session.move(0, 0).ok, true);
  assert.equal(session.move(1, 0).ok, true);
  assert.equal(session.end().ok, true);
  assert.equal(session.snapshot().gameOver, true);
  session.dispose();
  console.log('offline replay/storage tests passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
