// test/monitor.js — монитор опасных групп (issue #59, S5). Только наблюдение:
// проверяем признаки на синтетических позициях и то, что узел не меняется.
'use strict';
const assert = require('assert');
const E = require('../gameEngine.js');
const M = require('../tools/bench/monitor.js');

// Узел N×N; stones — [[x, y, player], ...]; ходит current.
function mk(N, stones, current){
  const z = () => Array.from({ length: N }, () => new Array(N).fill(0));
  const src = { rows: N, cols: N, stone: z(), dead: z(), territory: z(), current: current || 1 };
  for (const [x, y, p] of stones) src.stone[y][x] = p;
  return E.createSearchNode(src);
}
const groupAt = (res, x, y) => res.groups.find(g => g.stones.some(s => s.x === x && s.y === y));

// 1. Одиночная точка в центре пустого поля: окружить = занять 4 соседа.
{
  const res = M.monitorPosition(mk(7, [[3, 3, 2]]), 2, { twoMove: false });
  assert.strictEqual(res.groups.length, 1);
  const g = res.groups[0];
  assert.strictEqual(g.size, 1);
  assert.strictEqual(g.exits, 4);
  assert.strictEqual(g.cost, 4, 'центр: стоимость окружения 4');
  assert.strictEqual(g.ringProgress, 0);
}

// 2. Точка на краю не захватывается (правила runCaptures: область касается края).
{
  const res = M.monitorPosition(mk(7, [[0, 3, 2]]), 2, { twoMove: false });
  assert.strictEqual(res.groups[0].cost, Infinity, 'точка на краю безопасна');
  // точка, связанная с краем 4-цепочкой своих точек, тоже
  const res2 = M.monitorPosition(mk(7, [[0, 3, 2], [1, 3, 2], [2, 3, 2]]), 2, { twoMove: false });
  assert.strictEqual(res2.groups[0].cost, Infinity, '4-цепочка до края безопасна');
}

// 3. Полукольцо: три стены противника, остаётся один выход.
{
  const node = mk(7, [[3, 3, 2], [2, 3, 1], [4, 3, 1], [3, 2, 1]], 1);
  const before = JSON.stringify(node);
  const res = M.monitorPosition(node, 2);
  assert.strictEqual(JSON.stringify(node), before, 'монитор не меняет узел');
  const g = res.groups[0];
  assert.strictEqual(g.cost, 1);
  assert.strictEqual(g.exits, 1);
  assert.strictEqual(g.capture, 1);
  assert.deepStrictEqual(g.cut, [{ x: 3, y: 4 }]);
  assert.strictEqual(g.ringProgress, 0.75);
  assert.strictEqual(res.tempo, 'opp');
  assert.strictEqual(res.minCost, 1);
  assert.ok(typeof res.twoMove === 'number' && res.twoMove >= 1, 'twoMoveThreat видит взятие');
  const a = M.alarmOf(res, 'cost');
  assert.ok(a.on && a.stones.has('3,3'), 'правило cost поднимает тревогу на точке');
}

// 4. Группа у края: точка (0,3) на краю безопасна, но диагонально связанная
// (1,4) захватывается отдельно — группа целиком НЕ считается безопасной
// (недостаток «минимального разреза до края» из Плана).
{
  const res = M.monitorPosition(mk(7, [[0, 3, 2], [1, 4, 2], [2, 4, 1], [1, 5, 1]]), 2, { twoMove: false });
  const g = groupAt(res, 1, 4);
  assert.strictEqual(g.size, 2, 'связность по 8 соседям');
  assert.strictEqual(g.cost, 2, 'захватываемое подмножество у края: разрез (0,4)+(1,3)');
  assert.strictEqual(g.capture, 1);
  const cut = g.cut.map(c => c.x + ',' + c.y).sort();
  assert.deepStrictEqual(cut, ['0,4', '1,3']);
}

// 5. Своя точка внутри разреза не может быть занята противником.
{
  // (3,3) бота, стены противника слева/сверху/справа, снизу точка бота (3,4),
  // от неё к краю — пустые клетки: противник должен резать вокруг (3,4).
  const res = M.monitorPosition(mk(7, [[3, 3, 2], [3, 4, 2], [2, 3, 1], [4, 3, 1], [3, 2, 1]]), 2, { twoMove: false });
  const g = res.groups[0];
  assert.strictEqual(g.size, 2);
  assert.strictEqual(g.cost, 3, 'разрез вокруг (3,4): (2,4),(4,4),(3,5)');
  assert.strictEqual(g.capture, 2);
}

// 7. Вилка (замена 3, forcedCost): две группы бота, (2,3) и (4,3), не связаны
// по 8 соседям. Каждая окружена тремя стенами противника, и у обеих разрез —
// одна и та же клетка (3,3). Один ход противника туда сокращает обе стоимости,
// поэтому для обеих forcedCost = cost - 1. Одиночное полукольцо из теста 3
// вилкой не является.
{
  const node = mk(7, [[2, 3, 2], [4, 3, 2],
    [1, 3, 1], [2, 2, 1], [2, 4, 1],
    [5, 3, 1], [4, 2, 1], [4, 4, 1]], 1);
  const before = JSON.stringify(node);
  const res = M.monitorPosition(node, 2, { twoMove: false });
  assert.strictEqual(JSON.stringify(node), before, 'монитор не меняет узел');
  assert.strictEqual(res.groups.length, 2, 'две отдельные группы');
  for (const [x, y] of [[2, 3], [4, 3]]){
    const g = groupAt(res, x, y);
    assert.strictEqual(g.cost, 1, `(${x},${y}): стоимость 1`);
    assert.deepStrictEqual(g.cut, [{ x: 3, y: 3 }], `(${x},${y}): разрез (3,3)`);
    assert.strictEqual(g.fork, true, `(${x},${y}): вилка`);
    assert.strictEqual(g.forcedCost, 0, `(${x},${y}): forcedCost = cost - 1`);
  }
  const a = M.alarmOf(res, 'forced');
  assert.ok(a.on && a.stones.has('2,3') && a.stones.has('4,3'), 'правило forced поднимает тревогу на обеих группах');

  const single = M.monitorPosition(mk(7, [[3, 3, 2], [2, 3, 1], [4, 3, 1], [3, 2, 1]], 1), 2, { twoMove: false });
  assert.strictEqual(single.groups[0].fork, false, 'одна группа — не вилка');
  assert.strictEqual(single.groups[0].forcedCost, single.groups[0].cost, 'без вилки forcedCost = cost');
  assert.strictEqual(single.groups[0].costDrop, 0, 'без opts.prev падения нет');
}

// 8. Падение стоимости (замена 1): та же точка до и после хода противника.
{
  const prev = M.monitorPosition(mk(7, [[3, 3, 2], [2, 3, 1]], 2), 2, { twoMove: false });
  const cur = M.monitorPosition(mk(7, [[3, 3, 2], [2, 3, 1], [4, 3, 1], [3, 2, 1]], 2), 2, { twoMove: false, prev });
  const g = cur.groups[0];
  assert.strictEqual(prev.groups[0].cost, 3);
  assert.strictEqual(g.prevCost, 3);
  assert.strictEqual(g.cost, 1);
  assert.strictEqual(g.costDrop, 2, 'падение 3 -> 1');
  assert.ok(M.alarmOf(cur, 'drop').on, 'правило drop поднимает тревогу');
}

// 6. Пустое поле: групп нет, тревог нет.
{
  const res = M.monitorPosition(mk(7, []), 2);
  assert.strictEqual(res.groups.length, 0);
  assert.strictEqual(res.minCost, Infinity);
  for (const r of Object.keys(M.RULES)) assert.strictEqual(M.alarmOf(res, r).on, false);
}

console.log('monitor: OK');
