'use strict';
// S6 (issue #60): локальный решатель угрожаемых групп.
// Запуск: node test/local-solver.js
// 1) Корректность 100%: каждое «спасение есть, ход X» сверяется полным
//    перебором ВСЕХ легальных ходов обеих сторон (как в test/candidates.js)
//    на малых случайных позициях 5×5–6×6: после X потеря группы на горизонте
//    BRUTE полуходов равна 0.
// 2) Полнота: доля позиций, где перебор находит спасение, а решатель тоже.
// 3) regression (#57): решатель находит спасение везде, где оно существует.
const E = require('../gameEngine.js');
const S = require('../tools/bench/localSolver.js');

let failed = 0;
function check(cond, msg){ if (!cond){ failed++; console.error('FAIL: ' + msg); } }
const other = p => (p === 1 ? 2 : 1);
function emptyBoard(r, c){ return Array.from({ length: r }, () => new Array(c).fill(0)); }
function rng(seed){ let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const BRUTE = 3; // полуходов после хода защитника: атака, защита, атака

// Полный минимакс по всем легальным ходам (атакующий max, защитник min).
function brute(node, depth, def, target){
  const att = other(def), base = S.lossOf(node, target, att);
  if (base >= target.length || depth <= 0 || node.gameOver) return base;
  const me = node.current, isDef = me === def;
  let best = isDef ? Infinity : base, any = false;
  for (let y = 0; y < node.rows; y++) for (let x = 0; x < node.cols; x++){
    if (!E.isTransitionLegal(node, x, y)) continue;
    const t = E.applyTransition(node, me, x, y);
    if (!t.ok) continue;
    any = true;
    const v = brute(t.node, depth - 1, def, target);
    if (isDef ? v < best : v > best) best = v;
    if (isDef && best === base) return best;
    if (!isDef && best >= target.length) return best;
  }
  return any ? best : base;
}

// 1–2. Случайные позиции.
{
  let positions = 0, rescueExists = 0, found = 0, savedClaims = 0, lostClaims = 0, wrong = 0, ms = 0;
  for (let seed = 1; seed <= 400 && positions < 60; seed++){
    const R = rng(seed);
    const rows = 5 + Math.floor(R() * 2), cols = 5 + Math.floor(R() * 2);
    let node = E.createSearchNode({ stone: emptyBoard(rows, cols), dead: emptyBoard(rows, cols), territory: emptyBoard(rows, cols),
      rows, cols, current: 1, stonesPlacedTotal: 2, rules: {} });
    const plies = 8 + Math.floor(R() * 8);
    for (let i = 0; i < plies && !node.gameOver; i++){
      const legal = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (E.isTransitionLegal(node, x, y)) legal.push({ x, y });
      if (!legal.length) break;
      const m = legal[Math.floor(R() * legal.length)];
      node = E.applyTransition(node, node.current, m.x, m.y).node;
    }
    if (node.gameOver) continue;
    const def = node.current, att = other(def);
    // Угрожаемая группа: точка защитника, которую атакующий берёт одним ходом.
    let target = null;
    const o = Object.assign({}, node, { current: att });
    for (let y = 0; y < rows && !target; y++) for (let x = 0; x < cols && !target; x++){
      if (!E.isTransitionLegal(o, x, y)) continue;
      const t = E.applyTransition(o, att, x, y);
      if (!t.ok) continue;
      for (const g of t.result.gained) if (g.kind === 'captured' && node.state.stone[g.y][g.x] === def){
        target = S.groupAt(node, g.x, g.y); break;
      }
    }
    if (!target || !target.length) continue;
    positions++;
    const base = S.lossOf(node, target, att);
    // Эталон: существует ли спасение (любой легальный ход защитника).
    let exists = false;
    for (let y = 0; y < rows && !exists; y++) for (let x = 0; x < cols && !exists; x++){
      if (!E.isTransitionLegal(node, x, y)) continue;
      const t = E.applyTransition(node, def, x, y);
      if (t.ok && brute(t.node, BRUTE, def, target) === base) exists = true;
    }
    const res = S.solveGroup(node, def, target, { maxDepth: 8, verifyDepth: BRUTE, nodeLimit: 50000 });
    ms += res.ms;
    if (exists) rescueExists++;
    if (res.saved){
      savedClaims++;
      const t = E.applyTransition(node, def, res.move.x, res.move.y);
      const v = brute(t.node, BRUTE, def, target);
      const ok = t.ok && v === base;
      if (!ok) wrong++;
      check(ok, 'seed=' + seed + ': ложное спасение ' + JSON.stringify(res.move) + ' потеря ' + (v - base));
      if (exists && ok) found++;
    } else {
      lostClaims++;
      check(res.loss > 0 || !res.move, 'seed=' + seed + ': «потеряна» с потерей 0');
    }
  }
  check(positions >= 20, 'мало позиций с угрозой: ' + positions);
  const completeness = rescueExists ? found / rescueExists : 1;
  console.log('local-solver: позиций ' + positions + ', спасение есть (перебор) ' + rescueExists +
    ', найдено решателем ' + found + ' (полнота ' + (100 * completeness).toFixed(1) + '%), ложных спасений ' + wrong +
    ', «потеряна» ' + lostClaims + ', среднее время ' + (positions ? (ms / positions).toFixed(1) : 0) + ' мс');
}

// 3. regression (#57).
{
  const rows = S.runRegression({ maxDepth: 10, verifyDepth: 1 });
  check(rows.length === 2, 'позиций regression: ' + rows.length);
  for (const r of rows){
    console.log('regression ' + r.id + ': ' + JSON.stringify(r));
    if (r.rescueExists){
      check(r.saved, r.id + ': решатель не нашёл спасение');
      check(r.forkLoss4OfMove === null || r.forkLoss4OfMove <= r.minLoss + 1,
        r.id + ': ход решателя не спасает по forkLoss4: ' + r.forkLoss4OfMove);
    }
  }
}

if (failed){ console.error(failed + ' проверок не прошло'); process.exit(1); }
console.log('local-solver: OK');
