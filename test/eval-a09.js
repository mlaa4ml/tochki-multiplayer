'use strict';
// A09 (issue #14): фикстуры признака связи области с краем (computeEdgeEscape)
// и проверка, что liberties — лишь эвристика, а не правило захвата.
// Запуск: node test/eval-a09.js
const assert = require('assert');
const E = require('../gameEngine.js');

const ROWS = 10, COLS = 12;
function board(p1 = [], p2 = []){
  const s = E.createEmptyState(ROWS, COLS);
  for (const [x, y] of p1) s.stone[y][x] = 1;
  for (const [x, y] of p2) s.stone[y][x] = 2;
  return s;
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
let passed = 0;
function t(name, fn){ fn(); passed++; console.log('ok -', name); }

t('край: 0 соседних пустот у точки противника, но захвата нет', () => {
  // Точка 2 в углу (0,0), точки 1 занимают обоих соседей.
  const s = board([[1, 0], [0, 1]], [[0, 0]]);
  if (typeof E.computeGroupLiberties === 'function'){
    const g = E.computeGroupLiberties(s, ROWS, COLS, 2);
    assert.strictEqual(g[0].liberties, 0, 'по аналогии с го группа «мертва»');
  }
  const c = E.cloneState(s);
  assert.deepStrictEqual(E.runCaptures(c, 1, ROWS, COLS), [], 'но правила её не захватывают: область касается края');
  assert.strictEqual(E.computeScores(c, ROWS, COLS)[1], 0);
});

t('замкнутая пустая область без противника очков не даёт и edgeEscape=0', () => {
  const s = board([[5, 4], [5, 6], [4, 5], [6, 5]]);
  const c = E.cloneState(s);
  E.runCaptures(c, 1, ROWS, COLS);
  assert.deepStrictEqual(E.computeScores(c, ROWS, COLS), { 1: 0, 2: 0 });
  assert.strictEqual(E.computeEdgeEscape(s, ROWS, COLS, 1), 0);
  assert.strictEqual(E.computeEdgeEscape(s, ROWS, COLS, 2), 0);
});

t('полезное окружение с противником даёт очко', () => {
  const s = board([[5, 4], [5, 6], [4, 5], [6, 5]], [[5, 5]]);
  const c = E.cloneState(s);
  const gained = E.runCaptures(c, 1, ROWS, COLS);
  assert.strictEqual(E.countCaptured ? E.countCaptured(gained) : gained.filter(g => g.kind === 'captured').length, 1);
  assert.strictEqual(E.computeScores(c, ROWS, COLS)[1], 1);
});

// Узкий выход: точка 2 на (2,1), выход к краю только через (2,0).
const NARROW_P1 = [[1, 1], [3, 1], [2, 2], [1, 0], [3, 0]];
t('выход через узкий проход ценится выше широкого', () => {
  const narrow = board(NARROW_P1, [[2, 1]]);
  const wide = board([[1, 1], [3, 1], [2, 2]], [[2, 1]]);
  const pn = E.computeEdgeEscape(narrow, ROWS, COLS, 1);
  const pw = E.computeEdgeEscape(wide, ROWS, COLS, 1);
  assert.ok(near(pn, 0.5), 'одна клетка края => 1/(1+1)');
  assert.ok(pn > pw * 5, `узкий ${pn} vs широкий ${pw}`);
  // Закрытие прохода реально захватывает по правилам.
  const c = E.cloneState(narrow); c.stone[0][2] = 1;
  const gained = E.runCaptures(c, 1, ROWS, COLS);
  assert.ok(gained.some(g => g.kind === 'captured'));
  assert.strictEqual(E.computeEdgeEscape(c, ROWS, COLS, 1), 0, 'после захвата давления нет');
});

t('бесполезная локальная плотность не меняет признак', () => {
  const opp = [[10, 8]];
  const a = board([], opp);
  const b = board([[5, 4], [6, 4], [5, 5], [6, 5], [4, 4]], opp);
  assert.ok(near(E.computeEdgeEscape(a, ROWS, COLS, 1), E.computeEdgeEscape(b, ROWS, COLS, 1)));
});

t('несколько фронтов: вклад складывается', () => {
  const second = NARROW_P1.map(([x, y]) => [x + 6, y]);
  const one = board(NARROW_P1, [[2, 1]]);
  const two = board(NARROW_P1.concat(second), [[2, 1], [8, 1]]);
  const p1 = E.computeEdgeEscape(one, ROWS, COLS, 1);
  const p2 = E.computeEdgeEscape(two, ROWS, COLS, 1);
  assert.ok(near(p2, 2 * p1), `${p2} != 2*${p1}`);
});

t('близкий порог окончания: реальное очко важнее давления формы', () => {
  const w = Object.assign({}, E.BOT_WEIGHTS, { edgeEscape: 20 });
  // Позиция A: давление у края без очка. Позиция B: одно реальное пленение.
  const A = board(NARROW_P1, [[2, 1]]);
  const B = board([[5, 4], [5, 6], [4, 5], [6, 5]], [[5, 5]]);
  E.runCaptures(B, 1, ROWS, COLS);
  assert.ok(E.evaluateStatic(B, ROWS, COLS, 1, w) > E.evaluateStatic(A, ROWS, COLS, 1, w));
  // При targetScore=1 закрытие прохода — терминальная победа по правилам.
  const m = E.createMatch({ sizeKey: 'small', rules: { targetScore: 1 } });
  assert.ok(m, 'матч создаётся');
});

t('по умолчанию признак выключен: оценка не меняется', () => {
  assert.ok(!E.BOT_WEIGHTS.edgeEscape);
  const s = board(NARROW_P1, [[2, 1], [9, 7]]);
  const a = E.evaluateStatic(s, ROWS, COLS, 1, E.BOT_WEIGHTS);
  const b = E.evaluateStatic(s, ROWS, COLS, 1, Object.assign({}, E.BOT_WEIGHTS, { edgeEscape: 0 }));
  assert.strictEqual(a, b);
  const on = E.evaluateStatic(s, ROWS, COLS, 1, Object.assign({}, E.BOT_WEIGHTS, { edgeEscape: 3 }));
  assert.ok(on > a, 'включённый признак поощряет давление на узкий выход');
});

console.log(`eval-a09: ${passed} passed`);
