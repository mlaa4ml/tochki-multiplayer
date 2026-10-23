// botPool.js — ограниченный пул worker_threads для серверного поиска хода
// бота (A10, issue #15).
//
// Зачем: match.botMove() синхронный, strong может считать ~2000 мс и до
// этого момента блокирует общий event loop сервера (все комнаты, HTTP, WS).
// Пул выносит поиск в отдельные потоки, используя ту же точку входа
// botWorker.js и тот же gameEngine.js (searchMove) — копии правил нет.
//
// Гарантии пула:
//   - не больше `size` потоков одновременно (по умолчанию 2), потоки
//     создаются лениво и переиспользуются; worker на запрос НЕ создаётся;
//   - очередь ожидания ограничена `maxQueue`; при переполнении запрос сразу
//     отклоняется с code='queue-full' (backpressure — решение за вызывающим);
//   - у каждого запроса есть жёсткий таймаут `timeoutMs` (от начала расчёта
//     в потоке); по таймауту поток завершается terminate() и при следующем
//     запросе создаётся новый — зависший поиск не держит слот вечно;
//   - падение потока (error/exit) отклоняет только его текущий запрос
//     (code='worker-crashed'); пул продолжает работать;
//   - cancel(key) снимает запрос из очереди или прерывает расчёт (terminate),
//     если он уже идёт — CPU сразу освобождается;
//   - close() отклоняет всё (code='pool-closed') и дожидается завершения
//     всех потоков; простаивающие потоки unref() и не держат процесс.
//
// Пул НЕ владеет партией: он лишь возвращает { move, trace }. Проверка
// актуальности (room/game/revision) и applyMove — на стороне сервера.
'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

function poolError(code, message){
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function createBotPool(options = {}){
  const size = Math.max(1, Number(options.size) | 0 || 2);
  const maxQueue = Number.isFinite(Number(options.maxQueue)) ? Math.max(0, Number(options.maxQueue) | 0) : 16;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10000;
  const workerPath = options.workerPath || path.join(__dirname, 'botWorker.js');

  const all = new Set();     // все живые потоки
  const idle = [];           // свободные потоки
  const busy = new Map();    // worker -> task
    const queue = [];          // ожидающие задачи
  const terminating = new Set(); // промисы terminate() ещё не завершённых потоков
  let closed = false;
  let seq = 0;

  const counters = {
    submitted: 0, completed: 0, searchErrors: 0, timeouts: 0, crashes: 0,
    rejectedQueueFull: 0, cancelled: 0, spawned: 0, maxQueueSeen: 0, maxBusySeen: 0
  };

  function spawn(){
    const w = new Worker(workerPath, options.workerOptions);
    counters.spawned += 1;
    all.add(w);
    w.on('message', (m) => onMessage(w, m));
    w.on('error', (e) => {
      if (!all.has(w)) return;
      counters.crashes += 1;
      kill(w, poolError('worker-crashed', 'bot worker error: ' + (e && e.message || e)));
    });
    w.on('exit', (code) => {
      if (!all.has(w)) return;
      counters.crashes += 1;
      kill(w, poolError('worker-crashed', 'bot worker exited with code ' + code));
    });
    return w;
  }

  function kill(w, error){
    all.delete(w);
    const i = idle.indexOf(w);
    if (i !== -1) idle.splice(i, 1);
    const task = busy.get(w);
    busy.delete(w);
    if (task){
      clearTimeout(task.timer);
      task.reject(error);
    }
    // Поток убран из рабочего учёта сразу (новые задачи на него не попадут),
    // но остаётся в `terminating`, пока terminate() реально не завершился, —
    // close() (в том числе повторный) ждёт именно этого.
    const p = w.terminate().catch(() => {}).then(() => { terminating.delete(p); });
    terminating.add(p);
    if (!closed) setImmediate(dispatch);
    return p;
  }

  function run(w, task){
    busy.set(w, task);
    if (busy.size > counters.maxBusySeen) counters.maxBusySeen = busy.size;
    w.ref();
    task.startedAt = Date.now();
    task.timer = setTimeout(() => {
      if (busy.get(w) !== task) return;
      counters.timeouts += 1;
      kill(w, poolError('timeout', `bot search exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    w.postMessage(Object.assign({}, task.msg, { type: 'search', requestId: task.id }));
  }

  function dispatch(){
    if (closed) return;
    while (queue.length){
      let w = idle.pop();
      if (!w){
        if (all.size >= size) return;
        w = spawn();
      }
      run(w, queue.shift());
    }
  }

  function onMessage(w, m){
    const task = busy.get(w);
    if (!task || !m || m.requestId !== task.id) return; // чужой/запоздалый ответ
    clearTimeout(task.timer);
    busy.delete(w);
    w.unref();
    idle.push(w);
    const now = Date.now();
    if (m.type === 'error'){
      counters.searchErrors += 1;
      task.reject(poolError('search-error', m.error));
    } else {
      counters.completed += 1;
      task.resolve({ move: m.move || null, trace: m.trace || null,
        queuedMs: task.startedAt - task.enqueuedAt, searchMs: now - task.startedAt });
    }
    dispatch();
  }

  // msg: { snapshot, difficulty, weights, searchOpts, gameId, revision }
  // meta.key — ключ для cancel() (например, код комнаты).
  function search(msg, meta = {}){
    return new Promise((resolve, reject) => {
      if (closed) return reject(poolError('pool-closed'));
      counters.submitted += 1;
      const task = { id: ++seq, key: meta.key ?? null, msg: msg || {}, resolve, reject,
        timer: null, enqueuedAt: Date.now(), startedAt: 0 };
      queue.push(task);
      dispatch();
      if (queue.length > maxQueue){
        const k = queue.indexOf(task);
        if (k !== -1) queue.splice(k, 1);
        counters.rejectedQueueFull += 1;
        return reject(poolError('queue-full', `bot search queue is full (${maxQueue})`));
      }
      if (queue.length > counters.maxQueueSeen) counters.maxQueueSeen = queue.length;
    });
  }

  // Снимает все задачи с данным ключом: из очереди — без следа, идущие —
  // terminate() потока. Возвращает число отменённых задач.
  function cancel(key){
    let n = 0;
    for (let i = queue.length - 1; i >= 0; i--){
      if (queue[i].key === key){
        const [t] = queue.splice(i, 1);
        t.reject(poolError('cancelled'));
        n++;
      }
    }
    for (const [w, t] of Array.from(busy)){
      if (t.key === key){ kill(w, poolError('cancelled')); n++; }
    }
    counters.cancelled += n;
    return n;
  }

  // Идемпотентно: каждый вызов (и повторный тоже) резолвится только после
  // фактического завершения ВСЕХ потоков, включая те, что уже завершаются
  // после таймаута/отмены/падения.
  function close(){
    closed = true;
    while (queue.length) queue.shift().reject(poolError('pool-closed'));
    Array.from(all).forEach((w) => kill(w, poolError('pool-closed')));
    const wait = () => terminating.size
      ? Promise.all(Array.from(terminating)).then(wait)
      : Promise.resolve();
    return wait();
  }

  function stats(){
    return Object.assign({}, counters, {
      size, maxQueue, timeoutMs, closed,
            workers: all.size + terminating.size, terminating: terminating.size,
      busy: busy.size, idle: idle.length, queued: queue.length
    });
  }

  function isBusyFor(key){
    if (queue.some((t) => t.key === key)) return true;
    for (const t of busy.values()) if (t.key === key) return true;
    return false;
  }

  return { search, cancel, close, stats, isBusyFor, size, maxQueue, timeoutMs };
}

module.exports = { createBotPool, poolError };
