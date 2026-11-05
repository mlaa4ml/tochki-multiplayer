// test/root-first.js — #81: opts.rootFirst в searchMove и rescueMode арбитра.
'use strict';
const assert = require('assert');
const E = require('../gameEngine.js');
const A = require('../arbiter.js');

const m = E.createMatch({ sizeKey: 'medium' });
const s = m.getSnapshot();
const st = { stone: s.stone, dead: s.dead, territory: s.territory };
const mover = s.current || 1;
const opts = { nodeLimit: 800, stonesPlacedTotal: s.stonesPlacedTotal, rules: s.rules };
const diff = E.DIFFICULTY.strong;

// 1. Без rootFirst (и с пустым) поиск детерминированно совпадает с базой.
const a = E.searchMove(st, s.rows, s.cols, mover, diff, null, opts);
const b = E.searchMove(st, s.rows, s.cols, mover, diff, null, Object.assign({}, opts, { rootFirst: [] }));
assert.deepStrictEqual(a.move && { x: a.move.x, y: a.move.y }, b.move && { x: b.move.x, y: b.move.y });
assert.strictEqual(b.trace.rootFirst, undefined);

// 2. Легальный ход из rootFirst попадает в корень и оценивается поиском.
let pick = null;
for (let y = s.rows - 1; y >= 0 && !pick; y--) for (let x = s.cols - 1; x >= 0 && !pick; x--){
  const node = E.createSearchNode(Object.assign({}, s, { current: mover }));
  if (E.isTransitionLegal(node, x, y)) pick = { x, y };
}
assert.ok(pick, 'нет легального хода');
const c = E.searchMove(st, s.rows, s.cols, mover, diff, null, Object.assign({}, opts, { rootFirst: [pick, { x: -5, y: 1.5 }] }));
assert.ok(Array.isArray(c.trace.rootFirst) && c.trace.rootFirst.length === 1, 'нелегальные/некорректные ходы отброшены');
assert.deepStrictEqual({ x: c.trace.rootFirst[0].x, y: c.trace.rootFirst[0].y }, pick);
if (c.trace.completedDepth >= 2)
  assert.ok(c.trace.candidates.some(q => q.x === pick.x && q.y === pick.y), 'ход rootFirst оценён в корне');

// 3. monitor:false — арбитр ровно база при любом rescueMode.
const d = A.arbiterMove(st, s.rows, s.cols, mover, diff, null, Object.assign({}, opts, { monitor: false, arbiter: { rescueMode: 'root' } }));
assert.deepStrictEqual({ x: d.move.x, y: d.move.y }, { x: a.move.x, y: a.move.y });

// 4. Значения по умолчанию сохраняют поведение #77.
assert.strictEqual(A.ARBITER_DEFAULTS.rescueMode, 'static');
assert.strictEqual(A.ARBITER_DEFAULTS.alarmCostLarge, null);
assert.strictEqual(A.ARBITER_DEFAULTS.rescuePartial, false);
console.log('root-first: OK');
