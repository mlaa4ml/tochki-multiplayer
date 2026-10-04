const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const Engine = require('../gameEngine.js');
const Replay = require('../replay.js');

function roundTrip(match){
  const restored = Replay.play(Replay.stringify(match));
  assert.deepStrictEqual(restored.getSnapshot(), match.getSnapshot());
  assert.deepStrictEqual(restored.getReplay(), match.getReplay());
  return restored;
}

// Capture, undo of capture, reapply and manual end; both first players and
// both turn policies. Compare all state layers and the entire public snapshot.
for (const firstPlayer of [1, 2]){
  for (const extraTurnOnCapture of [false, true]){
    const match = Engine.createMatch({ sizeKey: 'small', firstPlayer, extraTurnOnCapture });
    const opponent = 3 - firstPlayer;
    const moves = [[firstPlayer,4,4], [opponent,5,4], [firstPlayer,5,3],
      [opponent,0,0], [firstPlayer,6,4], [opponent,1,0]];
    for (const [p,x,y] of moves) assert(match.applyMove(p,x,y).ok);
    const before = match.getSnapshot();
    const capture = match.applyMove(firstPlayer,5,5);
    assert(capture.ok && capture.gained.length > 0);
    assert.strictEqual(capture.current, extraTurnOnCapture ? firstPlayer : opponent);
    roundTrip(match);
    assert(match.undoLastMove().ok);
    assert.deepStrictEqual(match.getSnapshot(), before);
    roundTrip(match);
    assert(match.applyMove(firstPlayer,5,5).ok);
    assert(match.endNow().ok);
    roundTrip(match);
  }
}

// A rule end must be explicit, immediately after the terminal move.
const terminal = Engine.createMatch({ sizeKey: 'small', targetFillPercent: 1 });
assert(terminal.applyMove(1,4,3).ok);
assert(terminal.applyMove(2,5,3).gameOver);
roundTrip(terminal);
assert.strictEqual(terminal.getReplay().events.at(-1).reason, 'rule');

const active = Engine.createMatch({ sizeKey: 'small' });
active.applyMove(1,4,3);
const holder = { match: active };
const before = active.getSnapshot();
function rejects(input, pattern){
  assert.throws(() => Replay.importInto(holder, input), pattern || /Replay:/);
  assert.strictEqual(holder.match, active);
  assert.deepStrictEqual(active.getSnapshot(), before);
}
function corrupt(change){
  const input = active.getReplay();
  change(input);
  rejects(input);
}
rejects('{broken', /invalid JSON/);
corrupt(r => { r.version = 99; });
corrupt(r => { r.engineVersion = 'unknown'; });
corrupt(r => { delete r.rules.firstPlayer; });
corrupt(r => { r.rules.targetScore = 1.5; });
corrupt(r => { r.rules.targetScore = Infinity; });
corrupt(r => { r.rules.extraTurnOnCapture = 'true'; });
corrupt(r => { r.rules.totalCells++; });
corrupt(r => { r.board.rows = 100000; });
corrupt(r => { r.board.sizeKey = '__proto__'; });
corrupt(r => { r.events[0].player = 2; });
corrupt(r => { r.events[0].x = -1; });
corrupt(r => { r.events[0].x = 0; r.events[0].y = 0; });
corrupt(r => { r.events.push({type:'move', player:2, x:4, y:3}); });
corrupt(r => { r.events = [{type:'undo'}]; });
corrupt(r => { r.rules.undoAllowed = false; r.events.push({type:'undo'}); });
corrupt(r => { r.events.push({type:'unknown'}); });
corrupt(r => { r.events = Array(Replay.MAX_EVENTS + 1).fill({type:'undo'}); });
corrupt(r => { r.metadata.seed = -1; });
corrupt(r => { r.metadata.budgets = { timeLimit: -1 }; });
corrupt(r => { r.metadata.weights = { potential: 1 }; });
rejects(' '.repeat(Replay.MAX_BYTES + 1), /limit/);
const cycle = {}; cycle.self = cycle;
rejects(cycle, /cyclic/);
const missingEnd = terminal.getReplay(); missingEnd.events.pop();
rejects(missingEnd, /missing rule end/);
const badWinner = terminal.getReplay(); badWinner.events.at(-1).winner = 1;
rejects(badWinner, /winner/);
const afterEnd = terminal.getReplay(); afterEnd.events.push({type:'undo'});
rejects(afterEnd, /after end/);
const wrongReason = terminal.getReplay(); wrongReason.events.at(-1).reason = 'manual';
rejects(wrongReason, /requires rule end/);
const earlyEnd = active.getReplay();
earlyEnd.events.push({type:'end', reason:'rule', winner:0, scores:{1:0,2:0}});
rejects(earlyEnd, /without terminal move/);

Replay.importInto(holder, terminal.getReplay());
assert.notStrictEqual(holder.match, active);
assert.deepStrictEqual(holder.match.getSnapshot(), terminal.getSnapshot());

// Browser/offline consumers load exactly the same codec without require/SQLite.
const context = vm.createContext({ TextEncoder });
vm.runInContext(fs.readFileSync(require.resolve('../gameEngine.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(require.resolve('../replay.js'), 'utf8'), context);
const browserMatch = context.TochkiReplay.play(Replay.stringify(terminal));
assert.strictEqual(JSON.stringify(browserMatch.getSnapshot()), JSON.stringify(terminal.getSnapshot()));
console.log('OK: replay round trips, strict rejection, atomic import, browser codec');
