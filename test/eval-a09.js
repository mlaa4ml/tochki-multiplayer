'use strict';
const assert = require('node:assert/strict');
const E = require('../gameEngine');
function ring({gap=true,enemy=true,rows=7,cols=7}={}){
  const s=E.createEmptyState(rows,cols);
  for(let y=1;y<=5;y++) for(let x=1;x<=5;x++)
    if(x===1||x===5||y===1||y===5) s.stone[y][x]=1;
  if(gap) s.stone[1][3]=0;
  if(enemy) s.stone[3][3]=2;
  return E.createSearchNode({...s,rows,cols,current:1,rules:{}});
}
function run(){
  let n=0;
  const test=(name,f)=>{f();n++;console.log('ok A09 '+name);};
  test('edge with zero liberties survives',()=>{
    const s=E.createEmptyState(5,5);
    s.stone[0][0]=2;s.stone[0][1]=s.stone[1][0]=1;
    assert.equal(E.computeGroupLiberties(s,5,5,2)[0].liberties,0);
    E.runCaptures(s,1,5,5);assert.equal(s.dead[0][0],0);
  });
  test('empty enclosure has no points or regional value',()=>{
    const node=ring({gap:false,enemy:false});
    E.runCaptures(node.state,1,7,7);
    assert.deepEqual(E.createSearchNode({...node.state,rows:7,cols:7}).scores,{1:0,2:0});
    assert.equal(E.edgePressure(node.state,7,7,1),0);
    assert.equal(E.closureThreat(node,1).gain,0);
  });
  test('interior narrow exit costs one legal move to close',()=>{
    const node=ring(), t=E.closureThreat(node,1);
    assert.equal(t.gain,1);
    assert(t.moves.some(m=>m.x===3&&m.y===1));
    assert.equal(E.applyTransition(node,1,3,1).node.scores[1],1);
    assert.equal(node.state.dead[3][3],0);
  });
  test('whole region includes multiple enemy stones',()=>{
    const node=ring();node.state.stone[3][2]=2;
    assert.equal(E.closureThreat(node,1).gain,2);
  });
  test('phase removes only the empty potential reward',()=>{
    const node=ring({gap:false,enemy:false});
    const p=E.computeTerritoryPotential(node.state,7,7);
    assert(p[1]>0);
    const f=E.enclosureFeatures(node,{phase:1});
    assert(f.phase<0);
    assert.equal(f.edgeEscape,0);
  });
  test('score threshold suppresses shape and terminal victory wins',()=>{
    let node=ring();node.rules=E.normalizeRules({targetScore:1});
    const w={...E.BOT_WEIGHTS,endgameScore:1};
    assert.equal(E.evaluateStatic(node.state,7,7,1,w,node),0);
    const child=E.applyTransition(node,1,3,1).node;
    assert(child.gameOver);assert.equal(child.winner,1);
    assert(E.terminalValue(child,1,1)>1e8);
  });
  test('zero weights exactly preserve evaluation',()=>{
    const node=ring(),w=E.BOT_WEIGHTS;
    assert.equal(E.evaluateStatic(node.state,7,7,1,w,node),
      E.evaluateStatic(node.state,7,7,1,{...w,edgeEscape:0,closeCost:0,captureRace:0,phase:0,endgameScore:0},node));
  });
  console.log(`A09: ${n} fixtures passed`);
}
if(require.main===module)run();
module.exports={ring,run};
