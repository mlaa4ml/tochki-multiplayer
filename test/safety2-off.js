// test/safety2-off.js — issue #55: safety2/antiFork по умолчанию выключены,
// и при выключенных флагах ход бота детерминирован и совпадает с поиском
// «как без фильтров» (конфигурация без ключей safety2/antiFork, т.е. как
// в main до переноса #52) при фиксированном nodeLimit.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../gameEngine.js');

for (const k of ['normal', 'strong']){
  assert.strictEqual(E.DIFFICULTY[k].safety2, false, `${k}: safety2 должен быть false`);
  assert.ok(!E.DIFFICULTY[k].antiFork, `${k}: antiFork должен быть выключен`);
}

const dir = path.join(__dirname, '..', 'tools', 'bench', 'corpus', 'human');
const CASES = [
  ['issue52-replays01.json', 0, 20], ['issue52-replays01.json', 0, 48],
  ['issue52-replays01.json', 1, 44], ['issue52-replays02.json', 1, 38]
];

function matchAt(file, gi, ply){
  const g = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))[gi].replay;
  const R = g.rules;
  const m = E.createMatch({ sizeKey: g.board.sizeKey, firstPlayer: R.firstPlayer, startPosition: R.startPosition,
    targetScore: R.targetScore, targetFillPercent: R.targetFillPercent, extraTurnOnCapture: R.extraTurnOnCapture });
  const mv = g.events.filter(e => e.type === 'move');
  for (let i = 0; i < ply; i++) m.applyMove(mv[i].player, mv[i].x, mv[i].y);
  return m;
}

function searchAll(){
  const out = [];
  for (const [file, gi, ply] of CASES){
    for (const lvl of ['normal', 'strong']){
      const m = matchAt(file, gi, ply);
      const r = m.botSearch(lvl, null, { nodeLimit: lvl === 'strong' ? 3000 : 1500 });
      assert.ok(r && r.move, `${file}#${gi}@${ply} ${lvl}: ход найден`);
      out.push(`${lvl}:${r.move.x},${r.move.y}`);
    }
  }
  return out;
}

const withFlagsOff = searchAll();
assert.deepStrictEqual(searchAll(), withFlagsOff, 'поиск детерминирован при фиксированном nodeLimit');

// Конфигурация без фильтров (как до #52): убираем ключи safety2*/antiFork*.
const saved = {};
for (const k of ['normal', 'strong']){
  saved[k] = Object.assign({}, E.DIFFICULTY[k]);
  for (const key of Object.keys(E.DIFFICULTY[k])) if (/^(safety2|antiFork)/.test(key)) delete E.DIFFICULTY[k][key];
}
let noFilters;
try { noFilters = searchAll(); }
finally { for (const k of ['normal', 'strong']) Object.assign(E.DIFFICULTY[k], saved[k]); }
assert.deepStrictEqual(withFlagsOff, noFilters, 'при safety2:false/antiFork:false ходы совпадают с поиском без фильтров');

console.log(`safety2-off: OK (${withFlagsOff.length} поисков)`);
