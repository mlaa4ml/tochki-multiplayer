'use strict';
// A04 (issue #9): корректное прерывание поиска, детерминированный лимит узлов, trace.
// Запуск: node test/search.js
const E = require('../gameEngine.js');

let failed = 0;
function check(cond, msg){ if (!cond){ failed++; console.error('FAIL: ' + msg); } }
const J = v => JSON.stringify(v);

// Позиция середины партии, построенная самим движком (детерминированно, по лимиту узлов).
function buildMatch(moves){
  const m = E.createMatch({ sizeKey: 'medium' });
  for (let i = 0; i < moves; i++){
    const mv = m.botMove('normal', null, { nodeLimit: 300 });
    if (!mv) break;
    const r = m.applyMove(m.getSnapshot().current, mv.x, mv.y);
    if (!r.ok) throw new Error('bot produced illegal move ' + J(mv) + ' ' + r.reason);
  }
  return m;
}

function searchOn(m, diff, opts){
  const s = m.getSnapshot();
  return E.searchMove(s, s.rows, s.cols, s.current, diff, null,
    Object.assign({ stonesPlacedTotal: s.stonesPlacedTotal, gameOver: s.gameOver, rules: s.rules }, opts));
}

function isLegalForSnap(m, mv){
  const s = m.getSnapshot();
  const node = E.createSearchNode({ stone: s.stone, dead: s.dead, territory: s.territory, rows: s.rows, cols: s.cols,
    current: s.current, stonesPlacedTotal: s.stonesPlacedTotal, gameOver: s.gameOver, rules: s.rules });
  return E.isTransitionLegal(node, mv.x, mv.y);
}

function allFinite(trace){
  return trace.candidates.every(c => Number.isFinite(c.score)) && Number.isFinite(trace.nodes) && Number.isFinite(trace.elapsedMs);
}

// Управляемые часы: каждый вызов продвигает время на 1 «тик».
function stepClock(){ let t = 0; return () => t++; }

const diff = Object.assign({}, E.DIFFICULTY.normal, { maxDepth: 3 });
const m = buildMatch(8);

// 1. Остановка до первого ребёнка (таймер 0 тиков).
{
  const r = searchOn(m, diff, { timeLimit: 0, clock: stepClock() });
  check(r.trace.stopReason === 'time', 'до первого ребёнка: stopReason=time, получено ' + r.trace.stopReason);
  check(r.trace.completedDepth === 0, 'до первого ребёнка: completedDepth=0');
  check(r.trace.nodes === 0, 'до первого ребёнка: 0 узлов, получено ' + r.trace.nodes);
  check(r.move && isLegalForSnap(m, r.move), 'до первого ребёнка: легальный резервный ход ' + J(r.move));
}

// 2. Остановка внутри вложенного узла (лимит в 1 узел) — по узлам, а не по таймеру.
{
  const r = searchOn(m, diff, { nodeLimit: 1, clock: stepClock() });
  check(r.trace.stopReason === 'node-limit', 'вложенный узел: stopReason=node-limit, получено ' + r.trace.stopReason);
  check(r.trace.nodes === 1, 'вложенный узел: ровно 1 узел, получено ' + r.trace.nodes);
  check(r.trace.completedDepth === 0, 'вложенный узел: неполная итерация не принята');
  check(r.move && isLegalForSnap(m, r.move), 'вложенный узел: легальный ход');
}

// 3. Полные эталоны по глубинам (без ограничений) — для проверки «принимается
// только завершённая итерация».
const full = {};
for (const d of [2, 3]){
  const r = searchOn(m, Object.assign({}, diff, { maxDepth: d }), { nodeLimit: 1e9 });
  check(r.trace.stopReason === 'max-depth', 'эталон d=' + d + ': завершён');
  check(r.trace.completedDepth === d, 'эталон d=' + d + ': completedDepth');
  full[d] = r;
}
const fallback = searchOn(m, diff, { nodeLimit: 1 }).move;

// 4. Свип таймера управляемыми часами: каждая точка проверки бюджета (до
// первого ребёнка, внутри вложенных узлов, до/после продлений) рано или поздно
// оказывается точкой обрыва. Ход всегда равен ходу последней завершённой итерации.
{
  const maxTicks = full[3].trace.nodes * 12 + 50;
  const step = Math.max(1, Math.floor(maxTicks / 400));
  let sawTime = 0, sawRootStop = 0, sawWinLoopStop = 0;
  // Независимый расчёт первого легального хода (сканирование y, затем x).
  let firstLegal = null;
  { const s0 = m.getSnapshot();
    for (let y = 0; y < s0.rows && !firstLegal; y++)
      for (let x = 0; x < s0.cols && !firstLegal; x++)
        if (isLegalForSnap(m, { x, y })) firstLegal = { x, y }; }
  // Малые лимиты (0..5 тиков) — всегда: обрыв до генерации корневых
  // кандидатов и внутри перебора немедленных побед.
  const tls = [0, 1, 2, 3, 4, 5];
  for (let tl = 6; tl <= maxTicks; tl += step) tls.push(tl);
  for (const tl of tls){
    const r = searchOn(m, diff, { timeLimit: tl, clock: stepClock() });
    if (r.trace.stopReason === 'time') sawTime++;
    check(allFinite(r.trace), 'свип tl=' + tl + ': нет ±Infinity/NaN ' + J(r.trace.candidates));
    check(r.move && isLegalForSnap(m, r.move), 'свип tl=' + tl + ': легальный ход');
    const d = r.trace.completedDepth;
    if (r.trace.fallback === 'first-legal') sawRootStop++;
    if (r.trace.fallback === 'first-candidate') sawWinLoopStop++;
    const expected = r.trace.fallback === 'first-legal' ? firstLegal : (d === 0 ? fallback : full[d].move);
    check(r.move.x === expected.x && r.move.y === expected.y,
      'свип tl=' + tl + ': ход ' + J(r.move) + ' != ход завершённой глубины ' + d + ' ' + J(expected));
    if (d > 0) check(J(r.trace.candidates) === J(full[d].trace.candidates), 'свип tl=' + tl + ': кандидаты = эталон');
  }
  check(sawTime > 10, 'свип: остановки по таймеру происходили (' + sawTime + ')');
}

// 5. Свип лимита узлов — то же для node-limit.
{
  const total = full[3].trace.nodes;
  const step = Math.max(1, Math.floor(total / 300));
  for (let nl = 1; nl < total; nl += step){
    const r = searchOn(m, diff, { nodeLimit: nl });
    check(r.trace.stopReason === 'node-limit', 'nl=' + nl + ': stopReason=node-limit, получено ' + r.trace.stopReason);
    check(r.trace.nodes <= nl, 'nl=' + nl + ': узлов не больше лимита');
    check(allFinite(r.trace), 'nl=' + nl + ': конечные оценки');
    const d = r.trace.completedDepth;
    const expected = d === 0 ? fallback : full[d].move;
    check(r.move.x === expected.x && r.move.y === expected.y, 'nl=' + nl + ': принята только завершённая итерация');
  }
}

// 6. Детерминизм: одинаковые вход и лимит узлов — одинаковый ход и диагностика.
{
  const strip = t => { const c = Object.assign({}, t); delete c.elapsedMs; return J(c); };
  const a = searchOn(m, diff, { nodeLimit: 500 });
  const b = searchOn(buildMatch(8), diff, { nodeLimit: 500 });
  check(J(a.move) === J(b.move), 'детерминизм: ход совпадает');
  check(strip(a.trace) === strip(b.trace), 'детерминизм: trace совпадает');
  check(a.trace.params.nodeLimit === 500 && a.trace.params.timeLimit === null, 'детерминизм: таймер выключен при nodeLimit');
  // Аварийный таймер при лимите узлов различим по причине остановки.
  const em = searchOn(m, diff, { nodeLimit: 1e9, emergencyTimeLimit: 5, clock: stepClock() });
  check(em.trace.stopReason === 'time', 'аварийный таймер: stopReason=time, получено ' + em.trace.stopReason);
}

// 7. Нет хода после gameOver / при отсутствии легальных ходов.
{
  const g = E.createMatch({ sizeKey: 'medium' });
  g.applyMove(1, 7, 5);
  g.endNow();
  check(g.botMove('normal') === null, 'gameOver: botMove возвращает null');
  const r = g.botSearch('normal', null, { nodeLimit: 100 });
  check(r.move === null && r.trace.stopReason === 'game-over', 'gameOver: trace ' + J(r.trace.stopReason));
}

// 8. Совместимость botMove и диагностика через onTrace/botSearch.
{
  const mm = buildMatch(4);
  let got = null;
  const mv = mm.botMove('normal', null, { nodeLimit: 400, onTrace: t => { got = t; } });
  check(mv && Number.isInteger(mv.x) && Number.isInteger(mv.y), 'botMove: возвращает ход');
  check(got && got.move.x === mv.x && got.move.y === mv.y, 'onTrace: trace соответствует ходу');
  const plain = mm.botMove('normal');
  check(plain && isLegalForSnap(mm, plain), 'botMove без параметров: легальный ход (таймер diff.timeLimit)');
}

// 9. Реальная задержка таймера (измерение, не жёсткий real-time).
{
  const mm = buildMatch(10);
  const big = Object.assign({}, E.DIFFICULTY.normal, { maxDepth: 12 });
  const overs = [];
  for (const tl of [20, 50, 100]){
    for (let i = 0; i < 3; i++){
      const t0 = Date.now();
      const r = searchOn(mm, big, { timeLimit: tl });
      const wall = Date.now() - t0;
      overs.push(wall - tl);
      check(r.move && isLegalForSnap(mm, r.move), 'реальный таймер: легальный ход');
      if (i === 0) console.log(`timeLimit=${tl}ms: wall=${wall}ms elapsed=${r.trace.elapsedMs.toFixed(1)}ms stop=${r.trace.stopReason} depth=${r.trace.completedDepth} nodes=${r.trace.nodes}`);
    }
  }
  console.log(`превышение таймера (wall - limit), мс: min=${Math.min(...overs)} max=${Math.max(...overs)}`);
}

if (failed){ console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('OK: search budget/abort/trace tests passed');
