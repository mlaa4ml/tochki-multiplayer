// replay.js
//
// Общий модуль для работы с версионированными реплеями игры «Точки» (v1).
// Не зависит от SQLite или серверной инфраструктуры (работает как в Node, так и в браузере).
// Реализует:
// 1. Создание реплея из завершённой партии / матча (export).
// 2. Чистый валидатор и проигрыватель матчей (import / replay without SQLite).
// 3. Строгую проверку формата v1, размеров, правил, легальности всех событий (move, undo, end).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TochkiReplay = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CURRENT_VERSION = 'tochki-replay-1';
  const MAX_REPLAY_BYTES = 512 * 1024; // 512 KB limit per replay
  const MAX_EVENTS = 10000;

  // Валидация заголовка и структуры реплея
  function validateReplayHeader(raw){
    if (!raw || typeof raw !== 'object') {
      return { ok: false, reason: 'invalid-json-object' };
    }
    if (raw.version !== CURRENT_VERSION) {
      return { ok: false, reason: `unsupported-version:${raw.version}` };
    }
    if (!raw.rules || typeof raw.rules !== 'object') {
      return { ok: false, reason: 'missing-rules' };
    }
    const { sizeKey, firstPlayer, extraTurnOnCapture, undoAllowed, targetScore, targetFillPercent } = raw.rules;
    if (!sizeKey || typeof sizeKey !== 'string') {
      return { ok: false, reason: 'invalid-size-key' };
    }
    if (firstPlayer !== 1 && firstPlayer !== 2) {
      return { ok: false, reason: 'invalid-first-player' };
    }
    if (typeof extraTurnOnCapture !== 'boolean') {
      return { ok: false, reason: 'invalid-extra-turn-flag' };
    }
    if (typeof undoAllowed !== 'boolean') {
      return { ok: false, reason: 'invalid-undo-allowed-flag' };
    }
    if (!Number.isInteger(targetScore) || targetScore < 0 || targetScore > 9999) {
      return { ok: false, reason: 'invalid-target-score' };
    }
    if (!Number.isInteger(targetFillPercent) || targetFillPercent < 0 || targetFillPercent > 100) {
      return { ok: false, reason: 'invalid-target-fill' };
    }
    if (!Array.isArray(raw.events)) {
      return { ok: false, reason: 'missing-events-array' };
    }
    if (raw.events.length > MAX_EVENTS) {
      return { ok: false, reason: 'too-many-events' };
    }
    return { ok: true };
  }

  // Проигрывание реплея на чистом движке (без внешних зависимостей)
  // Принимает JSON-объект реплея или JSON-строку.
  function playReplay(replayInput, Engine){
    let raw = replayInput;
    if (typeof raw === 'string') {
      if (raw.length > MAX_REPLAY_BYTES) {
        return { ok: false, reason: 'replay-size-exceeds-limit' };
      }
      try {
        raw = JSON.parse(raw);
      } catch (err) {
        return { ok: false, reason: 'json-parse-error' };
      }
    }

    const headerCheck = validateReplayHeader(raw);
    if (!headerCheck.ok) {
      return headerCheck;
    }

    const rules = raw.rules;
    const options = {
      sizeKey: rules.sizeKey,
      firstPlayer: rules.firstPlayer,
      extraTurnOnCapture: rules.extraTurnOnCapture,
      undoAllowed: rules.undoAllowed,
      targetScore: rules.targetScore,
      targetFillPercent: rules.targetFillPercent
    };

    let match;
    try {
      match = Engine.createMatch(options);
    } catch (err) {
      return { ok: false, reason: `match-creation-error:${err.message}` };
    }

    const events = raw.events;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || typeof ev !== 'object') {
        return { ok: false, reason: `invalid-event-at-index:${i}` };
      }

      if (ev.type === 'move') {
        if (ev.seat !== 1 && ev.seat !== 2) {
          return { ok: false, reason: `invalid-move-seat-at-index:${i}` };
        }
        if (!Number.isInteger(ev.x) || !Number.isInteger(ev.y)) {
          return { ok: false, reason: `invalid-move-coords-at-index:${i}` };
        }
        const res = match.applyMove(ev.seat, ev.x, ev.y);
        if (!res.ok) {
          return { ok: false, reason: `illegal-move-at-index:${i}:${res.reason}` };
        }
      } else if (ev.type === 'undo') {
        if (!rules.undoAllowed) {
          return { ok: false, reason: `undo-not-allowed-by-rules-at-index:${i}` };
        }
        if (ev.seat !== 1 && ev.seat !== 2) {
          return { ok: false, reason: `invalid-undo-seat-at-index:${i}` };
        }
        const res = match.requestUndo(ev.seat);
        if (!res.ok) {
          return { ok: false, reason: `illegal-undo-request-at-index:${i}:${res.reason}` };
        }
        const appRes = match.approveUndo(ev.seat === 1 ? 2 : 1);
        if (!appRes.ok) {
          return { ok: false, reason: `illegal-undo-approval-at-index:${i}:${appRes.reason}` };
        }
      } else if (ev.type === 'end') {
        match.endNow();
      } else {
        return { ok: false, reason: `unknown-event-type-at-index:${i}:${ev.type}` };
      }
    }

    const snap = match.getSnapshot();
    let endReason = snap.endReason;
    if (!endReason && snap.gameOver) {
      endReason = 'manual';
    }
    return {
      ok: true,
      snapshot: snap,
      matchMeta: {
        winner: snap.winner,
        scores: snap.scores,
        gameOver: snap.gameOver,
        endReason: endReason,
        totalEvents: events.length
      }
    };
  }

  // Создание структуры реплея v1 из завершенного матча / метаданных сервера
  function exportReplay(match, metadata){
    metadata = metadata || {};
    const snap = match.getSnapshot();
    const rules = snap.rules || {};
    
    const events = [];
    // Если у матча есть лог ходов и событий отмены
    const detailedLog = match.getDetailedLog ? match.getDetailedLog() : (match.getMoveLog ? match.getMoveLog() : []);
    
    for (const item of detailedLog) {
      if (item.type === 'move') {
        events.push({ type: 'move', seat: item.seat, x: item.x, y: item.y });
      } else if (item.type === 'undo') {
        events.push({ type: 'undo', seat: item.seat });
      } else if (item.type === 'end') {
        events.push({ type: 'end' });
      } else if (typeof item.x === 'number' && typeof item.y === 'number' && typeof item.p === 'number') {
        events.push({ type: 'move', seat: item.p, x: item.x, y: item.y });
      }
    }

    if (snap.gameOver) {
      events.push({ type: 'end' });
    }

    return {
      version: CURRENT_VERSION,
      createdAt: Date.now(),
      engineVersion: metadata.engineVersion || '0.1.0',
      botVersion: metadata.botVersion || null,
      botWeights: metadata.botWeights || null,
      seed: metadata.seed || null,
      rules: {
        sizeKey: rules.sizeKey || 'medium',
        firstPlayer: rules.firstPlayer || 1,
        extraTurnOnCapture: rules.extraTurnOnCapture === true,
        undoAllowed: rules.undoAllowed !== false,
        targetScore: rules.targetScore || 0,
        targetFillPercent: rules.targetFillPercent || 100
      },
      players: {
        player1: metadata.player1 || { name: 'Player 1', isBot: false },
        player2: metadata.player2 || { name: 'Player 2', isBot: false }
      },
      events
    };
  }

  return {
    CURRENT_VERSION,
    validateReplayHeader,
    playReplay,
    exportReplay
  };
});
