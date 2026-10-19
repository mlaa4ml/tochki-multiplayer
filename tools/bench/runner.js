// tools/bench/runner.js
//
// Чистый headless runner партий бот-против-бота (A07, issue #12).
// Контракт: createMatch -> getSnapshot -> chooseMove -> applyMove -> JSONL.
// НЕ импортирует БД (db.js/gamelog.js) и НИЧЕГО не публикует: веса
// передаются явно, результат — только массив JSONL-записей.
// Работает и в браузере, и в Node: фабрика получает движок аргументом.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TochkiBenchRunner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RUNNER_VERSION = 1;

  class InvalidMoveError extends Error {
    constructor(message, details) {
      super(message);
      this.name = 'InvalidMoveError';
      this.details = details;
    }
  }

  // Стандартный выбор хода: Engine.searchMove с детерминированным лимитом
  // узлов (таймер выключен, кроме необязательного аварийного).
  function makeSearchPlayer(Engine, cfg) {
    const diff = typeof cfg.difficulty === 'string' ? Engine.DIFFICULTY[cfg.difficulty] : cfg.difficulty;
    if (!diff) throw new Error('unknown difficulty: ' + cfg.difficulty);
    return function chooseMove(snap) {
      const state = { stone: snap.stone, dead: snap.dead, territory: snap.territory };
      const opts = Object.assign({}, snap);
      if (cfg.nodeLimit > 0) opts.nodeLimit = cfg.nodeLimit;
      if (cfg.emergencyMs > 0) opts.emergencyTimeLimit = cfg.emergencyMs;
      const r = Engine.searchMove(state, snap.rows, snap.cols, snap.current, diff, cfg.weights || Engine.BOT_WEIGHTS, opts);
      return { move: r.move, trace: r.trace };
    };
  }

  // Строгое применение префикса дебюта: любой нелегальный ход — ошибка.
  function applyPrefix(match, prefix, emit) {
    for (let i = 0; i < prefix.length; i++) {
      const mv = prefix[i];
      const res = match.applyMove(mv.seat, mv.x, mv.y);
      if (!res.ok) {
        throw new InvalidMoveError('invalid opening prefix move #' + i + ': ' + res.reason,
          { index: i, move: mv, reason: res.reason });
      }
      emit({ type: 'prefix', i, seat: mv.seat, x: mv.x, y: mv.y });
      if (res.gameOver) throw new InvalidMoveError('opening prefix ends the game at move #' + i, { index: i });
    }
  }

  // Одна партия. opts:
  //  rules: параметры createMatch (sizeKey, targetScore, targetFillPercent, ...)
  //  players: {1: chooseMove, 2: chooseMove}; chooseMove(snap) -> {move, trace}
  //  prefix: [{x,y,seat}] — дебют; maxMoves; maxMs (лимит времени партии); meta
  // Возвращает { result, lines } — lines это JSONL-строки (header, ходы, result).
  // Невалидный ход бота -> InvalidMoveError (не ничья).
  function playGame(Engine, opts) {
    const lines = [];
    const emit = (rec) => lines.push(JSON.stringify(rec));
    const now = opts.clock || (() => Date.now());
    const maxMoves = opts.maxMoves > 0 ? opts.maxMoves : 1000;
    const maxMs = opts.maxMs > 0 ? opts.maxMs : Infinity;
    const match = Engine.createMatch(Object.assign({}, opts.rules));
    emit({ type: 'header', runnerVersion: RUNNER_VERSION, engineVersion: Engine.ENGINE_VERSION,
      botVersion: Engine.BOT_VERSION, weightsVersion: Engine.WEIGHTS_VERSION,
            rules: Object.assign({ sizeKey: match.getSnapshot().sizeKey }, match.getSnapshot().rules),
      meta: opts.meta || null });
    applyPrefix(match, opts.prefix || [], emit);

    const stats = { 1: { nodes: 0, depthSum: 0, moves: 0, times: [] }, 2: { nodes: 0, depthSum: 0, moves: 0, times: [] } };
    const start = now();
    let moves = 0, end = null;
    for (;;) {
      const snap = match.getSnapshot();
      if (snap.gameOver) { end = 'finished'; break; }
      if (moves >= maxMoves) { end = 'truncated-moves'; break; }
      if (now() - start > maxMs) { end = 'truncated-time'; break; }
      const seat = snap.current;
      const t0 = now();
      const out = opts.players[seat](snap);
      const dt = now() - t0;
      const move = out && out.move;
      if (!move) { end = 'no-move'; break; }
      const res = match.applyMove(seat, move.x, move.y);
      if (!res.ok) {
        throw new InvalidMoveError('invalid bot move: ' + res.reason, { seat, move, reason: res.reason, ply: moves });
      }
      const tr = (out && out.trace) || {};
      const st = stats[seat];
      st.nodes += tr.nodes || 0; st.depthSum += tr.completedDepth || 0; st.moves++; st.times.push(dt);
      emit({ type: 'move', ply: moves, seat, x: move.x, y: move.y, ms: dt,
        nodes: tr.nodes ?? null, depth: tr.completedDepth ?? null, stop: tr.stopReason ?? null });
      moves++;
      if (res.gameOver) { end = 'finished'; break; }
    }
    const fin = match.getSnapshot();
    const s1 = fin.scores[1], s2 = fin.scores[2];
    const winner = s1 > s2 ? 1 : (s2 > s1 ? 2 : 0);
    const result = { end, truncated: end === 'truncated-moves' || end === 'truncated-time',
      winner, scores: { 1: s1, 2: s2 }, moves, stats };
    emit({ type: 'result', end, truncated: result.truncated, winner, scores: result.scores, moves });
    return { result, lines };
  }

  // Повтор JSONL: заново проигрывает ходы и проверяет совпадение результата.
  function replayLines(Engine, lines) {
    const recs = lines.map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
    const header = recs.find((r) => r.type === 'header');
    if (!header) throw new Error('no header');
    const r = header.rules;
    const match = Engine.createMatch({ sizeKey: header.rules.sizeKey || (header.meta && header.meta.sizeKey),
      targetScore: r.targetScore, targetFillPercent: r.targetFillPercent, firstPlayer: r.firstPlayer,
      extraTurnOnCapture: r.extraTurnOnCapture, undoAllowed: r.undoAllowed });
    for (const rec of recs) {
      if (rec.type !== 'prefix' && rec.type !== 'move') continue;
      const res = match.applyMove(rec.seat, rec.x, rec.y);
      if (!res.ok) throw new InvalidMoveError('replay: invalid move', { rec, reason: res.reason });
    }
    const fin = match.getSnapshot();
    const resRec = recs.find((x) => x.type === 'result');
    const ok = !resRec || (resRec.scores[1] === fin.scores[1] && resRec.scores[2] === fin.scores[2]);
    return { ok, scores: { 1: fin.scores[1], 2: fin.scores[2] } };
  }

  return { RUNNER_VERSION, InvalidMoveError, makeSearchPlayer, applyPrefix, playGame, replayLines };
});
