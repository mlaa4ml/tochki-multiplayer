#!/usr/bin/env node
// tools/repair-replay.js — чинит реплеи, сохранённые offline-версией до исправления
// ошибки «Replay: event N: decision: missing botVersion».
//
//   node tools/repair-replay.js <вход.json> [выход.json]
//
// Вход: один реплей, массив реплеев, массив записей {name, replay, ...} (так
// хранит IndexedDB браузера) либо объект {replays:[...]}. Выход — те же данные
// с исправленными decision; каждый реплей проверяется строгим кодеком replay.js.
'use strict';
const fs = require('fs');
const path = require('path');
const Engine = require('../gameEngine.js');
const Replay = require('../replay.js');

const BUDGET_KEYS = ['radius', 'candidateCap', 'timeLimit', 'maxDepth', 'branchWide',
  'branchMid', 'branchNarrow', 'quiescenceExt'];
const W_KEYS = ['potential', 'cohesion', 'stones', 'liberty'];

function fixDecision(d){
  if (!d || typeof d !== 'object') return d;
  const diff = (d.difficulty === 'normal' || d.difficulty === 'strong') ? d.difficulty
    : (d.controller === 'normal' || d.controller === 'strong') ? d.controller : 'strong';
  const base = Engine.DIFFICULTY[diff];
  const budgets = {};
  for (const k of BUDGET_KEYS) budgets[k] = base[k];
  const weights = {};
  for (const k of W_KEYS) weights[k] = Engine.BOT_WEIGHTS[k];
  return { botVersion: Engine.BOT_VERSION, weightsVersion: Engine.WEIGHTS_VERSION,
    seed: null, budgets, weights, difficulty: diff };
}

function fixReplay(r){
  if (!r || !Array.isArray(r.events)) return { replay: r, fixed: 0 };
  let fixed = 0;
  for (const e of r.events){
    if (e && e.type === 'move' && e.decision){ e.decision = fixDecision(e.decision); fixed++; }
  }
  return { replay: r, fixed };
}

function main(){
  const [inp, out] = process.argv.slice(2);
  if (!inp){ console.error('usage: node tools/repair-replay.js <in.json> [out.json]'); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(inp, 'utf8'));
  const list = Array.isArray(data) ? data : Array.isArray(data.replays) ? data.replays : [data];
  let total = 0, ok = 0, bad = 0;
  for (const item of list){
    const holder = item && item.replay ? item : { replay: item };
    const { fixed } = fixReplay(holder.replay);
    total++;
    try { Replay.play(holder.replay); ok++; }
    catch (e){ bad++; console.error('не прошла проверку: ' + (holder.name || '(без имени)') + ' — ' + e.message); }
    if (fixed) console.log((holder.name || 'партия') + ': исправлено решений бота: ' + fixed);
  }
  const target = out || path.join(path.dirname(inp), path.basename(inp, '.json') + '.fixed.json');
  fs.writeFileSync(target, JSON.stringify(data, null, 2));
  console.log('готово: ' + ok + ' из ' + total + ' проходят проверку' + (bad ? ', ' + bad + ' с ошибками' : '') + ' → ' + target);
  process.exit(bad ? 1 : 0);
}
main();
