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

// 4. Ограничение ущерба: даже без кандидатов общего поиска (cands = [])
// находится легальный ход вне потерянной группы (перебор всего поля).
for (const c of cases){
  const n = c.node, p = c.pos.botSeat;
  const alt = A.avoidLostMove(n, p, null, [], [c.target]);
  assert.ok(alt, c.pos.id + ': есть ход вне группы');
  assert.strictEqual(alt.source, 'all-legal');
  assert.ok(E.isTransitionLegal(n, alt.x, alt.y), c.pos.id + ': ход вне группы легален');
  const near = c.target.some(s => Math.abs(s.x - alt.x) <= 1 && Math.abs(s.y - alt.y) <= 1);
  if (near){
    const t = E.applyTransition(n, p, alt.x, alt.y);
    assert.ok(t.result.gained.some(q => q.kind === 'captured'), c.pos.id + ': ход рядом с группой только со взятием');
  }
  // С кандидатами — берётся лучший кандидат вне группы.
  const far = { x: alt.x, y: alt.y, score: 1 };
  const inG = c.target.map(s => ({ x: s.x, y: s.y }));
  const adj = [];
  for (const s of c.target) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){
    const x = s.x + dx, y = s.y + dy;
    if (x >= 0 && y >= 0 && x < n.cols && y < n.rows && E.isTransitionLegal(n, x, y)) adj.push({ x, y, score: 100 });
  }
  void inG;
  const alt2 = A.avoidLostMove(n, p, null, adj.concat([far]), [c.target]);
  assert.ok(alt2 && E.isTransitionLegal(n, alt2.x, alt2.y), c.pos.id + ': ход с кандидатами легален');
}
ok('ограничение ущерба: ход вне потерянной группы находится и без кандидатов общего поиска');

// An alarm alone (no solver or interrupted solver) must not ban defence.
// Artificial root bounds must not affect the static rescue comparison.
{
  const M = require('../tools/bench/monitor.js');
  const original = { search: E.searchMove, monitor: M.monitorPosition, solve: S.solveGroup };
  const c = cases[0], n = c.node, p = c.pos.botSeat;
  const moves = [];
  for (let y = 0; y < n.rows && moves.length < 2; y++)
    for (let x = 0; x < n.cols && moves.length < 2; x++)
      if (E.isTransitionLegal(n, x, y)) moves.push({ x, y });
  try {
    E.searchMove = () => ({ move: moves[0], trace: { nodes: 3000,
      candidates: [{ ...moves[0], score: 1e9 }, { ...moves[1], score: -1e9 }] } });
    M.monitorPosition = () => ({ groups: [{ size: 2, cost: 1, stones: c.target }] });
    S.solveGroup = () => { throw new Error('no-solver must not call solver'); };
    const run = arbiter => A.arbiterMove(so(n), n.rows, n.cols, p, diff, null,
      { monitor: true, nodeLimit: 3000, arbiter });
    const no = run({ solver: false });
    assert.deepStrictEqual(no.move, moves[0]);
    assert.strictEqual(no.trace.arbiter.decision, 'base');
    assert.strictEqual(no.trace.nodes, 3000);
    assert.strictEqual(no.trace.arbiter.budgetMs, 1500);
    S.solveGroup = () => ({ saved: false, incomplete: true, loss: 2, depth: 10 });
    assert.deepStrictEqual(run({}).move, moves[0]);
    S.solveGroup = () => ({ saved: true, move: moves[1], loss: 0, depth: 2 });
    const rescue = run({ threshold: 1e6 });
    assert.deepStrictEqual(rescue.move, moves[1]);
    assert.strictEqual(rescue.trace.arbiter.decision, 'rescue');
    assert.ok(Number.isFinite(rescue.trace.arbiter.groups[0].staticScore));
    assert.strictEqual(run({ maxAlarmTimeLimit: 0 }).trace.arbiter.budgetMs, 0);
  } finally {
    E.searchMove = original.search; M.monitorPosition = original.monitor; S.solveGroup = original.solve;
  }
}
ok('alarm is not loss; root bounds ignored; main node budget unchanged');

for (const c of cases){
  const r = S.solveGroup(c.node, c.pos.botSeat, c.target, { timeLimit: 1, nodeLimit: 200000 });
  assert.ok(r.ms < 250, 'deadline includes generation and verification');
  assert.ok(r.incomplete && !r.saved && r.loss === null);
  const limited = S.solveGroup(c.node, c.pos.botSeat, c.target, { nodeLimit: 1 });
  assert.ok(limited.incomplete && !limited.saved);
}
ok('all solver phases share deadline/node budget; exhaustion is unknown');

console.log('\n' + passed + ' passed');
