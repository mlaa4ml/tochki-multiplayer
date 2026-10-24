// offline/localSession.js — LocalSession: единственный владелец offline-матча
// (A05/A06, issues #10/#11; docs/OFFLINE_PLAN.md, O1–O3).
//
// Работает и в браузере (обычный <script> после gameEngine.js — создаёт
// глобальный TochkiLocalSession), и в Node (require). Сеть не используется:
// нет WebSocket, fetch, API, SQLite.
//
// Модель:
//   - матч создаётся только здесь через Engine.createMatch; UI получает
//     snapshot и статус через subscribe и сам правила не вычисляет;
//   - у каждого места свой контроллер: {type:'human'} | {type:'normal'|'strong',
//     weights?}; первый игрок — отдельная настройка правил (firstPlayer);
//   - ход бота считает Worker (botWorker.js). Запрос несёт
//     {gameId, revision, requestId}; ответ применяется, только если все три
//     совпадают с текущим ожидающим запросом, и только через match.applyMove;
//   - restart (newGame), undo, end, pause, смена контроллеров и dispose
//     отменяют поиск через worker.terminate() и увеличивают revision —
//     запоздавший ответ старого Worker'а отбрасывается;
//   - следующий игрок всегда берётся из snapshot.current (повторный ход при
//     захвате учитывается движком), перед планированием проверяется gameOver;
//   - отказ/недоступность Worker'а переводит сессию в явное состояние
//     workerError; синхронного fallback-поиска в основном потоке НЕТ.
(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../gameEngine.js'), require('../replay.js'));
  else root.TochkiLocalSession = factory(root.TochkiEngine, root.TochkiReplay);
})(typeof self !== 'undefined' ? self : this, function(DefaultEngine, Replay){
  'use strict';

  const BOT_TYPES = { normal: true, strong: true };

  function normController(c){
    if (typeof c === 'string') c = { type: c };
    c = c || {};
    if (BOT_TYPES[c.type]) return { type: c.type, weights: c.weights ? JSON.parse(JSON.stringify(c.weights)) : null };
    return { type: 'human' };
  }

  function isBot(c){ return !!c && c.type !== 'human'; }

  function defaultWorkerFactory(){
    if (typeof Worker !== 'function') throw new Error('Web Worker недоступен в этом окружении');
    const url = (typeof self !== 'undefined' && self.TOCHKI_BOT_WORKER_URL) || '../botWorker.js';
    return new Worker(url);
  }

  function createLocalSession(sessionOptions){
    sessionOptions = sessionOptions || {};
    const E = sessionOptions.engine || DefaultEngine;
    if (!E || typeof E.createMatch !== 'function') throw new Error('gameEngine.js не загружен');
    const createWorker = sessionOptions.createWorker || defaultWorkerFactory;
    const setT = sessionOptions.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearT = sessionOptions.clearTimeout || (id => clearTimeout(id));
    const searchOpts = Object.assign({ normal: {}, strong: {} }, sessionOptions.searchOpts || {});

    let match = null;
    let gameSeq = 0;
    let gameId = null;
    let revision = 0;
    let requestSeq = 0;
    let controllers = { 1: { type: 'human' }, 2: { type: 'normal' } };
    let running = false;      // автоматическое планирование ходов ботов
    let delayMs = Math.max(0, Number(sessionOptions.delayMs) || 0);
    let worker = null;
    let pending = null;       // {requestId, gameId, revision, player, mode}
    let timer = null;
    let workerError = null;
    let lastTrace = null;
    let lastError = null;
    let staleDropped = 0;
    let disposed = false;
    const listeners = new Set();

    function hasHuman(){ return !isBot(controllers[1]) || !isBot(controllers[2]); }

    function status(){
      const s = match ? match.getSnapshot() : null;
      return {
        gameId, revision,
        controllers: { 1: Object.assign({}, controllers[1]), 2: Object.assign({}, controllers[2]) },
        mode: hasHuman() ? (isBot(controllers[1]) || isBot(controllers[2]) ? 'human-bot' : 'human-human') : 'bot-bot',
        running, searching: !!pending, searchingFor: pending ? pending.player : null,
        delayMs, workerError, lastError, lastTrace, staleDropped,
        moveCount: match ? match.getMoveLog().length : 0,
        humanTurn: !!(s && !s.gameOver && !isBot(controllers[s.current])),
        disposed
      };
    }

    function emit(){
      if (disposed || !match) return;
      const snap = match.getSnapshot();
      const st = status();
      for (const l of Array.from(listeners)){
        try { l(snap, st); } catch (e) { /* ошибка слушателя не ломает сессию */ }
      }
    }

    function clearTimer(){ if (timer !== null){ clearT(timer); timer = null; } }

    // Отмена текущего поиска: синхронный поиск в Worker'е прервать можно
    // только terminate(); ссылка сбрасывается, поэтому все сообщения от
    // старого Worker'а будут проигнорированы.
    function cancelSearch(){
      clearTimer();
      if (worker){
        try { worker.terminate(); } catch (_) {}
        worker = null;
      }
      pending = null;
    }

    function invalidate(){ cancelSearch(); revision++; }

    function setWorkerError(msg){
      cancelSearch();
      workerError = String(msg || 'ошибка Worker');
      running = false;
      revision++;
      emit();
    }

    function ensureWorker(){
      if (worker) return worker;
      const w = createWorker();
      if (!w || typeof w.postMessage !== 'function') throw new Error('Worker не создан');
      w.onmessage = e => onWorkerMessage(w, e && e.data);
      w.onerror = e => {
        if (w !== worker) return;
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        setWorkerError('Worker упал: ' + ((e && e.message) || 'неизвестная ошибка'));
      };
      worker = w;
      return w;
    }

    function requestBot(mode){
      if (disposed || !match || pending || workerError) return false;
      const snap = match.getSnapshot();
      if (snap.gameOver) return false;
      const ctrl = controllers[snap.current];
      if (!isBot(ctrl)) return false;
      let w;
      try { w = ensureWorker(); }
      catch (err){ setWorkerError(err && err.message || err); return false; }
      const req = { requestId: ++requestSeq, gameId, revision, player: snap.current, mode };
      pending = req;
      try {
        w.postMessage({
          type: 'search', requestId: req.requestId, gameId: req.gameId, revision: req.revision,
          snapshot: snap, difficulty: ctrl.type, weights: ctrl.weights || null,
          searchOpts: searchOpts[ctrl.type] || {}
        });
      } catch (err){ setWorkerError(err && err.message || err); return false; }
      emit();
      return true;
    }

    function onWorkerMessage(w, msg){
      if (disposed) return;
      const p = pending;
      if (w !== worker || !p || !msg || msg.requestId !== p.requestId || msg.gameId !== p.gameId ||
          msg.revision !== p.revision || p.revision !== revision || p.gameId !== gameId){
        staleDropped++;
        return;
      }
      pending = null;
      if (msg.type === 'error'){ setWorkerError('Worker вернул ошибку: ' + msg.error); return; }
      if (msg.type !== 'result'){ setWorkerError('неизвестный ответ Worker: ' + msg.type); return; }
      lastTrace = msg.trace || null;
      if (!msg.move){
        if (match.getSnapshot().gameOver){ emit(); return; }
        setWorkerError('бот не вернул ход в неоконченной партии');
        return;
      }
      const t = msg.trace || {};
      const decision = { controller: controllers[p.player].type, nodes: t.nodes ?? null,
        completedDepth: t.completedDepth ?? null, stopReason: t.stopReason ?? null };
      const res = match.applyMove(p.player, msg.move.x, msg.move.y, decision);
      if (!res.ok){ setWorkerError('бот предложил недопустимый ход (' + res.reason + ')'); return; }
      revision++;
      emit();
      if (p.mode === 'auto') schedule();
    }

    function schedule(){
      clearTimer();
      if (disposed || !match || !running || pending || workerError) return;
      const snap = match.getSnapshot();
      if (snap.gameOver || !isBot(controllers[snap.current])) return;
      const rev = revision;
      const delay = hasHuman() ? 0 : delayMs;
      timer = setT(() => {
        timer = null;
        if (rev !== revision || !running) return;
        requestBot('auto');
      }, delay);
    }

    function newGame(options){
      if (disposed) throw new Error('session disposed');
      options = options || {};
      invalidate();
      workerError = null;
      lastTrace = null;
      lastError = null;
      if (options.controllers){
        controllers = { 1: normController(options.controllers[1]), 2: normController(options.controllers[2]) };
      }
      if (options.delayMs !== undefined) delayMs = Math.max(0, Number(options.delayMs) || 0);
      match = E.createMatch({
        sizeKey: options.sizeKey,
        firstPlayer: options.firstPlayer === 2 ? 2 : 1,
        extraTurnOnCapture: options.extraTurnOnCapture === true,
        undoAllowed: options.undoAllowed !== false,
        targetScore: options.targetScore,
        targetFillPercent: options.targetFillPercent
      });
      gameId = 'local-' + (++gameSeq);
      // Человек–бот: бот отвечает сам. Бот–бот: запускается кнопкой/start().
      running = hasHuman() ? true : options.autoStart === true;
      emit();
      schedule();
      return match.getSnapshot();
    }

        // Validate and reconstruct in isolation before cancelling the live match.
    // Imported games are paused, with human seats, so playback never starts a bot.
    function importReplay(input, eventCount){
      if (disposed) throw new Error('session disposed');
      let replacement = Replay.play(input);
      const replay = replacement.getReplay();
      if (eventCount !== undefined){
        if (!Number.isInteger(eventCount) || eventCount < 0 || eventCount > replay.events.length)
          throw new Error('Replay: invalid playback position');
        const prefix = JSON.parse(JSON.stringify(replay));
        prefix.events = prefix.events.slice(0, eventCount);
        // A terminal move and its mandatory rule-end event form one position.
        const next = replay.events[eventCount];
        if (next && next.type === 'end' && next.reason === 'rule') prefix.events.push(next);
        replacement = Replay.play(prefix);
      }
      invalidate();
      match = replacement;
      gameId = 'local-' + (++gameSeq);
      controllers = { 1: { type: 'human' }, 2: { type: 'human' } };
      running = false;
      workerError = lastError = lastTrace = null;
      emit();
      return match.getSnapshot();
    }

    function move(x, y){
      if (disposed || !match) return { ok: false, reason: 'no-game' };
      const snap = match.getSnapshot();
      if (snap.gameOver) return { ok: false, reason: 'game-over' };
      if (isBot(controllers[snap.current])) return { ok: false, reason: 'not-human-turn' };
      const res = match.applyMove(snap.current, x, y);
      if (!res.ok){ lastError = res.reason; emit(); return res; }
      lastError = null;
      revision++;
      emit();
      schedule();
      return res;
    }

    function undo(){
      if (disposed || !match) return { ok: false, reason: 'no-game' };
      if (!match.canUndoLastMove()){
        const s = match.getSnapshot();
        return { ok: false, reason: !s.rules.undoAllowed ? 'undo-disabled' : s.gameOver ? 'game-over' : 'nothing-to-undo' };
      }
      invalidate();
      let res = match.undoLastMove();
      // Человек–бот: откатываем до хода человека (ход бота + ход человека).
      if (hasHuman()){
        while (isBot(controllers[match.getSnapshot().current]) && match.canUndoLastMove()){
          res = match.undoLastMove();
        }
      } else {
        running = false; // бот–бот: после отмены — пауза
      }
      revision++;
      emit();
      schedule();
      return res;
    }

    function end(){
      if (disposed || !match) return { ok: false, reason: 'no-game' };
      invalidate();
      running = false;
      const res = match.endNow('manual');
      emit();
      return res;
    }

    function start(){
      if (disposed || !match) return false;
      if (workerError){ workerError = null; }
      running = true;
      emit();
      schedule();
      return true;
    }

    function pause(){
      if (disposed || !match) return false;
      running = false;
      invalidate();
      emit();
      return true;
    }

    // Ровно один ход бота текущего игрока (из snapshot.current). Не запускает
    // серию: после применения ответа ничего больше не планируется.
    function step(){
      if (disposed || !match) return false;
      if (pending) return false;
      running = false;
      clearTimer();
      if (workerError) workerError = null;
      return requestBot('step');
    }

    function setControllers(c){
      if (disposed) return;
      invalidate();
      controllers = { 1: normController(c && c[1]), 2: normController(c && c[2]) };
      if (!hasHuman()) running = false; else running = true;
      emit();
      schedule();
    }

    function setDelay(ms){ delayMs = Math.max(0, Number(ms) || 0); emit(); }

    function snapshot(){ return match ? match.getSnapshot() : null; }

    function subscribe(listener){
      if (typeof listener !== 'function') throw new Error('listener must be a function');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }

    function dispose(){
      if (disposed) return;
      invalidate();
      running = false;
      disposed = true;
      listeners.clear();
    }

    return {
            newGame, importReplay, move, snapshot, undo, end, subscribe, dispose,
      exportReplay: () => match ? Replay.stringify(match) : null,
      start, pause, step, setControllers, setDelay, status,
      getReplay: () => match ? match.getReplay() : null
    };
  }

  return { createLocalSession, normController };
});
