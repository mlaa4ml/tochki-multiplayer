'use strict';
// A08 (issue #13): обязательные тактические кандидаты до обрезки.
// Запуск: node test/candidates.js
const E = require('../gameEngine.js');

let failed = 0;
function check(cond, msg){ if (!cond){ failed++; console.error('FAIL: ' + msg); } }
const J = v => JSON.stringify(v);
const key = c => c.x + ',' + c.y;

function emptyBoard(rows, cols){ return Array.from({ length: rows }, () => new Array(cols).fill(0)); }
function makeNode(rows, cols, stones, current, rules){
  const stone = emptyBoard(rows, cols);
  for (const [x, y, p] of stones) stone[y][x] = p;
  return E.createSearchNode({ stone, dead: emptyBoard(rows, cols), territory: emptyBoard(rows, cols),
    rows, cols, current, rules: rules || {} });
}
const has = (list, x, y, kind) => list.some(c => c.x === x && c.y === y && (!kind || (c.kinds || []).includes(kind)));
const diff = Object.assign({}, E.DIFFICULTY.normal);

// Белая точка 2 в (12,7) почти окружена точками 1 — не хватает (12,8)
// («дальний фланг»); в левом верхнем углу — плотный кластер без окружений,
// который перетягивает quickScore на себя.
function flankStones(){
  const s = [[11,7,1],[13,7,1],[12,6,1],[12,7,2]];
    // Кластер без каких-либо окружений за один ход: два ряда через пустую линию.
  const cluster = [[2,2,1],[3,2,1],[4,2,1],[5,2,1],[2,4,2],[3,4,2],[4,4,2],[5,4,2]];
  return s.concat(cluster);
}

// 1. Захват на дальнем фланге сохраняется даже при очень узком beam.
{
  const node = makeNode(12, 16, flankStones(), 1);
  const tac = E.tacticalCandidates(node, diff);
  check(has(tac, 12, 8, 'capture'), 'захват (12,8) найден: ' + J(tac));
  for (const cap of [1, 2, 3]){
    const c = E.searchCandidates(node, diff, cap);
    check(has(c, 12, 8), 'захват сохранён при cap=' + cap + ': ' + J(c.map(key)));
  }
  const old = E.searchCandidates(node, Object.assign({}, diff, { tactical: false }), 3);
  console.log('дальний фланг: старый beam(3) содержит захват =', has(old, 12, 8));
  const r = E.searchMove(node.state, 12, 16, 1, diff, null, { stonesPlacedTotal: node.stonesPlacedTotal, nodeLimit: 3000 });
  check(r.move && r.move.x === 12 && r.move.y === 8, 'поиск выбирает захват: ' + J(r.move));
}

// 2. Единственная защита: ходит 2, угроза захвата в (12,8) — клетка помечена block.
{
  const node = makeNode(12, 16, flankStones(), 2);
  const tac = E.tacticalCandidates(node, diff);
  check(has(tac, 12, 8, 'block'), 'защита (12,8) найдена: ' + J(tac));
  const c = E.searchCandidates(node, diff, 1);
  check(has(c, 12, 8), 'единственная защита сохранена при cap=1: ' + J(c.map(key)));
  // Защита проверена полным переходом: после (12,8) у 1 нет немедленного захвата.
  check(has(tac, 12, 8, 'defend'), 'защита (12,8) проверена как defend: ' + J(tac));
  // Ход вдали от угрозы защитой не считается.
  check(!has(tac, 3, 3, 'defend'), '(3,3) не помечен defend: ' + J(tac));
  // Проверка по определению: после каждого defend-хода лучший немедленный
  // захват соперника (по полному перебору) меньше, чем без хода.
  const oppBest = n => { let m = 0; const o = Object.assign({}, n, { current: 1 });
    for (let y = 0; y < n.rows; y++) for (let x = 0; x < n.cols; x++){
      const t = E.applyTransition(o, 1, x, y);
      if (t.ok){ const g = t.node.gameOver && t.node.winner === 1 ? Infinity : t.result.gained.filter(q => q.kind === 'captured').length; if (g > m) m = g; }
    } return m; };
  const before = oppBest(node);
  for (const d of tac.filter(t => t.kinds.includes('defend'))){
    const t = E.applyTransition(node, 2, d.x, d.y);
    check(t.ok && oppBest(t.node) < before, 'defend (' + d.x + ',' + d.y + ') реально снижает потерю');
  }
}

// 3. Пороговая победа: targetScore=1, захват сразу выигрывает.
{
  const node = makeNode(12, 16, flankStones(), 1, { targetScore: 1 });
  const tac = E.tacticalCandidates(node, diff);
  check(has(tac, 12, 8, 'win'), 'пороговая победа помечена win: ' + J(tac));
  const c = E.searchCandidates(node, diff, 1);
  check(c[0] && c[0].x === 12 && c[0].y === 8, 'победа первая в списке: ' + J(c.map(key)));
  const r = E.searchMove(node.state, 12, 16, 1, diff, null, { stonesPlacedTotal: node.stonesPlacedTotal, rules: { targetScore: 1 }, nodeLimit: 3000 });
  check(r.trace.stopReason === 'immediate-win' && r.move && r.move.x === 12 && r.move.y === 8,
    'немедленная победа: ' + J(r.move) + ' ' + r.trace.stopReason);
}

// 4. extraTurnOnCapture: после захвата ход остаётся, второй захват тоже обязателен.
{
  const st = flankStones().concat([[1,8,1],[3,8,1],[2,7,1],[2,8,2]]);
  const node = makeNode(12, 16, st, 1, { extraTurnOnCapture: true });
  const tac = E.tacticalCandidates(node, diff);
  check(has(tac, 12, 8, 'capture') && has(tac, 2, 9, 'capture'), 'оба захвата найдены: ' + J(tac));
  const t = E.applyTransition(node, 1, 12, 8);
  check(t.ok && t.result.extraTurn && t.node.current === 1, 'доп. ход после захвата');
  const tac2 = E.tacticalCandidates(t.node, diff);
  check(has(tac2, 2, 9, 'capture'), 'второй захват после доп. хода: ' + J(tac2));
  const c = E.searchCandidates(t.node, diff, 1);
  check(has(c, 2, 9), 'второй захват сохранён при cap=1: ' + J(c.map(key)));
}

// 4b. Стратегические кандидаты: путь выхода к краю. Точка 2 в (8,6) зажата
// с трёх сторон, единственная свобода (8,7); кратчайший путь к краю — вниз
// до y=11. Первые две клетки пути (8,7) и (8,8) — стратегические кандидаты.
{
  const node = makeNode(12, 16, [[7,6,1],[9,6,1],[8,5,1],[8,6,2]], 1);
  const s = E.strategicCandidates(node);
  check(has(s, 8, 7), 'выход к краю: первая клетка пути (8,7): ' + J(s));
  check(has(s, 8, 8), 'выход к краю: вторая клетка пути (8,8): ' + J(s));
  const all = E.searchCandidates(node, Object.assign({}, diff, { tactical: false }), 500);
  check(has(all, 8, 8), 'клетка пути выхода в наборе кандидатов: ' + J(all.map(key)));
}

// 5. Сравнение с полным перебором легальных ходов на малых случайных позициях.
function rng(seed){ let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
{
  let positions = 0, refMoves = 0, missedOld = 0, missedNew = 0, mismatch = 0, overflow = 0;
    let tOld = 0, tNew = 0;
  let bruteBlocks = 0, bruteDefTotal = 0, bruteDefMissedEngine = 0, bruteDefMissedOld = 0, bruteDefFalse = 0;
  for (let seed = 1; seed <= 60; seed++){
    const R = rng(seed);
    const rows = 7 + Math.floor(R() * 3), cols = 7 + Math.floor(R() * 3);
    const rules = { targetScore: R() < 0.3 ? 3 : 0, extraTurnOnCapture: R() < 0.5, targetFillPercent: R() < 0.2 ? 70 : 100 };
    let node = E.createSearchNode({ stone: emptyBoard(rows, cols), dead: emptyBoard(rows, cols), territory: emptyBoard(rows, cols),
      rows, cols, current: 1, stonesPlacedTotal: 2, rules });
    const plies = 10 + Math.floor(R() * 30);
    for (let i = 0; i < plies && !node.gameOver; i++){
      const legal = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (E.isTransitionLegal(node, x, y)) legal.push({ x, y });
      if (!legal.length) break;
      const m = legal[Math.floor(R() * legal.length)];
      node = E.applyTransition(node, node.current, m.x, m.y).node;
    }
    if (node.gameOver) continue;
    positions++;
    // Эталон: полный перебор всех клеток по полным правилам.
    const ref = E.tacticalCandidates(node, Object.assign({}, diff, { tacticalFullScan: true }));
    let t0 = Date.now();
    const fast = E.tacticalCandidates(node, diff);
    tNew += Date.now() - t0;
    if (J(ref) !== J(fast)){ mismatch++; console.error('mismatch seed=' + seed, J(ref), J(fast)); }
    // Независимая проверка эталона прямым перебором applyTransition.
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++){
      if (!E.isTransitionLegal(node, x, y)) continue;
      const t = E.applyTransition(node, node.current, x, y);
      const isCap = t.result.gained.some(g => g.kind === 'captured');
      const isWin = t.node.gameOver && t.node.winner === node.current;
      if (isCap) check(has(ref, x, y, 'capture'), 'seed=' + seed + ': эталон пропустил захват ' + x + ',' + y);
      if (isWin) check(has(ref, x, y, 'win'), 'seed=' + seed + ': эталон пропустил победу ' + x + ',' + y);
    }
    // НЕЗАВИСИМЫЙ эталон защит (не через tacticalCandidates): полный перебор
    // ВСЕХ легальных ходов ходящего и для каждого — ВСЕХ ответов соперника
    // прямыми applyTransition. Лучший немедленный выигрыш соперника:
    // Infinity — победа, иначе число пленённых точек. Защита — ход, после
    // которого этот выигрыш строго меньше, чем без хода (или собственная
    // победа / доп. ход после захвата — соперник сейчас не ходит).
    {
      const me = node.current, op = me === 1 ? 2 : 1;
      const gainOf = t => (t.node.gameOver && t.node.winner === op) ? Infinity
        : t.result.gained.filter(q => q.kind === 'captured').length;
      const oppBestAll = n => {
        const o = Object.assign({}, n, { current: op });
        let m = 0;
        for (let yy = 0; yy < rows; yy++) for (let xx = 0; xx < cols; xx++){
          const t = E.applyTransition(o, op, xx, yy);
          if (t.ok){ const g = gainOf(t); if (g > m) m = g; }
        }
        return m;
      };
      const before = oppBestAll(node);
      const bruteDef = new Set();
      if (before > 0){
        // Клетки угроз соперника: занять их, если легально, — 'block'.
        const o = Object.assign({}, node, { current: op });
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++){
          const t = E.applyTransition(o, op, x, y);
          if (t.ok && gainOf(t) > 0 && E.isTransitionLegal(node, x, y)){
            bruteBlocks++;
            check(has(ref, x, y, 'block'), 'seed=' + seed + ': эталон пропустил block ' + x + ',' + y);
          }
        }
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++){
          const t = E.applyTransition(node, me, x, y);
          if (!t.ok) continue;
          let isDef;
          if (t.node.gameOver) isDef = t.node.winner === me;
          else if (t.node.current === me) isDef = true;
          else isDef = oppBestAll(t.node) < before;
          if (isDef) bruteDef.add(y * cols + x);
        }
      }
      bruteDefTotal += bruteDef.size;
      for (const k of bruteDef){
        const x = k % cols, y = Math.floor(k / cols);
        if (!has(ref, x, y, 'defend')) bruteDefMissedEngine++;
        check(has(fast, x, y, 'defend'), 'seed=' + seed + ': защита ' + x + ',' + y + ' (полный перебор ответов) найдена движком');
        check(has(E.searchCandidates(node, diff, diff.candidateCap), x, y), 'seed=' + seed + ': защита ' + x + ',' + y + ' сохранена до поиска');
        if (!has(E.searchCandidates(node, Object.assign({}, diff, { tactical: false }), diff.candidateCap), x, y)) bruteDefMissedOld++;
      }
      // Обратное направление: каждая 'defend' движка — реальная защита по полному перебору.
      for (const m of ref) if (m.kinds.includes('defend') && !bruteDef.has(m.y * cols + m.x)){
        bruteDefFalse++;
        console.error('seed=' + seed + ': defend ' + key(m) + ' не подтверждён полным перебором');
      }
    }
    t0 = Date.now();
    const oldSet = E.searchCandidates(node, Object.assign({}, diff, { tactical: false }), diff.candidateCap);
    tOld += Date.now() - t0;
    const newSet = E.searchCandidates(node, diff, diff.candidateCap);
    for (const m of ref){
      refMoves++;
      if (!has(oldSet, m.x, m.y)) missedOld++;
      if (!has(newSet, m.x, m.y)) missedNew++;
    }
    // Обязательные ходы НЕ обрезаются никогда (даже при переполнении beam).
    if (ref.length > diff.candidateCap) overflow++;
    for (const m of ref) check(has(newSet, m.x, m.y), 'seed=' + seed + ': обязательный ход ' + key(m) + ' сохранён');
  }
  check(mismatch === 0, 'отсечение по соседству совпадает с полным перебором (' + mismatch + ' расхождений)');
  check(bruteDefFalse === 0, 'все defend движка подтверждены полным перебором ответов (' + bruteDefFalse + ' ложных)');
  check(bruteDefTotal > 0, 'в корпусе есть защиты по полному перебору: ' + bruteDefTotal);
  console.log('защиты (полный перебор ходов × ответов соперника): клеток угроз ' + bruteBlocks +
    ', защит ' + bruteDefTotal + ', пропущено движком ' + bruteDefMissedEngine +
    ', вне beam до A08 ' + bruteDefMissedOld + ', ложных defend ' + bruteDefFalse);
  check(positions >= 30, 'достаточно позиций: ' + positions);
  const pct = n => (refMoves ? (100 * n / refMoves).toFixed(1) : '0') + '%';
  console.log('корпус: позиций', positions, 'обязательных ходов', refMoves,
    '| пропущено до A08:', missedOld, '(' + pct(missedOld) + ')',
    '| после:', missedNew, '(' + pct(missedNew) + ')',
    '| переполнений tacticalCap:', overflow,
    '| генерация: старая', tOld, 'мс, тактика', tNew, 'мс');
}

// 6. Бюджет: лимит узлов соблюдается и с тактическими кандидатами.
{
  const node = makeNode(12, 16, flankStones(), 1);
  for (const nl of [1, 5, 50, 400]){
    const r = E.searchMove(node.state, 12, 16, 1, diff, null, { stonesPlacedTotal: node.stonesPlacedTotal, nodeLimit: nl });
    check(r.trace.nodes <= nl, 'nodeLimit=' + nl + ': узлов ' + r.trace.nodes);
    check(r.move && E.isTransitionLegal(node, r.move.x, r.move.y), 'nodeLimit=' + nl + ': легальный ход');
  }
}

// 7. Регрессия A08: тактический корпус бенчмарка (capture-in-1) — при
// nodeLimit=300 бот с A08 (tactical+strategic) находит все эталонные
// захваты, в т.ч. small-tactic-3 (раньше полный тактический скан в узлах
// продления съедал бюджет, итерация обрывалась и выбирался (5,2) вместо (6,2)).
{
  const fs = require('fs');
  const path = require('path');
  const Runner = require('../tools/bench/runner.js');
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'bench', 'corpus', 'openings.v1.json'), 'utf8'));
  const tactics = [].concat(...Object.values(corpus.tactics || {}));
  check(tactics.some(t => t.id === 'small-tactic-3'), 'в корпусе есть small-tactic-3');
  for (const t of tactics){
    const m = E.createMatch(t.rules);
    Runner.applyPrefix(m, t.prefix, () => {});
    const snap = m.getSnapshot();
    const node = E.createSearchNode(snap);
    const tac = E.tacticalCandidates(node, diff);
    check(t.expected.every(e => has(tac, e.x, e.y)), t.id + ': эталонный ход в тактическом наборе');
    const p = Runner.makeSearchPlayer(E, { difficulty: diff, nodeLimit: 300, weights: E.BOT_WEIGHTS });
    const r = p(snap);
    check(r.move && t.expected.some(e => e.x === r.move.x && e.y === r.move.y),
      t.id + ': бот выбрал эталонный ход (ход ' + J(r.move) + ', эталон ' + J(t.expected) + ')');
  }
}

if (failed){ console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('candidates: OK');
