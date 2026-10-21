'use strict';
// A08: exhaustive legal-move oracle, independent of candidate topology/ranking.
const assert = require('assert');
const E = require('../gameEngine');
const key = c => `${c.x},${c.y}`;
function position(rows, cols, stones, rules = {}, current = 1){
  const s = E.createEmptyState(rows, cols);
  for (const [x,y,p] of stones) s.stone[y][x] = p;
  return E.createSearchNode({...s, rows, cols, current, rules});
}
function legal(n){
  const out = [];
  for (let y=0;y<n.rows;y++) for (let x=0;x<n.cols;x++)
    if (E.isTransitionLegal(n,x,y)) out.push({x,y});
  return out;
}
function attacks(n){
  return legal(n).filter(c => {
    const t = E.applyTransition(n,n.current,c.x,c.y);
    return (t.node.gameOver && t.node.winner === n.current)
      || t.result.gained.some(g => g.kind === 'captured');
  });
}
function oracle(n){
  const required = new Map(attacks(n).map(c => [key(c),c]));
  const opp = E.cloneSearchNode(n); opp.current = 3-n.current;
  if (attacks(opp).length) for (const c of legal(n)){
    const t = E.applyTransition(n,n.current,c.x,c.y).node;
    if ((t.gameOver && t.winner !== 3-n.current)
      || (!t.gameOver && (t.current === n.current || attacks(t).length === 0)))
      required.set(key(c),c);
  }
  return [...required.values()];
}
const ring = [[2,2,2],[1,2,1],[2,1,1],[3,2,1]];
const fixtures = [
  ['capture', position(5,5,ring)],
  ['unique-defence', position(5,5,ring,{},2)],
  ['threshold-win', position(5,5,ring,{targetScore:1})],
  ['extra-turn', position(5,5,ring,{extraTurnOnCapture:true})],
  ['fill-end', position(5,5,ring,{targetFillPercent:20})],
  ['remote-flank', position(10,12,[[8,6,2],[7,6,1],[8,5,1],[9,6,1],[1,1,2],[1,2,1]])]
];
function verify(name,n){
  const expected = oracle(n);
  for (const cap of [1,3,10]){
    const chosen = new Set(E.searchCandidates(n,E.DIFFICULTY.normal,cap).map(key));
    for (const c of expected) assert(chosen.has(key(c)), `${name} cap=${cap}: missing ${key(c)}`);
  }
  const fast = E.immediateTactics(n).map(key).sort();
  assert.deepStrictEqual(fast,attacks(n).map(key).sort(),`${name}: topology vs exhaustive`);
  assert.deepStrictEqual(E.tacticalCandidates(n,E.DIFFICULTY.normal).map(key).sort(),
    expected.map(key).sort(),`${name}: all mandatory moves`);
}
for (const [name,n] of fixtures) verify(name,n);
assert.strictEqual(oracle(fixtures[1][1]).length,1,'fixture really has only one defence');
assert(E.searchCandidates(fixtures[0][1],E.DIFFICULTY.normal,1).length>1,'soft beam overflow');
const extra = E.applyTransition(fixtures[3][1],1,2,3);
assert(extra.ok && extra.node.current===1 && extra.result.extraTurn,'capture keeps turn');
const win = E.applyTransition(fixtures[2][1],1,2,3);
assert(win.node.gameOver && win.node.winner===1,'threshold fixture wins');
// Far flank is outside radius=1; strategic selection must reserve it anyway.
const flank = fixtures[5][1];
const local = new Set(E.generateCandidates(flank.state,10,12,1).map(key));
assert(E.searchCandidates(flank,{...E.DIFFICULTY.normal,radius:1,tactical:false},1)
  .some(c => !local.has(key(c))),'strategic remote moves survive beam=1');
// Deterministic reachable small boards, including fill, score and extra-turn rules.
let seed=813;
function random(){ seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; }
for (let run=0;run<18;run++){
  let n=position(5,5,[],{targetScore:run%3===0?1:0,
    targetFillPercent:run%3===1?60:100,extraTurnOnCapture:run%2===0});
  for (let ply=0;ply<18 && !n.gameOver;ply++){
    if (ply>=2 && ply%3===2) verify(`random-${run}-${ply}`,n);
    const cells=legal(n); if (!cells.length) break;
    const c=cells[Math.floor(random()*cells.length)];
    n=E.applyTransition(n,n.current,c.x,c.y).node;
  }
}
module.exports = { fixtures, oracle, legal };
console.log('OK: A08 exhaustive candidates, capture/defence/threshold/extra-turn/flank');
