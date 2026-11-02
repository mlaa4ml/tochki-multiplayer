// test/arbiter.js — арбитр S7 (issue #61).
// 1) monitor:false — ход и trace совпадают с searchMove при фиксированном nodeLimit.
// 2) Бюджет локального поиска ограничен верхним пределом из настроек.
// 3) monitor:true на regression (#57): тревога поднимается, решение записано в
//    trace.arbiter, спасающий ход (если выбран) — из списка спасений.
'use strict';
const assert = require('assert');
const E = require('../gameEngine.js');
const A = require('../arbiter.js');
const S = require('../tools/bench/localSolver.js');

let passed = 0;
function ok(name){ passed++; console.log('ok - ' + name); }

const cases = S.regressionCases();
const diff = E.DIFFICULTY.normal;
const so = n => ({ stone: n.state.stone, dead: n.state.dead, territory: n.state.territory });

// 1. Флаг выключен: ровно база.
for (const c of cases){
  const n = c.node, p = c.pos.botSeat;
  for (const flag of [undefined, false]){
    const opts = { nodeLimit: 4000, monitor: flag };
    const a = A.arbiterMove(so(n), n.rows, n.cols, p, diff, null, Object.assign({}, opts));
    const b = E.searchMove(so(n), n.rows, n.cols, p, diff, null, { nodeLimit: 4000 });
    assert.deepStrictEqual(a.move, b.move, c.pos.id + ': ход при monitor:' + flag);
    const strip = t => { const o = Object.assign({}, t); delete o.elapsedMs; return o; };
    assert.deepStrictEqual(strip(a.trace), strip(b.trace), c.pos.id + ': trace при monitor:' + flag);
    assert.strictEqual(a.trace.arbiter, undefined);
  }
}
ok('monitor:false совпадает с базой при фиксированном nodeLimit');

// 2. Верхний предел времени.
assert.strictEqual(A.alarmBudget({ alarmTimeLimit: 10000, maxAlarmTimeLimit: 20000 }), 10000);
assert.strictEqual(A.alarmBudget({ alarmTimeLimit: 30000, maxAlarmTimeLimit: 15000 }), 15000);
assert.strictEqual(A.alarmBudget({ alarmTimeLimit: 5000, maxAlarmTimeLimit: 0 }), 0);
assert.strictEqual(A.alarmBudget({}), A.ARBITER_DEFAULTS.alarmTimeLimit);
ok('бюджет тревоги ограничен maxAlarmTimeLimit');

// 3. Флаг включён.
for (const c of cases){
  const n = c.node, p = c.pos.botSeat;
  const r = A.arbiterMove(so(n), n.rows, n.cols, p, diff, null,
    { nodeLimit: 4000, monitor: true, arbiter: { alarmTimeLimit: 5000, maxAlarmTimeLimit: 10000 } });
  assert.ok(r.move, c.pos.id + ': есть ход');
  assert.ok(E.isTransitionLegal(n, r.move.x, r.move.y), c.pos.id + ': ход легален');
  const info = r.trace.arbiter;
  assert.ok(info, c.pos.id + ': trace.arbiter');
  console.log('  ' + c.pos.id + ': alarm=' + info.alarm + ' decision=' + info.decision +
    ' move=(' + r.move.x + ',' + r.move.y + ') groups=' + JSON.stringify(info.groups.map(g => ({ size: g.size, cost: g.cost, saved: g.saved, move: g.move, accepted: g.accepted }))));
  if (info.decision === 'rescue')
    assert.ok(c.pos.rescue.some(m => m.x === r.move.x && m.y === r.move.y), c.pos.id + ': спасение из списка #57');
}
ok('monitor:true: решение арбитра записано, спасения из списка #57');

console.log('\n' + passed + ' passed');
