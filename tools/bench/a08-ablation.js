#!/usr/bin/env node
'use strict';
// Fixed-weight code ablation, not weight tuning. Small, bounded A07 pairs.
const fs = require('fs');
const path = require('path');
const E = require('../../gameEngine');
const R = require('./runner');
const B = require('./benchmark');
const { fixtures, oracle } = require('../../test/candidates');
const corpus = require('./corpus/openings.v1.json');
const weights = require('./baseline/weights.v1.json').weights;
const variants = [
  ['base', {tactical:false,strategic:false}],
  ['tactical', {tactical:true,strategic:false}],
  ['strategic', {tactical:false,strategic:true}],
  ['both', {tactical:true,strategic:true}]
];
const nodeLimit = Number(process.env.A08_NODES || 100);
const maxPairs = Number(process.env.A08_PAIRS || 2);
const maxMoves = Number(process.env.A08_MOVES || 100);
const samples = Number(process.env.A08_SAMPLES || 2);
const summary = a => ({p50:B.quantile(a,.5),p95:B.quantile(a,.95)});
const report = {
  format:'tochki-a08-ablation', version:1,
  commit:require('child_process').execSync('git rev-parse HEAD').toString().trim(),
  node:process.version, nodeLimit, maxMoves, samples,
  note:'Small test-split smoke; wide CI and truncated games cannot establish improved strength.',
  variants:[]
};
for (const [name,flags] of variants){
  const diff = {...E.DIFFICULTY.normal,...flags};
  const ms=[], nodes=[], genMs=[], genOnly=[];
  let missed=0, required=0;
  for (const [id,n] of fixtures){
    const expected=oracle(n);
    const t0=performance.now();
    const chosen=new Set(E.searchCandidates(n,diff,1).map(c=>`${c.x},${c.y}`));
    genOnly.push(performance.now()-t0);
    required+=expected.length;
    missed+=expected.filter(c=>!chosen.has(`${c.x},${c.y}`)).length;
    for (let run=0;run<samples;run++){
      const r=E.searchMove(n.state,n.rows,n.cols,n.current,diff,weights,{
        nodeLimit,stonesPlacedTotal:n.stonesPlacedTotal,rules:n.rules,generationDiagnostics:true
      });
      ms.push(r.trace.elapsedMs); nodes.push(r.trace.nodes);
      genMs.push(r.trace.generation.elapsedMs);
      if (!r.move || !E.isTransitionLegal(n,r.move.x,r.move.y)) throw Error('illegal '+id);
    }
  }
  const pairs=[], errors=[];
  let truncated=0;
  const openings=corpus.openings.small.test.slice(0,maxPairs);
  for (const opening of openings){
    let points=0;
    for (const seat of [1,2]){
      const candidate=R.makeSearchPlayer(E,{difficulty:diff,nodeLimit,weights});
      const baseline=R.makeSearchPlayer(E,{difficulty:{...E.DIFFICULTY.normal,tactical:false,strategic:false},nodeLimit,weights});
      try {
        const game=R.playGame(E,{rules:opening.rules,prefix:opening.prefix,maxMoves,
          players:{[seat]:candidate,[3-seat]:baseline}});
        if (!R.replayLines(E,game.lines).ok) throw Error('replay mismatch');
        if (game.result.truncated) truncated++;
        points+=game.result.winner===0?.5:game.result.winner===seat?1:0;
      } catch(e){ errors.push({opening:opening.id,seat,message:e.message}); }
    }
    pairs.push(points/2);
    console.error(`${name} pair ${pairs.length}/${openings.length}`);
  }
  const ci=B.bootstrapPairs(pairs,2000,813);
  const row={name,flags,missed,required,missRate:required?missed/required:0,
    generationOnlyMs:summary(genOnly),moveMs:summary(ms),nodes:summary(nodes),
    generationMs:summary(genMs),paired:{split:'test',size:'small',difficulty:'normal',
      openings:openings.map(o=>o.id),score:ci.mean,ci95:{lo:ci.lo,hi:ci.hi},
      pairs:pairs.length,truncated,errors}};
  report.variants.push(row);
  console.log(JSON.stringify(row));
}
const out=process.argv[2] || 'tools/bench/reports/a08-ablation.json';
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
if (report.variants.some(v=>v.paired.errors.length)) process.exitCode=1;
