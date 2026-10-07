'use strict';

// Differential rule trees plus deterministic search checks (no wall-clock races).
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const E = require('../gameEngine');
const fixtures = require('./fixtures/rules-v2.json');
let edges = 0, terminals = 0, captures = 0, suicides = 0, extraTurns = 0;

function compare(node, snap){
  for (const key of ['stone', 'dead', 'territory'])
    assert.deepStrictEqual(node.state[key], snap[key], key);
  for (const key of ['scores', 'current', 'stonesPlacedTotal', 'gameOver'])
    assert.deepStrictEqual(node[key], snap[key], key);
  assert.strictEqual(node.winner, snap.gameOver
    ? (snap.scores[1] > snap.scores[2] ? 1 : snap.scores[2] > snap.scores[1] ? 2 : 0) : null);
}

function step(match, node, player, x, y){
  const before = JSON.stringify(node);
  const snapBefore = JSON.stringify(match.getSnapshot());
  const replayBefore = JSON.stringify(match.getReplay());
  const result = E.applyTransition(node, player, x, y);
  assert.strictEqual(JSON.stringify(node), before, 'pure transition mutated input');
  const actual = match.applyMove(player, x, y);
  const {node: next, ...publicResult} = result;
  assert.deepStrictEqual(publicResult, actual, 'public result');
  if (!result.ok){
    assert.strictEqual(JSON.stringify(match.getSnapshot()), snapBefore);
    assert.strictEqual(JSON.stringify(match.getReplay()), replayBefore);
    return node;
  }
  edges++;
  captures += result.gained.filter(g => g.kind === 'captured').length;
  suicides += Number(result.suicide.length > 0);
  extraTurns += Number(result.extraTurn);
  compare(next, match.getSnapshot());
  return next;
}

function rejectProbes(match, node){
  const p = node.current;
  step(match, node, 3 - p, 0, 0);
  for (const [x,y] of [[-1,0], [node.cols,0], [1.5,0]])
    step(match, node, p, x, y);
  if (node.stonesPlacedTotal < 2) step(match, node, p, 0, 0);
  outer: for (let y=0; y<node.rows; y++) for (let x=0; x<node.cols; x++){
    if (node.state.stone[y][x]){
      step(match, node, p, x, y);
      break outer;
    }
  }
}

function terminalChecks(match, node){
  terminals++;
  assert.strictEqual(node.gameOver, true);
  for (let y=0; y<node.rows; y++) for (let x=0; x<node.cols; x++)
    assert.strictEqual(E.isLegalTransition(node, x, y), false);
  step(match, node, node.current, 0, 0);
  assert.strictEqual(E.chooseMove(node.state, node.rows, node.cols, node.current,
    E.DIFFICULTY.normal, E.BOT_WEIGHTS, node), null);
  assert.strictEqual(match.botMove('normal'), null);
}

function restore(options, path){
  const match = E.createMatch(options);
  for (const [p,x,y] of path) assert(match.applyMove(p,x,y).ok);
  return match;
}

// At every edge compare all board layers, scores, turn and terminal result.
// Bound breadth/depth rather than relying on timeouts.
function tree(options, path, depth){
  const match = restore(options, path);
  const node = E.createSearchNode(match.getSnapshot());
  compare(node, match.getSnapshot());
  rejectProbes(match, node);
  if (node.gameOver){ terminalChecks(match, node); return; }
  if (!depth) return;
  const legal = [];
  for (let y=0; y<node.rows; y++) for (let x=0; x<node.cols; x++)
    if (E.isLegalTransition(node,x,y)) legal.push([x,y]);
  const chosen = legal.filter((_,i) => i % Math.max(1,Math.floor(legal.length / 4)) === 0).slice(0,4);
  // Always include the capture-closing cell in the prepared position.
  if (E.isLegalTransition(node,7,6)) chosen.push([7,6]);
  for (const [x,y] of chosen){
    const branch = restore(options, path);
    step(branch, node, node.current, x, y);
    tree(options, [...path, [node.current,x,y]], depth-1);
  }
}

const capturePrefix = fixtures.sequences[0].moves.slice(0,-1);
for (const firstPlayer of [1,2]) for (const extraTurnOnCapture of [false,true]){
  for (const rules of [{}, {targetScore:1}, {targetScore:3}, {targetFillPercent:1}, {targetFillPercent:6}]){
    const options = {sizeKey:'medium', firstPlayer, extraTurnOnCapture, ...rules};
    tree(options, [], 2);
    if (rules.targetFillPercent !== 1)
      tree(options, capturePrefix.map(([p,x,y]) => [firstPlayer === 1 ? p : 3-p,x,y]), 2);
  }
}

// A01 fixtures independently anchor semantics (including liberation, enemy
// territory suicide, undo, endNow and illegal moves), not just shared code.
for (const fixture of fixtures.sequences){
  const match = E.createMatch(fixture.options);
  let node = E.createSearchNode(match.getSnapshot());
  for (const [p,x,y] of fixture.moves) node = step(match,node,p,x,y);
  for (const action of fixture.then || []){
    if (action.move) node = step(match,node,...action.move);
    else {
      if (action.undo) match.undoLastMove();
      if (action.endNow) match.endNow();
      node = E.createSearchNode(match.getSnapshot());
    }
    compare(node,match.getSnapshot());
  }
}

// Full field: no captures, alternating vertical stripes.
for (const firstPlayer of [1,2]){
  const match = E.createMatch({sizeKey:'small',firstPlayer});
  let node = E.createSearchNode(match.getSnapshot());
  const starts = firstPlayer === 1 ? [[1,4,3],[2,5,3]] : [[2,5,3],[1,4,3]];
  for (const move of starts) node = step(match,node,...move);
  const cells = {1:[],2:[]};
  for (let y=0;y<node.rows;y++) for (let x=0;x<node.cols;x++)
    if (!node.state.stone[y][x]) cells[x % 2 ? 2 : 1].push([x,y]);
  while (!node.gameOver){
    const p = node.current;
    assert(cells[p].length);
    node = step(match,node,p,...cells[p].shift());
  }
  assert.strictEqual(node.stonesPlacedTotal,120);
  assert.strictEqual(node.winner,0);
  terminalChecks(match,node);
}

// Test actual alpha-beta with a frozen clock, exposing private functions only
// inside this test's VM. Its result must equal a small independent minimax
// recurrence over pure transitions, including consecutive turns by one seat.
const sandbox = {module:{exports:{}}, performance:{now:() => 0}};
vm.runInNewContext(fs.readFileSync(require.resolve('../gameEngine'),'utf8')
  .replace('chooseMove, isBoardFull,', '_alphaBeta: alphaBeta, _searchValue: searchValue, chooseMove, isBoardFull,'), sandbox);
const S = sandbox.module.exports;
const diff = {radius:2, candidateCap:1000, timeLimit:1000, maxDepth:2,
  branchWide:1000, branchMid:1000, branchNarrow:1000, quiescenceExt:0};
function minimax(node, depth, forPlayer){
  const terminal = E.terminalValue(node,forPlayer,2-depth);
  if (terminal !== null) return terminal;
  if (!depth) return S._searchValue(node,forPlayer,E.BOT_WEIGHTS);
  const moves = E.generateCandidates(node.state,node.rows,node.cols,diff.radius)
    .filter(c => E.isLegalTransition(node,c.x,c.y));
  const values = moves.map(c => minimax(E.applyTransition(node,node.current,c.x,c.y).node,depth-1,forPlayer));
  return values.length ? (node.current === forPlayer ? Math.max(...values) : Math.min(...values))
    : S._searchValue(node,forPlayer,E.BOT_WEIGHTS);
}
for (const firstPlayer of [1,2]) for (const extraTurnOnCapture of [false,true]){
  const options = {sizeKey:'medium',firstPlayer,extraTurnOnCapture,targetScore:1};
  const prefix = capturePrefix.map(([p,x,y]) => [firstPlayer === 1 ? p : 3-p,x,y]);
  const match = restore(options,prefix);
  const node = E.createSearchNode(match.getSnapshot());
  // Even adversarial custom weights cannot outweigh immediate victory.
  const hostileWeights = {potential:-1e20,cohesion:-1e20,stones:-1e20,liberty:-1e20};
  for (const difficulty of ['normal','strong']){
    const move = match.botMove(difficulty,hostileWeights);
    assert.deepStrictEqual([move.x,move.y],[7,6]);
  }
  const won = E.applyTransition(node,node.current,7,6).node;
  assert.strictEqual(won.winner,firstPlayer);
  assert(E.terminalValue(won,firstPlayer) > 5e8);
  assert(E.terminalValue(won,3-firstPlayer) < -5e8);
  terminalChecks(restore(options,[...prefix,[firstPlayer,7,6]]),won);

  const continuing = restore({...options,targetScore:0},prefix);
  const start = E.createSearchNode(continuing.getSnapshot());
  const after = step(continuing,start,start.current,7,6);
  assert.strictEqual(after.current,extraTurnOnCapture ? firstPlayer : 3-firstPlayer);
  assert.strictEqual(S._alphaBeta(after,2,-Infinity,Infinity,diff,1000,
    firstPlayer,E.BOT_WEIGHTS,0,0), minimax(after,2,firstPlayer));
}
// Exercise the real CLI consumer, checking the complete context at its
// chooseMove boundary rather than merely grepping the call site.
const trainer = require('../tools/train-bot');
const originalChooseMove = E.chooseMove;
let cliCalls = 0;
try {
  E.chooseMove = (state, rows, cols, mover, searchDiff, weights, context) => {
    cliCalls++;
    assert(context && context.rules);
    assert.strictEqual(context.rules.targetScore,1);
    assert.strictEqual(context.rules.targetFillPercent,80);
    assert.strictEqual(context.rules.extraTurnOnCapture,true);
    assert.strictEqual(context.stonesPlacedTotal,6);
    assert.strictEqual(context.gameOver,false);
    assert.strictEqual(mover,2);
    return originalChooseMove(state,rows,cols,mover,searchDiff,weights,context);
  };
  const winner = trainer.playSelfPlayGame('medium',{
    prefix:capturePrefix.map(([p,x,y]) => ({seat:3-p,x,y})),
    targetScore:1,targetFillPercent:80,firstPlayer:2,extraTurnOnCapture:true
  },{1:E.BOT_WEIGHTS,2:E.BOT_WEIGHTS},1);
  assert.strictEqual(winner,2);
  assert.strictEqual(cliCalls,1);
} finally {
  E.chooseMove = originalChooseMove;
}
assert(captures > 0 && suicides > 0 && extraTurns > 0 && terminals > 0);
console.log(`transition: OK (${edges} edges, ${captures} captures, ${suicides} suicides, ${extraTurns} extra turns, ${terminals} terminal checks)`);
