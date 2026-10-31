// tools/bench/monitor.js — монитор опасных групп бота (issue #59, S5 дорожной карты).
//
// ТОЛЬКО НАБЛЮДЕНИЕ: функции модуля не меняют узел и не участвуют в выборе
// хода. Их использует отчёт tools/bench/monitor-report.js.
//
// monitorPosition(node, p) для каждой группы игрока p (живые точки,
// связность по 8 соседям, как контуры в «Точках») считает признаки:
//   size         — число точек группы (точки под риском);
//   exits        — число свободных клеток, 4-соседних с группой (выходы);
//   cost         — стоимость окружения: минимальное число ходов противника,
//                  после которых хотя бы одна точка группы окажется в
//                  области, отрезанной от края (по правилам runCaptures:
//                  заливка по 4 соседям через не-стены противника, область не
//                  касается края). Считается как минимальный вершинный разрез
//                  (max-flow с расщеплением вершин) от КАЖДОЙ точки группы до
//                  края; резать можно только пустые клетки, свои точки бота и
//                  его территорию противник занять не может (бесконечная
//                  ёмкость), стены противника уже стоят (ёмкость 0).
//                  Так край обрабатывается корректно: точка, стоящая на краю
//                  или связанная с краем 4-цепочкой своих точек, не
//                  захватывается (cost = Infinity), а остальные точки той же
//                  группы — считаются отдельно (захватываемые подмножества).
//                  Группа у края больше не считается безопасной целиком.
//                  Разрез больше MAX_COST не ищется (cost = Infinity);
//   ringProgress — прогресс кольца: для лучшего разреза доля клеток кольца
//                  (граница отрезаемой области), уже занятых стенами
//                  противника: walls / (walls + cut);
//   capture      — сколько живых точек бота окажется в отрезанной области.
// На уровне позиции: tempo ('own' — ход игрока p, 'opp' — ход противника)
// и twoMoveThreat(node, opp) из #55 (очки, которые противник берёт двумя
// ходами подряд). Время считается отдельно: msCheap (группы и разрезы) и
// msTwoMove (twoMoveThreat).
'use strict';
const E = require('../../gameEngine.js');

const MAX_COST = 6;
const INF = 1 << 29;
const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1]; // противоположное направление: d ^ 1

function nowMs(){ const t = process.hrtime(); return t[0] * 1e3 + t[1] / 1e6; }

// Подготовка слоёв позиции для игрока p (одна аллокация на позицию).
function prepare(node, p){
  const rows = node.rows, cols = node.cols, n = rows * cols;
  const st = node.state, opp = p === 1 ? 2 : 1;
  // kind: 0 — стена противника (в граф не входит), 1 — пустая (ёмкость 1),
  // 2 — непроходимая для противника клетка (точки/территория бота и т.п.)
  const kind = new Uint8Array(n), live = new Uint8Array(n), border = new Uint8Array(n);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++){
    const v = y * cols + x;
    const s = st.stone[y][x], d = st.dead[y][x], t = st.territory[y][x];
    const oppWall = d === opp || t === opp || (d === 0 && s === opp);
    if (oppWall) kind[v] = 0;
    else if (s === 0 && d === 0 && t === 0) kind[v] = 1;
    else kind[v] = 2;
    if (s === p && d === 0) live[v] = 1;
    if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) border[v] = 1;
  }
  return {
    rows, cols, n, kind, live, border,
    fi: new Int32Array(n), ef: new Int32Array(4 * n),
    seen: new Uint8Array(2 * n), par: new Int32Array(2 * n), ptype: new Int8Array(2 * n),
    queue: new Int32Array(2 * n)
  };
}

function nb(P, v, d){
  const y = (v / P.cols) | 0, x = v - y * P.cols;
  const nx = x + DX[d], ny = y + DY[d];
  if (nx < 0 || ny < 0 || nx >= P.cols || ny >= P.rows) return -1;
  return ny * P.cols + nx;
}

// Один поиск увеличивающего пути в остаточной сети. Вершина-состояние
// s = 2v (вход клетки v) или 2v+1 (выход). Возвращает клетку, из выхода
// которой достигнут сток (край), или -1.
function bfs(P, src){
  const { seen, par, ptype, queue, kind, fi, ef, border } = P;
  seen.fill(0);
  let h = 0, t = 0;
  const s0 = src * 2;
  seen[s0] = 1; queue[t++] = s0;
  const visit = (s, from, type) => { if (!seen[s]){ seen[s] = 1; par[s] = from; ptype[s] = type; queue[t++] = s; } };
  while (h < t){
    const s = queue[h++], v = s >> 1;
    if ((s & 1) === 0){
      const cap = kind[v] === 1 ? 1 : INF;
      if (fi[v] < cap) visit(s + 1, s, 0);
      for (let d = 0; d < 4; d++){
        const u = nb(P, v, d);
        if (u < 0 || kind[u] === 0) continue;
        if (ef[u * 4 + (d ^ 1)] > 0) visit(u * 2 + 1, s, 1 + (d ^ 1));
      }
    } else {
      if (border[v]) return v;
      for (let d = 0; d < 4; d++){
        const u = nb(P, v, d);
        if (u < 0 || kind[u] === 0) continue;
        visit(u * 2, s, 10 + d);
      }
      if (fi[v] > 0) visit(s - 1, s, 20);
    }
  }
  return -1;
}

function augment(P, sinkCell, src){
  const { par, ptype, fi, ef } = P;
  let s = sinkCell * 2 + 1;
  while (s !== src * 2){
    const t = ptype[s], ps = par[s];
    if (t === 0) fi[s >> 1]++;
    else if (t >= 1 && t <= 4) ef[(s >> 1) * 4 + (t - 1)]--;
    else if (t >= 10 && t <= 13) ef[(ps >> 1) * 4 + (t - 10)]++;
    else if (t === 20) fi[s >> 1]--;
    s = ps;
  }
}

// Минимальный разрез от точки src до края. Возвращает
// { cost, cut:[v], walls, capture } или { cost: Infinity }.
function minCutFrom(P, src, maxCost){
  if (P.border[src]) return { cost: Infinity };
  P.fi.fill(0); P.ef.fill(0);
  let flow = 0;
  for (;;){
    const sink = bfs(P, src);
    if (sink < 0) break;
    flow++;
    if (flow > maxCost) return { cost: Infinity };
    augment(P, sink, src);
  }
  // seen — достижимость из src в остаточной сети после последнего bfs
  const { seen, kind, live } = P;
  const cut = [], wallSet = new Set();
  let capture = 0;
  for (let v = 0; v < P.n; v++){
    if (seen[2 * v] && !seen[2 * v + 1] && kind[v] === 1) cut.push(v);
    if (!seen[2 * v + 1]) continue;
    if (live[v]) capture++;
    for (let d = 0; d < 4; d++){
      const u = nb(P, v, d);
      if (u >= 0 && kind[u] === 0) wallSet.add(u);
    }
  }
  return { cost: flow, cut, walls: wallSet.size, capture };
}

function groupsOf(P){
  const gid = new Int32Array(P.n).fill(-1), groups = [];
  for (let v0 = 0; v0 < P.n; v0++){
    if (!P.live[v0] || gid[v0] >= 0) continue;
    const id = groups.length, stones = [v0];
    gid[v0] = id;
    for (let k = 0; k < stones.length; k++){
      const v = stones[k], y = (v / P.cols) | 0, x = v - y * P.cols;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){
        const nx = x + dx, ny = y + dy;
        if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= P.cols || ny >= P.rows) continue;
        const u = ny * P.cols + nx;
        if (P.live[u] && gid[u] < 0){ gid[u] = id; stones.push(u); }
      }
    }
    groups.push(stones);
  }
  return groups;
}

// Порог стоимости, ниже которого считается локальный twoMoveThreat (задан до прогона).
const LOCAL_COST = 3;

function capCount(gained){
  let c = 0;
  for (const g of gained || []) if (g.kind === 'captured') c++;
  return c;
}

// Локальный twoMoveThreat: лучший захват противника opp двумя ходами подряд
// только по клеткам cells (индексы y*cols+x). Узел не меняется (клон).
function localTwoMove(node, opp, cells, cols){
  if (node.gameOver || !cells.length) return 0;
  const n = E.cloneSearchNode(node);
  n.current = opp;
  let best = 0;
  for (const v of cells){
    const t = E.applyTransition(n, opp, v % cols, (v / cols) | 0);
    if (!t || !t.ok) continue;
    const c1 = capCount(t.result.gained);
    if (c1 > best) best = c1;
    if (t.node.gameOver) continue;
    t.node.current = opp;
    for (const w of cells){
      if (w === v) continue;
      const u = E.applyTransition(t.node, opp, w % cols, (w / cols) | 0);
      if (!u || !u.ok) continue;
      const c2 = c1 + capCount(u.result.gained);
      if (c2 > best) best = c2;
    }
  }
  return best;
}

// Признаки всех групп игрока p в узле node. Узел не меняется.
// opts.twoMove (по умолчанию true) — считать twoMoveThreat; opts.maxCost.
function monitorPosition(node, p, opts){
  opts = opts || {};
  const maxCost = opts.maxCost || MAX_COST;
  const opp = p === 1 ? 2 : 1;
  const t0 = nowMs();
  const P = prepare(node, p);
  const toXY = v => ({ x: v % P.cols, y: (v / P.cols) | 0 });
  const groups = groupsOf(P).map((stones, id) => {
    const lib = new Set();
    for (const v of stones) for (let d = 0; d < 4; d++){
      const u = nb(P, v, d);
      if (u >= 0 && P.kind[u] === 1) lib.add(u);
    }
    let best = { cost: Infinity };
    for (const v of stones){
      const r = minCutFrom(P, v, Math.min(maxCost, best.cost === Infinity ? maxCost : best.cost));
      if (r.cost < best.cost || (r.cost === best.cost && r.cost !== Infinity && r.capture > best.capture)) best = r;
    }
    const finite = best.cost !== Infinity;
    return {
      id, size: stones.length, stones: stones.map(toXY), exits: lib.size,
      cost: best.cost,
      ringProgress: finite ? (best.walls + best.cut.length ? best.walls / (best.walls + best.cut.length) : 1) : 0,
      capture: finite ? best.capture : 0,
      cut: finite ? best.cut.map(toXY) : []
    };
  });
  // --- Признаки на замену (S5, раунд 4). Пороги заданы ДО прогона. ---
  // Замена 1: падение стоимости окружения с прошлой позиции (после
  // предыдущего хода бота, т.е. за ход противника + ход бота). opts.prev —
  // результат monitorPosition на прошлом ходу бота. Группа сопоставляется по
  // общим точкам; если раньше разреза не было (cost = Infinity), а теперь
  // есть, падение = MAX_COST + 1 - cost.
  const prevCost = new Map();
  if (opts.prev) for (const g of opts.prev.groups) for (const s of g.stones) prevCost.set(s.x + ',' + s.y, g.cost);
  for (const g of groups){
    if (!opts.prev){ g.prevCost = null; g.costDrop = 0; continue; }
    let pc = Infinity;
    for (const s of g.stones){ const c = prevCost.get(s.x + ',' + s.y); if (c !== undefined && c < pc) pc = c; }
    g.prevCost = pc;
    if (g.cost === Infinity) g.costDrop = 0;
    else if (pc === Infinity) g.costDrop = maxCost + 1 - g.cost;
    else g.costDrop = pc - g.cost;
  }
  // Замена 2: локальный twoMoveThreat — два хода противника подряд только по
  // клеткам разреза группы и их 8-соседям (пустым). Считается для групп с
  // cost <= LOCAL_COST, иначе 0.
  const tL0 = nowMs();
  for (const g of groups){
    g.localTwo = 0;
    if (g.cost === Infinity || g.cost > LOCAL_COST) continue;
    const cells = new Set();
    for (const c of g.cut) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= P.cols || ny >= P.rows) continue;
      const u = ny * P.cols + nx;
      if (P.kind[u] === 1) cells.add(u);
    }
    g.localTwo = localTwoMove(node, opp, [...cells], P.cols);
  }
  const msLocal = nowMs() - tL0;
  // Замена 3: стоимость окружения с учётом вынуждающих ходов противника.
  // Ход противника в пустую клетку, общую для разрезов двух групп бота с
  // cost <= LOCAL_COST, — вилка: одним ходом он сокращает обе стоимости, а
  // бот за свой ход защищает только одну. Для такой группы forcedCost =
  // cost - 1 (противник выигрывает темп), иначе forcedCost = cost.
  const cutOwners = new Map();
  for (const g of groups){
    if (g.cost === Infinity || g.cost > LOCAL_COST) continue;
    for (const c of g.cut){ const k = c.x + ',' + c.y; cutOwners.set(k, (cutOwners.get(k) || 0) + 1); }
  }
  for (const g of groups){
    g.fork = false;
    if (g.cost !== Infinity && g.cost <= LOCAL_COST)
      for (const c of g.cut) if (cutOwners.get(c.x + ',' + c.y) > 1){ g.fork = true; break; }
    g.forcedCost = g.fork ? g.cost - 1 : g.cost;
  }
  const t1 = nowMs();
  let twoMove = null, msTwoMove = 0;
  if (opts.twoMove !== false && !node.gameOver){
    twoMove = E.twoMoveThreat(E.cloneSearchNode(node), opp);
    msTwoMove = nowMs() - t1;
  }
  let minCost = Infinity;
  for (const g of groups) if (g.cost < minCost) minCost = g.cost;
  // msCheap включает msLocal (локальный twoMoveThreat) — это всё, кроме полного twoMoveThreat.
  return { player: p, tempo: node.current === p ? 'own' : 'opp', groups, minCost, twoMove, msCheap: t1 - t0, msLocal, msTwoMove };
}

// Правила тревоги. ЗАДАНЫ ДО ПРОГОНА ПО КОРПУСУ и по партиям не подбираются
// (issue #59: «подгонять пороги под 6 партий нельзя»). Каждое правило —
// отдельный признак: отчёт показывает, какой проходит критерии, а какой
// нужно заменить. group-правило возвращает true для группы; position-правило
// поднимает тревогу на всю позицию.
const RULES = {
  cost:     { kind: 'group', desc: 'стоимость окружения <= 2', test: g => g.cost <= 2 },
  ring:     { kind: 'group', desc: 'прогресс кольца >= 0.75', test: g => g.cost !== Infinity && g.ringProgress >= 0.75 },
  exits:    { kind: 'group', desc: 'группа >= 2 точек и выходов <= 1', test: g => g.size >= 2 && g.exits <= 1 },
  twoMove:  { kind: 'position', desc: 'twoMoveThreat >= 2', test: r => (r.twoMove || 0) >= 2 },
  combined: { kind: 'mixed', desc: 'cost <= 2 или twoMoveThreat >= 2', test: g => g.cost <= 2, pos: r => (r.twoMove || 0) >= 2 }
};

// Тревоги позиции по правилу: { on, all, stones:Set('x,y') }.
function alarmOf(res, ruleName){
  const R = RULES[ruleName];
  const out = { on: false, all: false, stones: new Set() };
  if (R.kind === 'position' || R.kind === 'mixed'){
    const posTest = R.kind === 'position' ? R.test : R.pos;
    if (posTest(res)){ out.on = true; out.all = true; }
  }
  if (R.kind === 'group' || R.kind === 'mixed'){
    for (const g of res.groups) if (R.test(g)){
      out.on = true;
      for (const s of g.stones) out.stones.add(s.x + ',' + s.y);
    }
  }
  return out;
}

module.exports = { monitorPosition, alarmOf, RULES, MAX_COST };
