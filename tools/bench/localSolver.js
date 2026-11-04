#!/usr/bin/env node
// tools/bench/localSolver.js — локальный решатель для угрожаемых групп (issue #60, S6).
//
// solveGroup(node, def, target, opts) — ходит защитник def (node.current === def).
// target — клетки группы защитника [{x,y}] (живые точки). Потеря = число точек
// target, пленённых атакующим. Поиск только в РЕГИОНЕ: пустые клетки в радиусе
// opts.radius (2) от точек группы, упорядоченные по близости, не более
// opts.maxCells (20). Минимакс с альфа-бета и итеративным углублением:
//   атакующий играет только ВЫНУЖДАЮЩИЕ ходы: взятие точек группы сейчас или
//     ход, после которого у него есть немедленное взятие точек группы (угроза).
//     Нет вынуждающих ходов — атакующий «останавливается» (лист = текущая потеря);
//   защитник играет ТОЛЬКО выходы (клетки, соседние с непленённой точкой
//     группы) и ходы, снимающие угрозу (после хода лучшее немедленное взятие
//     точек группы строго меньше), не более opts.maxCand (10) — defMoves().
// ПРОВЕРКА спасения: найденный ход X подтверждается поиском, где атакующий
// играет ЛЮБОЙ легальный ход всего поля (verifyDepth полуходов после X, защитник
// — по региону). Это верхняя граница потери, поэтому «спасение есть» выдаётся,
// только если она равна 0: найденное решение реально работает на этом горизонте.
// Ответ: { saved:true, move } — «спасение есть, лучший ход X»;
//        { saved:false, move, loss } — «группа потеряна, ожидаемая потеря N».
//
// CLI: node tools/bench/localSolver.js [--depth 10] [--json out.json]
//   прогон по позициям tools/bench/corpus/prefork.regression.json (#57).
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../../gameEngine.js');

const other = p => (p === 1 ? 2 : 1);
function nowMs(){ const t = process.hrtime(); return t[0] * 1e3 + t[1] / 1e6; }

// Группа (8-связность) живых точек владельца клетки (x,y).
function groupAt(node, x, y){
  const st = node.state, p = st.stone[y][x];
  if (!p || st.dead[y][x]) return [];
  const seen = new Set([y * node.cols + x]), q = [[x, y]], out = [];
  while (q.length){
    const [cx, cy] = q.pop();
    out.push({ x: cx, y: cy });
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){
      const nx = cx + dx, ny = cy + dy, k = ny * node.cols + nx;
      if (nx < 0 || ny < 0 || nx >= node.cols || ny >= node.rows || seen.has(k)) continue;
      if (st.stone[ny][nx] === p && !st.dead[ny][nx]){ seen.add(k); q.push([nx, ny]); }
    }
  }
  return out;
}

// Сколько точек target пленено атакующим att.
function lossOf(node, target, att){
  const d = node.state.dead;
  let n = 0;
  for (const c of target) if (d[c.y][c.x] === att) n++;
  return n;
}

// Регион: пустые клетки в радиусе R от группы; сортировка по расстоянию,
// затем по числу соседних точек группы.
function regionOf(node, target, R, maxCells){
  const st = node.state, m = new Map();
  for (const c of target) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++){
    const x = c.x + dx, y = c.y + dy;
    if (x < 0 || y < 0 || x >= node.cols || y >= node.rows) continue;
    if (st.stone[y][x] || st.dead[y][x] || st.territory[y][x]) continue;
    const k = y * node.cols + x, d = Math.max(Math.abs(dx), Math.abs(dy));
    const e = m.get(k);
    if (!e) m.set(k, { x, y, d, adj: d === 1 ? 1 : 0 });
    else { if (d < e.d) e.d = d; if (d === 1) e.adj++; }
  }
  return [...m.values()].sort((a, b) => a.d - b.d || b.adj - a.adj || a.y - b.y || a.x - b.x).slice(0, maxCells);
}

function tryMove(node, p, c){
  if (!E.isTransitionLegal(node, c.x, c.y)) return null;
  const t = E.applyTransition(node, p, c.x, c.y);
  return t.ok ? t : null;
}

// All phases share one deadline/node budget, including move generation and
// verification. Aborted verification must never be reported as a saved group.
const BUDGET_EXHAUSTED = Symbol('solver budget exhausted');
function checkBudget(ctx, count){
  if (count) ctx.work++;
  if (ctx.work > ctx.nodeLimit || nowMs() >= ctx.deadline) throw BUDGET_EXHAUSTED;
}
function budgetedMove(ctx){
  return (node, p, c) => {
    checkBudget(ctx, true);
    return tryMove(node, p, c);
  };
}

// Есть ли у атакующего немедленное взятие точек группы (как если бы ходил он).
function hasThreat(node, ctx){
  const tryMove = budgetedMove(ctx);
  const n = Object.assign({}, node, { current: ctx.att });
  const base = lossOf(node, ctx.target, ctx.att);
  for (const c of ctx.region){
    const t = tryMove(n, ctx.att, c);
    if (t && lossOf(t.node, ctx.target, ctx.att) > base) return true;
  }
  return false;
}

// Лучшее немедленное взятие точек группы атакующим (как если бы ходил он).
function bestGain(node, ctx){
  const tryMove = budgetedMove(ctx);
  const n = Object.assign({}, node, { current: ctx.att });
  const base = lossOf(node, ctx.target, ctx.att);
  let g = 0;
  for (const c of ctx.region){
    const t = tryMove(n, ctx.att, c);
    if (!t) continue;
    const v = lossOf(t.node, ctx.target, ctx.att) - base;
    if (v > g) g = v;
  }
  return g;
}

// Выход: пустая клетка, соседняя (8 соседей) с ещё не пленённой точкой группы.
function isExit(node, ctx, c){
  const d = node.state.dead;
  for (const p of ctx.target){
    if (d[p.y][p.x]) continue;
    if (Math.abs(p.x - c.x) <= 1 && Math.abs(p.y - c.y) <= 1) return true;
  }
  return false;
}

// Ходы защитника (issue #60): ТОЛЬКО выходы и ходы, снимающие угрозу
// (после хода немедленное взятие точек группы атакующим строго меньше,
// чем без хода). Не больше ctx.maxCand. Возвращает [{x,y,t}].
function defMoves(node, ctx){
  const tryMove = budgetedMove(ctx);
  const g0 = bestGain(node, ctx), out = [];
  for (const c of ctx.region){
    if (out.length >= ctx.maxCand) break;
    const exit = isExit(node, ctx, c);
    if (!exit && g0 === 0) continue;
    const t = tryMove(node, ctx.def, c);
    if (!t) continue;
    if (!exit && !t.node.gameOver && t.node.current !== ctx.def && bestGain(t.node, ctx) >= g0) continue;
    out.push({ x: c.x, y: c.y, t, exit });
  }
  return out;
}

// Ограниченный поиск решателя. Возвращает потерю (атакующий max, защитник min).
function search(node, depth, alpha, beta, ctx){
  checkBudget(ctx, true);
  const tryMove = budgetedMove(ctx);
  ctx.nodes++;
  const base = lossOf(node, ctx.target, ctx.att);
  if (base >= ctx.target.length || depth <= 0 || node.gameOver) return base;
  if (ctx.nodes > ctx.nodeLimit || ((ctx.nodes & 127) === 0 && nowMs() > ctx.deadline)){ ctx.aborted = true; return base; }
  if (node.current === ctx.def){
    let best = Infinity, cnt = 0;
    for (const t of defMoves(node, ctx)){
      cnt++;
      const v = search(t.t.node, depth - 1, alpha, Math.min(beta, best), ctx);
      if (v < best) best = v;
      if (best <= alpha) break;
    }
    return cnt ? best : base;
  }
  let best = base;
  for (const c of ctx.region){
    const t = tryMove(node, ctx.att, c);
    if (!t) continue;
    if (lossOf(t.node, ctx.target, ctx.att) <= base){
      // тихий ход полезен, только если успеет: ответ защитника + взятие
      if (depth < 3 || t.node.gameOver || !hasThreat(t.node, ctx)) continue;
    }
    const v = search(t.node, depth - 1, Math.max(alpha, best), beta, ctx);
    if (v > best) best = v;
    if (best >= beta) break;
  }
  return best;
}

// Проверка: атакующий — любой легальный ход поля, защитник — регион.
function verify(node, depth, ctx){
  checkBudget(ctx, true);
  const tryMove = budgetedMove(ctx);
  ctx.vnodes++;
  const base = lossOf(node, ctx.target, ctx.att);
  if (base >= ctx.target.length || depth <= 0 || node.gameOver) return base;
  if (node.current === ctx.def){
    let best = Infinity, cnt = 0;
    for (const c of ctx.region){
      if (cnt >= ctx.maxCand) break;
      const t = tryMove(node, ctx.def, c);
      if (!t) continue;
      cnt++;
      const v = verify(t.node, depth - 1, ctx);
      if (v < best) best = v;
      if (best === base) break;
    }
    return cnt ? best : base;
  }
  let best = base;
  for (let y = 0; y < node.rows; y++) for (let x = 0; x < node.cols; x++){
    const t = tryMove(node, ctx.att, { x, y });
    if (!t) continue;
    const v = verify(t.node, depth - 1, ctx);
    if (v > best){ best = v; if (best >= ctx.target.length) return best; }
  }
  return best;
}

// Сеть за 2 хода: атакующий ходит дважды подряд в ближней части региона;
// возвращает прирост пленённых точек группы.
function netThreat(node, ctx){
  checkBudget(ctx, true);
  const tryMove = budgetedMove(ctx);
  const base = lossOf(node, ctx.target, ctx.att), cells = ctx.netCells;
  const n = Object.assign({}, node, { current: ctx.att });
  let best = 0;
  for (const c1 of cells){
    const t1 = tryMove(n, ctx.att, c1);
    if (!t1) continue;
    const g1 = lossOf(t1.node, ctx.target, ctx.att) - base;
    if (g1 > best) best = g1;
    if (t1.node.gameOver || best >= ctx.target.length - base) continue;
    const n2 = Object.assign({}, t1.node, { current: ctx.att });
    for (const c2 of cells){
      const t2 = tryMove(n2, ctx.att, c2);
      if (!t2) continue;
      const g = lossOf(t2.node, ctx.target, ctx.att) - base;
      if (g > best) best = g;
    }
  }
  return best;
}

// Проверка на вилку (структура forkLoss4, но по региону и только для группы):
// после хода защитника атакующий отвечает ходом региона, защитник защищается
// ходом региона, затем атакующий ходит дважды. Возвращает гарантированную потерю.
function forkCheck(node, ctx){
  checkBudget(ctx, true);
  const tryMove = budgetedMove(ctx);
  const base = lossOf(node, ctx.target, ctx.att);
  if (node.gameOver || node.current !== ctx.att) return 0;
  let worst = 0;
  for (const a of ctx.region){
    const t = tryMove(node, ctx.att, a);
    if (!t) continue;
    ctx.vnodes++;
    const imm = lossOf(t.node, ctx.target, ctx.att) - base;
    if (t.node.gameOver){ continue; }
    if (t.node.current === ctx.att){ worst = Math.max(worst, imm + netThreat(t.node, ctx)); continue; }
    if (imm + netThreat(t.node, ctx) <= worst) continue;
    let bestDef = Infinity, cnt = 0;
    for (const d of ctx.region){
      if (cnt >= ctx.maxCand || bestDef === 0) break;
      const u = tryMove(t.node, ctx.def, d);
      if (!u) continue;
      cnt++;
      ctx.vnodes++;
      const g = u.node.gameOver || u.node.current === ctx.def ? 0 : netThreat(u.node, ctx);
      if (g < bestDef) bestDef = g;
    }
    if (!Number.isFinite(bestDef)) bestDef = netThreat(t.node, ctx);
    worst = Math.max(worst, imm + bestDef);
    if (worst >= ctx.target.length - base) break;
  }
  return worst;
}

function solveGroup(node, def, target, opts){
  const t0 = nowMs();
  try {
    return solveGroupUnchecked(node, def, target, opts);
  } catch (err){
    if (err !== BUDGET_EXHAUSTED) throw err;
    // Unknown is neither a verified rescue nor a proven loss.
    return { saved: false, move: null, loss: null, incomplete: true,
      depth: 0, nodes: 0, verifyNodes: 0, ms: +(nowMs() - t0).toFixed(1) };
  }
}

function solveGroupUnchecked(node, def, target, opts){
  opts = opts || {};
  const t0 = nowMs();
  const ctx = {
    def, att: other(def), target,
    region: regionOf(node, target, opts.radius || 2, opts.maxCells || 20),
    maxCand: opts.maxCand || 10, nodeLimit: opts.nodeLimit || 200000,
    // opts.timeLimit (мс, S7 #61): жёсткий предел времени поиска; при срабатывании
    // итеративное углубление возвращает последнюю завершённую глубину.
    deadline: Number(opts.timeLimit) > 0 ? t0 + Number(opts.timeLimit) : Infinity,
    nodes: 0, vnodes: 0, aborted: false
  };
  const maxDepth = opts.maxDepth || 10, verifyDepth = opts.verifyDepth == null ? 1 : opts.verifyDepth;
  const base = lossOf(node, target, ctx.att);
  const threatened = hasThreat(node, ctx);
  // Корневые ходы защитника — тоже только выходы и снимающие угрозу.
  let roots = defMoves(node, ctx).map(m => ({ x: m.x, y: m.y, t: m.t, exit: m.exit, v: Infinity }));
  let depthDone = 0;
  for (let d = 2; d <= maxDepth; d += 2){
    ctx.aborted = false;
    const vals = [];
    let best = Infinity;
    for (const r of roots){
      const v = search(r.t.node, d - 1, -Infinity, best, ctx);
      vals.push(v);
      if (v < best) best = v;
      if (ctx.aborted) break;
    }
    if (ctx.aborted) break;
    roots.forEach((r, i) => { r.v = vals[i]; });
    roots.sort((a, b) => a.v - b.v);
    depthDone = d;
    if (best > base && best >= target.length) break; // потеря всей группы уже доказана
  }
  let res = null;
  for (const r of roots){
    if (r.v !== base) break;
    const vl = verify(r.t.node, verifyDepth, ctx);
    if (vl !== base) continue;
    if (!ctx.netCells) ctx.netCells = ctx.region.slice(0, opts.netCells || ctx.region.length);
    const fk = opts.forkCheck === false ? 0 : forkCheck(r.t.node, ctx);
    r.fork = fk;
    if (fk === 0){ res = { saved: true, move: { x: r.x, y: r.y }, loss: 0, verified: vl - base, fork: fk }; break; }
  }
  if (!res){
    // Все кандидаты с потерей base отвергнуты проверкой: потеря — лучшая по вилке.
    const forked = roots.filter(r => r.v === base && Number.isFinite(r.fork));
    if (forked.length){
      forked.sort((a, b) => a.fork - b.fork);
      const r = forked[0];
      return Object.assign({ saved: false, move: { x: r.x, y: r.y }, loss: r.fork }, { threatened, depth: depthDone,
        nodes: ctx.nodes, verifyNodes: ctx.vnodes, region: ctx.region.length, ms: +(nowMs() - t0).toFixed(1) });
    }
    const r = roots[0];
    res = r ? { saved: false, move: { x: r.x, y: r.y }, loss: (Number.isFinite(r.v) ? r.v : target.length) - base }
            : { saved: false, move: null, loss: target.length - base };
  }
  return Object.assign(res, { threatened, depth: depthDone, nodes: ctx.nodes, verifyNodes: ctx.vnodes,
    region: ctx.region.length, ms: +(nowMs() - t0).toFixed(1) });
}

// ---------- прогон по regression (#57) ----------
function matchAtPly(r, ply){
  const rules = r.rules || {};
  const m = E.createMatch({ sizeKey: r.board.sizeKey, firstPlayer: rules.firstPlayer, startPosition: rules.startPosition,
    targetScore: rules.targetScore, targetFillPercent: rules.targetFillPercent, extraTurnOnCapture: rules.extraTurnOnCapture });
  const moves = r.events.filter(e => e.type === 'move');
  for (let k = 0; k < ply; k++) m.applyMove(moves[k].player, moves[k].x, moves[k].y);
  return m;
}

function regressionCases(file){
  file = file || path.join(__dirname, 'corpus', 'prefork.regression.json');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return reg.positions.map(p => {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'corpus', 'human', p.file), 'utf8'));
    const g = Array.isArray(j) ? j[p.index] : j;
    const r = g.replay || g;
    const node = E.createSearchNode(matchAtPly(r, p.ply).getSnapshot());
    const after = E.createSearchNode(matchAtPly(r, p.captureAt + 1).getSnapshot());
    const att = other(p.botSeat), target = [];
    for (let y = 0; y < node.rows; y++) for (let x = 0; x < node.cols; x++)
      if (node.state.stone[y][x] === p.botSeat && !node.state.dead[y][x] && after.state.dead[y][x] === att) target.push({ x, y });
    return { pos: p, node, target };
  });
}

function runRegression(opts){
  const out = [];
  for (const c of regressionCases(opts.file)){
    const res = solveGroup(c.node, c.pos.botSeat, c.target, opts);
    const inRescue = !!res.move && c.pos.rescue.some(m => m.x === res.move.x && m.y === res.move.y);
    let fork = null;
    const F = E.twoMoveThreat && E.twoMoveThreat.forkLoss4;
    if (F && res.move){
      const t = E.applyTransition(c.node, c.pos.botSeat, res.move.x, res.move.y);
      if (t.ok && !t.node.gameOver && t.node.current !== c.pos.botSeat){
        const mine = t.result.gained.filter(q => q.kind === 'captured').length;
        const f = F(t.node, other(c.pos.botSeat), c.pos.botSeat, { calls: 0, cap: 1e6, thr: 4 });
        fork = f ? Math.max(0, f.loss - mine) : null;
      } else if (t.ok) fork = 0;
    }
    out.push({ id: c.pos.id, ply: c.pos.ply, targetSize: c.target.length, rescueExists: c.pos.rescue.length > 0,
      saved: res.saved, move: res.move, loss: res.loss, inRescueList: inRescue, forkLoss4OfMove: fork,
      minLoss: c.pos.minLoss, depth: res.depth, nodes: res.nodes, verifyNodes: res.verifyNodes, ms: res.ms, threatened: res.threatened });
  }
  return out;
}

module.exports = { solveGroup, groupAt, lossOf, regionOf, regressionCases, runRegression };

if (require.main === module){
  const a = process.argv.slice(2), opts = { maxDepth: 10 };
  let json = null;
  for (let i = 0; i < a.length; i++){
    if (a[i] === '--depth') opts.maxDepth = Number(a[++i]);
    else if (a[i] === '--json') json = a[++i];
    else if (a[i] === '--node-limit') opts.nodeLimit = Number(a[++i]);
    else if (a[i] === '--verify') opts.verifyDepth = Number(a[++i]);
  }
  const rows = runRegression(opts);
  for (const r of rows) console.log(JSON.stringify(r));
  if (json) fs.writeFileSync(json, JSON.stringify({ format: 'tochki-s6-solver-regression', opts, rows }, null, 1) + '\n');
}
