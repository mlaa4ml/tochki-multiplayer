'use strict';
const { Worker } = require('worker_threads');

// A bounded, lazy pool. Terminating workers still consume capacity until exit.
function createBotPool(options = {}){
  const integer = (n, fallback, min) => Number.isInteger(n) && n >= min ? n : fallback;
  const size = integer(options.size, 2, 1);
  const maxQueue = integer(options.maxQueue, 16, 0);
  const timeoutMs = integer(options.timeoutMs, 10000, 1);
  const workers = new Set();
  const queue = [];
  const tasks = new Map();
  const terminating = new Set();
  const counters = { completed: 0, rejected: 0, cancelled: 0, timeouts: 0, crashes: 0 };
  let closed = false, closing = null;
  const failure = code => Object.assign(new Error(code), { code });

  function settle(task, err, value){
    if (!tasks.delete(task.key)) return;
    clearTimeout(task.timer);
    if (err) task.reject(err); else task.resolve(value);
  }
  function retire(slot){
    if (slot.retiring) return;
    slot.retiring = true;
    slot.worker.ref();
    const p = slot.worker.terminate().catch(() => {}).then(() => {
      workers.delete(slot);
      terminating.delete(p);
      drain();
    });
    terminating.add(p);
  }
  function failed(slot, code){
    if (slot.retiring) return;
    counters.crashes++;
    if (slot.task) settle(slot.task, failure(code));
    slot.task = null;
    retire(slot);
  }
  function spawn(){
    const slot = { worker: new Worker(options.workerPath || require.resolve('./botWorker.js')), task: null, retiring: false };
    workers.add(slot);
    slot.worker.on('message', msg => {
      const task = slot.task;
      if (!task || slot.retiring) return;
      const req = task.msg;
      if (!msg || msg.requestId !== req.requestId || msg.gameId !== req.gameId ||
          msg.revision !== req.revision || msg.roomId !== req.roomId){
        failed(slot, 'invalid-response');
        return;
      }
      slot.task = null;
      slot.worker.unref();
      counters.completed++;
      settle(task, msg.type === 'result' ? null : failure('search-error'), msg);
      drain();
    });
    slot.worker.on('error', () => failed(slot, 'worker-crashed'));
    slot.worker.on('exit', () => failed(slot, 'worker-crashed'));
    slot.worker.unref();
    return slot;
  }
  function drain(){
    if (closed) return;
    while (queue.length){
      let slot = [...workers].find(s => !s.retiring && !s.task);
      if (!slot && workers.size < size){
        try { slot = spawn(); }
        catch (_) { settle(queue.shift(), failure('worker-crashed')); continue; }
      }
      if (!slot) break;
      const task = queue.shift();
      slot.task = task;
      slot.worker.ref();
      task.timer = setTimeout(() => {
        counters.timeouts++;
        settle(task, failure('timeout'));
        slot.task = null;
        retire(slot);
      }, timeoutMs);
      try { slot.worker.postMessage(task.msg); }
      catch (_) { failed(slot, 'worker-crashed'); }
    }
  }
  function search(key, msg){
    if (closed) return Promise.reject(failure('pool-closed'));
    if (tasks.has(key)) return Promise.reject(failure('duplicate-request'));
    const idle = [...workers].some(s => !s.retiring && !s.task);
    if (!idle && workers.size >= size && queue.length >= maxQueue){
      counters.rejected++;
      return Promise.reject(failure('queue-full'));
    }
    return new Promise((resolve, reject) => {
      const task = { key, msg, resolve, reject, timer: null };
      tasks.set(key, task);
      queue.push(task);
      drain();
    });
  }
  function cancel(key){
    const task = tasks.get(key);
    if (!task) return false;
    counters.cancelled++;
    const index = queue.indexOf(task);
    if (index >= 0) queue.splice(index, 1);
    settle(task, failure('cancelled'));
    const slot = [...workers].find(s => s.task === task);
    if (slot){ slot.task = null; retire(slot); }
    return true;
  }
  function close(){
    if (closing) return closing;
    closed = true;
    for (const task of queue.splice(0)) settle(task, failure('pool-closed'));
    for (const slot of workers){
      if (slot.task) settle(slot.task, failure('pool-closed'));
      slot.task = null;
      retire(slot);
    }
    closing = Promise.all([...terminating]).then(() => {});
    return closing;
  }
  function stats(){
    return { size, maxQueue, timeoutMs, workers: workers.size,
      active: [...workers].filter(s => s.task).length, queued: queue.length,
      terminating: terminating.size, closed, ...counters };
  }
  return { search, cancel, close, stats };
}
module.exports = { createBotPool };
