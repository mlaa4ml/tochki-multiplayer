#!/usr/bin/env node
'use strict';
// Fixed experiments, not weight tuning. One feature at a time and leave-one-out.
// Acceptance is A07's pre-existing CI rule; nothing publishes weights.
const fs=require('fs');
const E=require('../../gameEngine');
const B=require('./benchmark');
const R=require('./runner');
const {performance}=require('perf_hooks');
const corpus=require('./corpus/openings.v1.json');
const baseline={...E.BOT_WEIGHTS};
const features={edgeEscape:5,closeCost:10,captureRace:30,phase:6,endgameScore:1};
const variants={base:baseline,noLiberty:{...baseline,liberty:0}};
for(const [k,v] of Object.entries(features))variants[k]={...baseline,[k]:v};
variants.all={...baseline,...features};
for(const k of Object.keys(features)){
  variants['without-'+k]={...variants.all,[k]:0};
}
const dir='tools/bench/reports';
const diff={...E.DIFFICULTY.normal,maxDepth:2,quiescenceExt:0};
const nodeLimit=40;
function nodeOf(t){
  const m=E.createMatch(t.rules);R.applyPrefix(m,t.prefix,()=>{});
  return E.createSearchNode(m.getSnapshot());
}
function targeted(){
  const out={format:'tochki-bench-corpus',version:'a09-targeted-v1',seed:corpus.seed,openings:{},tactics:{}};
  for(const size of ['small','medium']){
    const list=corpus.tactics[size].map((t,i)=>{
      const node=nodeOf(t);
      // Reachable capture-in-one positions, threshold just above existing
      // scores: endgameScore is demonstrably active at the root.
      return {...t,id:`a09-${size}-${i}`,rules:{...t.rules,
        targetScore:Math.max(node.scores[1],node.scores[2])+1,targetFillPercent:100}};
    });
    out.openings[size]={validation:list,test:[]};
    out.tactics[size]=list;
  }
  B.validateCorpus(out);return out;
}
function ablation(){
  const positions=targeted().tactics.small;
  const nodes=positions.map(nodeOf);
  // Additional board-only fixture separates phase from close/race.
  const {ring}=require('../../test/eval-a09');
  nodes.push(ring({gap:false,enemy:false}));
  const out={format:'a09-ablation',node:process.version,nodeLimit,diff,
    acceptance:'No feature enabled unless independent A07 lower CI95 > 0.5 and zero correctness errors',
    note:'Fixed small tactical corpus; rotated warm measurements, not strength evidence. Times in microseconds/ms.',
    activation:nodes.map((n,i)=>({position:i,features:E.enclosureFeatures(n,features)})),variants:{}};
  const times=Object.fromEntries(Object.keys(variants).map(k=>[k,[]]));
  // Warm all variants; rotate order to avoid always measuring baseline first.
  const keys=Object.keys(variants);
  for(let pass=0;pass<12;pass++){
    for(let j=0;j<keys.length;j++){
      const k=keys[(j+pass)%keys.length],w=variants[k];
      for(const n of nodes){
        const t=performance.now();
        E.evaluateStatic(n.state,n.rows,n.cols,1,w,n);
        if(pass>=3)times[k].push((performance.now()-t)*1000);
      }
    }
  }
  for(const [k,w] of Object.entries(variants)){
    const ms=[],counts=[],missed=[];
    for(const t of positions){
      const n=nodeOf(t),start=performance.now();
      const r=E.searchMove(n.state,n.rows,n.cols,n.current,diff,w,{...n,nodeLimit,rules:n.rules});
      ms.push(performance.now()-start);counts.push(r.trace.nodes);
      if(!r.move||!t.expected.some(m=>m.x===r.move.x&&m.y===r.move.y))missed.push(t.id);
    }
    const q=a=>({p50:B.quantile(a,.5),p95:B.quantile(a,.95)});
    out.variants[k]={weights:w,evalUs:q(times[k]),moveMs:q(ms),nodes:q(counts),total:positions.length,missed};
  }
  save('a09-ablation.json',out);
}
function save(name,obj){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(`${dir}/${name}`,JSON.stringify(obj,null,2)+'\n');console.log(name);}
function paired(k){
  if(!features[k])throw Error('specify one feature');
  const c=targeted();
  const report=B.runBenchmark({corpus:c,split:'validation',sizes:['small'],difficulties:['normal'],
    nodeLimit,runs:1,seed:14009,maxMoves:80,maxMs:0,bootstrap:2000,maxPairs:4,
    candidate:{id:k,weights:variants[k]},pool:[{id:'baseline',weights:baseline}],
    strategic:null,candOverride:{maxDepth:2,quiescenceExt:0},oppOverride:{maxDepth:2,quiescenceExt:0},
    progress:true});
  report.a09={rootFeatures:c.openings.small.validation.slice(0,4).map(t=>({id:t.id,features:E.enclosureFeatures(nodeOf(t),features)})),
    limitation:'Four independent reachable tactical prefixes, not a general opening strength estimate. One deterministic run, small/normal, 40 nodes, depth 2, no quiescence. Full corpus remains unmeasured.'};
  save(`a09-paired-${k}.json`,report);
}
if(process.argv[2]==='ablation')ablation();
else if(process.argv[2]==='corpus')save('a09-targeted-corpus.json',targeted());
else paired(process.argv[2]);
