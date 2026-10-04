'use strict';

// No server, SQLite, DOM or timers. Expected positions are hand-authored;
// only the board expansion and bookkeeping below are mechanical.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const fixtures = require('./fixtures/rules-v1.json');
const nodeEngine = require('../gameEngine');
const browser = { self: {}, performance: { now: () => 0 } };
vm.runInNewContext(fs.readFileSync(require.resolve('../gameEngine'), 'utf8'), browser,
  { filename: 'gameEngine.js' });
const plain = value => JSON.parse(JSON.stringify(value));
const equal = (actual, expected, message) => assert.deepStrictEqual(plain(actual), plain(expected), message);
const empty = (rows, cols) => Array.from({length: rows}, () => Array(cols).fill(0));
function layer(rows, cols, cells = []) {
  const result = empty(rows, cols);
  for (const [x, y, p] of cells) result[y][x] = p;
  return result;
}
const gained = cells => cells.map(([x, y, prevOwner]) => ({x, y, prevOwner}));
const sorted = cells => plain(cells).sort((a, b) => a.y - b.y || a.x - b.x);
function observable(match) {
  return plain({
    snapshot: match.getSnapshot(), log: match.getMoveLog(),
    canUndo: match.canUndoLastMove(), lastMover: match.lastMoverSeat()
  });
}
function expectedSnapshot(options) {
  const sizes = {small: [10,12], medium: [12,16], large: [16,22]};
  const sizeKey = sizes[options.sizeKey] ? options.sizeKey : 'medium';
  const [rows, cols] = sizes[sizeKey];
  const firstPlayer = options.firstPlayer === 2 ? 2 : 1;
  const targetScore = Math.max(0, Math.min(9999, Math.floor(options.targetScore) || 0));
  const fill = typeof options.targetFillPercent === 'number' && !Number.isNaN(options.targetFillPercent)
    ? options.targetFillPercent : 100;
  const targetFillPercent = Math.max(0, Math.min(100, Math.floor(fill)));
  return {
    sizeKey, rows, cols, stone: empty(rows, cols), dead: empty(rows, cols), territory: empty(rows, cols),
    current: firstPlayer, scores: {1:0,2:0}, gameOver:false, stonesPlacedTotal:0,
    openingZone: {minX:Math.floor(cols/2)-2, minY:Math.floor(rows/2)-2,
      maxX:Math.floor(cols/2)+1, maxY:Math.floor(rows/2)+1},
    lastMoveByPlayer:{1:null,2:null}, lastMoverSeat:null, canUndo:false,
    rules: {targetScore, targetFillPercent, scoreRuleActive:targetScore>0,
      fillRuleActive:targetFillPercent>0 && targetFillPercent<100, totalCells:rows*cols,
      extraTurnOnCapture:options.extraTurnOnCapture===true, firstPlayer,
      undoAllowed:options.undoAllowed!==false}
  };
}
function sequence(engine, fixture) {
  const match = engine.createMatch(fixture.options);
  let expected = expectedSnapshot(fixture.options);
  let log = [];
  const history = [];
  const trace = [];
  equal(match.getSnapshot(), expected, fixture.id + ': initial');
  for (const [index, step] of fixture.steps.entries()) {
    const label = `${fixture.id} step ${index + 1}`;
    const before = observable(match);
    let result;
    if (step.move || step.reject) result = match.applyMove(...(step.move || step.reject));
    else if (step.undo) result = match.undoLastMove();
    else if (step.end) result = match.endNow();
    else assert.fail(label + ': unknown operation');
    if (step.reason) {
      equal(result, {ok:false,reason:step.reason}, label);
      equal(observable(match), before, label + ': rejection mutated state/history');
    } else if (step.move) {
      history.push({snapshot:plain(expected), log:plain(log)});
      const [player,x,y] = step.move;
      expected.stone[y][x] = player;
      if (step.dead) expected.dead = layer(expected.rows, expected.cols, step.dead);
      if (step.territory) expected.territory = layer(expected.rows, expected.cols, step.territory);
      if (step.scores) expected.scores = {1:step.scores[0],2:step.scores[1]};
      expected.stonesPlacedTotal++;
      expected.current = step.current ?? (3-player);
      expected.gameOver = step.gameOver || false;
      expected.lastMoveByPlayer[player] = {x,y};
      expected.lastMoverSeat = player;
      expected.canUndo = expected.rules.undoAllowed && !expected.gameOver;
      const changes = gained(step.gained || []);
      log.push({x,y,p:player,gained:changes.length});
      equal({...plain(result), gained:sorted(result.gained)}, {
        ok:true,player,x,y,gained:sorted(changes),scores:expected.scores,
        current:expected.current, gameOver:expected.gameOver,
        winner:step.winner ?? null, extraTurn:step.extraTurn || false,
        stonesPlacedTotal:expected.stonesPlacedTotal
      }, label + ': move result');
    } else if (step.undo) {
      const previous = history.pop();
      assert.ok(previous, label + ': fixture has no undo history');
      expected = previous.snapshot;
      log = previous.log;
      equal(result, {ok:true,current:expected.current,scores:expected.scores,
        stonesPlacedTotal:expected.stonesPlacedTotal}, label + ': undo result');
    } else {
      expected.gameOver = true;
      expected.canUndo = false;
      equal(result, {ok:true,gameOver:true,winner:step.winner,scores:expected.scores}, label);
    }
    equal(match.getSnapshot(), expected, label + ': all snapshot fields');
    equal(match.getMoveLog(), log, label + ': log');
    assert.equal(match.canUndoLastMove(), expected.canUndo, label);
    assert.equal(match.lastMoverSeat(), expected.lastMoverSeat, label);
    trace.push({result:plain(result), state:observable(match)});
  }
  // Public snapshots must not provide write access to the match.
  const before = observable(match);
  const snapshot = match.getSnapshot();
  snapshot.stone[0][0] = 99;
  snapshot.dead[0][0] = 99;
  snapshot.territory[0][0] = 99;
  snapshot.scores[1] = 99;
  snapshot.rules.firstPlayer = 99;
  for (const p of [1,2]) if (snapshot.lastMoveByPlayer[p]) snapshot.lastMoveByPlayer[p].x = 99;
  equal(observable(match), before, fixture.id + ': snapshot isolation');
  return trace;
}
function fullBoard(engine) {
  const f = fixtures.fullBoard;
  const steps = f.opening.map(move => ({move}));
  const queues = {1:[],2:[]};
  for (let y=0; y<10; y++) for (let x=0; x<12; x++) {
    const p = x<6 ? 1 : 2;
    if (!f.opening.some(([,ox,oy]) => ox===x && oy===y)) queues[p].push([p,x,y]);
  }
  for (let i=0; i<59; i++) for (const p of [1,2]) steps.push({move:queues[p][i]});
  Object.assign(steps.at(-1), {gameOver:true, winner:f.expectedWinner,
    current:f.expectedCurrent, scores:f.expectedScores});
  steps.push({reject:[1,0,0],reason:'game-over'});
  const trace = sequence(engine, {...f,steps});
  assert.equal(trace.at(-1).state.snapshot.stonesPlacedTotal, f.expectedStones);
  return trace;
}
function suite(engine) {
  const trace = [];
  for (const f of fixtures.positions) {
    const state = {stone:layer(f.rows,f.cols,f.stone),dead:layer(f.rows,f.cols,f.dead),
      territory:layer(f.rows,f.cols,f.territory)};
    const result = engine.runCaptures(state,f.player,f.rows,f.cols);
    equal(state, {stone:layer(f.rows,f.cols,f.stone),
      dead:layer(f.rows,f.cols,f.expectedDead),territory:layer(f.rows,f.cols,f.expectedTerritory)}, f.id);
    equal(sorted(result), sorted(gained(f.gained)), f.id + ': gained/previous ownership');
    equal(engine.runCaptures(state,f.player,f.rows,f.cols), [], f.id + ': idempotent');
    trace.push(plain({state,result}));
  }
  for (const f of fixtures.sequences) trace.push(sequence(engine,f));
  trace.push(fullBoard(engine));
  for (const options of [
    {}, {sizeKey:'unknown',firstPlayer:'2',extraTurnOnCapture:1,undoAllowed:0},
    {sizeKey:'large',targetScore:2.9,targetFillPercent:3.9,firstPlayer:2},
    {targetScore:-5,targetFillPercent:-1}, {targetScore:10000,targetFillPercent:200},
    {targetScore:'7',targetFillPercent:'20'}, {targetScore:NaN,targetFillPercent:NaN}
  ]) equal(engine.createMatch(options).getSnapshot(), expectedSnapshot(options), 'option normalization');

  // Every supported size and both first players: both opening moves must
  // obey the zone, not merely the first player's opening.
  for (const sizeKey of ['small','medium','large']) for (const firstPlayer of [1,2]) {
    const options = {sizeKey,firstPlayer,targetFillPercent:100};
    const z = expectedSnapshot(options).openingZone;
    trace.push(sequence(engine, {id:`opening-${sizeKey}-${firstPlayer}`,options,steps:[
      {reject:[firstPlayer,z.minX-1,z.minY],reason:'illegal-cell'},
      {move:[firstPlayer,z.minX,z.minY]},
      {reject:[3-firstPlayer,z.maxX+1,z.maxY],reason:'illegal-cell'},
      {move:[3-firstPlayer,z.maxX,z.maxY]},
      {move:[firstPlayer,0,0]}
    ]}));
  }
  return trace;
}
const nodeTrace = suite(nodeEngine);
const browserTrace = suite(browser.self.TochkiEngine);
equal(browserTrace,nodeTrace,'Node and browser UMD API disagree');
console.log(`PASS rules-v1: ${fixtures.positions.length} capture positions, ${fixtures.sequences.length} sequences, full board, options, openings; Node/browser API parity`);
