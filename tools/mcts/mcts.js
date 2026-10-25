// tools/mcts/mcts.js
//
// B06 (issue #29): изолированный прототип UCT-MCTS. ЭКСПЕРИМЕНТ.
// Не заменяет и не меняет основной поиск Engine.searchMove: использует
// только публичное API движка (createSearchNode, cloneSearchNode,
// applyTransitionInPlace, isTransitionLegal, generateCandidates), поэтому
// трактовка правил та же, что в реальной партии.
//
// Бюджет — узлы: одно применение хода к позиции (в дереве или в rollout) =
// один узел. Протокол — docs/B06_MCTS.md.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TochkiMCTS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MCTS_VERSION = 1;
  const DEFAULTS = { nodeLimit: 300, c: 1.4, rolloutDepth: 8, radius: 2, scoreScale: 3, seed: 29 };

  function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  // Легальные ходы узла: кандидаты рядом с точками (generateCandidates),
  // отфильтрованные по правилам; если их нет (дебют) — все легальные клетки.
  function legalMoves(Engine, node, radius) {
    const out = [];
    if (node.gameOver) return out;
    const seen = new Set();
    if (node.stonesPlacedTotal >= 2) {
      const cand = Engine.generateCandidates(node.state, node.rows, node.cols, radius) || [];
      for (const c of cand) {
        const k = c.y * node.cols + c.x;
        if (seen.has(k)) continue;
        seen.add(k);
        if (Engine.isTransitionLegal(node, c.x, c.y)) out.push({ x: c.x, y: c.y });
      }
    }
    if (!out.length) {
      for (let y = 0; y < node.rows; y++)
        for (let x = 0; x < node.cols; x++)
          if (Engine.isTransitionLegal(node, x, y)) out.push({ x, y });
    }
    return out;
  }

  // Оценка листа с точки зрения игрока 1: исход партии или tanh(разница/scale).
  function leafValue(st, scale) {
    if (st.gameOver) return st.winner === 1 ? 1 : (st.winner === 2 ? -1 : 0);
    return Math.tanh((st.scores[1] - st.scores[2]) / scale);
  }

  // snap — снимок матча (getSnapshot). Возвращает { move, trace }.
  function mctsSearch(Engine, snap, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const rootState = Engine.createSearchNode(snap);
    const rng = makeRng((o.seed ^ Math.imul(rootState.stonesPlacedTotal + 1, 2654435761)) >>> 0);
    // mover — игрок, сделавший ход В этот узел; value копится с его точки
    // зрения. Ходящий берётся из фактического current (доп. ход за захват).
    const root = { move: null, mover: 0, children: [], untried: legalMoves(Engine, rootState, o.radius), visits: 0, value: 0 };
    if (!root.untried.length) return { move: null, trace: { nodes: 0, completedDepth: 0, stopReason: 'no-move', treeSize: 1, iterations: 0 } };
    let nodes = 0, treeSize = 1, iterations = 0, maxDepth = 0;

    while (nodes < o.nodeLimit) {
      iterations++;
      const st = Engine.cloneSearchNode(rootState);
      let n = root;
      const path = [root];
      // Selection (UCB1).
      while (!n.untried.length && n.children.length && !st.gameOver) {
        const lnN = Math.log(n.visits);
        let best = null, bestU = -Infinity;
        for (const ch of n.children) {
          const u = ch.visits === 0 ? Infinity : ch.value / ch.visits + o.c * Math.sqrt(lnN / ch.visits);
          if (u > bestU) { bestU = u; best = ch; }
        }
        n = best;
        Engine.applyTransitionInPlace(st, st.current, n.move.x, n.move.y);
        nodes++;
        path.push(n);
      }
      // Expansion.
      if (!st.gameOver && n.untried.length) {
        const i = Math.floor(rng() * n.untried.length);
        const mv = n.untried[i];
        n.untried[i] = n.untried[n.untried.length - 1];
        n.untried.pop();
        const mover = st.current;
        Engine.applyTransitionInPlace(st, mover, mv.x, mv.y);
        nodes++;
        const child = { move: mv, mover, children: [], untried: legalMoves(Engine, st, o.radius), visits: 0, value: 0 };
        n.children.push(child);
        n = child;
        path.push(child);
        treeSize++;
      }
      if (path.length - 1 > maxDepth) maxDepth = path.length - 1;
      // Rollout: случайные легальные ходы, ограниченная глубина.
      for (let d = 0; d < o.rolloutDepth && !st.gameOver && nodes < o.nodeLimit; d++) {
        const ms = legalMoves(Engine, st, o.radius);
        if (!ms.length) break;
        const mv = ms[Math.floor(rng() * ms.length)];
        Engine.applyTransitionInPlace(st, st.current, mv.x, mv.y);
        nodes++;
      }
      // Backpropagation.
      const v1 = leafValue(st, o.scoreScale);
      for (const p of path) {
        p.visits++;
        if (p.mover) p.value += p.mover === 1 ? v1 : -v1;
      }
    }

    let best = null;
    for (const ch of root.children) if (!best || ch.visits > best.visits) best = ch;
    const move = best ? best.move : root.untried[0];
    return { move: { x: move.x, y: move.y }, trace: { nodes, completedDepth: maxDepth, stopReason: 'nodes', treeSize, iterations } };
  }

  // Контракт runner A07: chooseMove(snapshot) -> { move, trace }.
  function makeMctsPlayer(Engine, options) {
    return function chooseMove(snap) { return mctsSearch(Engine, snap, options); };
  }

  return { MCTS_VERSION, DEFAULTS, legalMoves, mctsSearch, makeMctsPlayer };
});
