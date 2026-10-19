// botWorker.js — точка входа Worker для расчёта хода бота с диагностикой
// поиска (A04, issue #9; подготовка к A06 / OFFLINE_PLAN).
//
// Один и тот же файл работает как:
//   - Web Worker в браузере: new Worker('botWorker.js') — движок
//     подгружается через importScripts('gameEngine.js');
//   - Node worker_threads: new Worker(require.resolve('./botWorker.js'));
//   - обычный модуль: require('./botWorker.js').handleBotRequest(Engine, msg)
//     (синхронно, для тестов и CLI).
//
// Протокол.
//   Запрос:  { type:'search', requestId, gameId, revision,
//              snapshot,            // match.getSnapshot()
//              difficulty,          // 'normal' | 'strong' | ...
//              weights,             // необязательно, иначе BOT_WEIGHTS
//              searchOpts }         // { nodeLimit, timeLimit, emergencyTimeLimit }
//   Ответ:   { type:'result', requestId, gameId, revision, move, trace }
//            move — {x,y} или null (gameOver / нет легальных ходов);
//            trace — диагностика searchMove (move, candidates, nodes,
//            completedDepth, stopReason, stopAt, elapsedMs, params).
//   Ошибка:  { type:'error', requestId, gameId, revision, error }
// requestId/gameId/revision возвращаются как есть: владелец партии сам
// отбрасывает устаревшие ответы и проверяет ход через applyMove — Worker не
// владеет состоянием партии. Отмена — worker.terminate().
(function(){
  'use strict';

  const isNode = typeof module === 'object' && module.exports;

  function loadEngine(){
    if (isNode) return require('./gameEngine.js');
    if (typeof self !== 'undefined'){
      if (!self.TochkiEngine && typeof importScripts === 'function') importScripts('gameEngine.js');
      return self.TochkiEngine;
    }
    throw new Error('gameEngine.js is not available');
  }

  function num(v){ const n = Number(v); return Number.isFinite(n) ? n : undefined; }

  function handleBotRequest(E, msg){
    msg = msg || {};
    const base = { requestId: msg.requestId ?? null, gameId: msg.gameId ?? null, revision: msg.revision ?? null };
    try {
      if (msg.type !== undefined && msg.type !== 'search') throw new Error('unknown request type: ' + msg.type);
      const s = msg.snapshot;
      if (!s || !Array.isArray(s.stone) || !Array.isArray(s.dead) || !Array.isArray(s.territory))
        throw new Error('snapshot with stone/dead/territory is required');
      const diff = E.DIFFICULTY[msg.difficulty] || E.DIFFICULTY.normal;
      const so = msg.searchOpts || {};
      const opts = { stonesPlacedTotal: s.stonesPlacedTotal, gameOver: s.gameOver, rules: s.rules };
      if (num(so.nodeLimit) > 0) opts.nodeLimit = num(so.nodeLimit);
      if (num(so.timeLimit) !== undefined) opts.timeLimit = num(so.timeLimit);
      if (num(so.emergencyTimeLimit) > 0) opts.emergencyTimeLimit = num(so.emergencyTimeLimit);
      const r = E.searchMove({ stone: s.stone, dead: s.dead, territory: s.territory },
        s.rows, s.cols, s.current, diff, msg.weights || null, opts);
      return Object.assign({ type: 'result' }, base, { move: r.move, trace: r.trace });
    } catch (err){
      return Object.assign({ type: 'error' }, base, { error: String(err && err.message || err) });
    }
  }

  if (isNode){
    module.exports = { handleBotRequest };
    let wt = null;
    try { wt = require('worker_threads'); } catch (_) { wt = null; }
    if (wt && !wt.isMainThread && wt.parentPort){
      const E = loadEngine();
      wt.parentPort.on('message', m => wt.parentPort.postMessage(handleBotRequest(E, m)));
    }
  } else if (typeof self !== 'undefined' && typeof self.postMessage === 'function'){
    const E = loadEngine();
    self.onmessage = e => self.postMessage(handleBotRequest(E, e.data));
  }
})();
