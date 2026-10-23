'use strict';
const assert = require('assert/strict');
const { createBotPool } = require('../botPool');
const E = require('../gameEngine');
const workerPath = require.resolve('./fixtures/bot-worker');
const msg = (id, extra = {}) => ({
  type: 'search', roomId: 'room', gameId: 1, revision: 0, requestId: id, ...extra
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main(){
  const real = createBotPool({ size: 1 });
  try {
    const match = E.createMatch({ sizeKey: 'small' });
    const reply = await real.search(1, msg(1, {
      snapshot: match.getSnapshot(), difficulty: 'normal',
      searchOpts: { nodeLimit: 100, timeLimit: 50 }
    }));
    assert(reply.trace);
    assert(match.applyMove(1, reply.move.x, reply.move.y).ok);
  } finally { await real.close(); }

  const pool = createBotPool({ workerPath, size: 1, maxQueue: 1, timeoutMs: 2000 });
  try {
    const a = pool.search(1, msg(1, { delay: 200 }));
    const b = pool.search(2, msg(2));
    assert.equal(pool.stats().active, 1);
    assert.equal(pool.stats().queued, 1);
    await assert.rejects(pool.search(3, msg(3)), { code: 'queue-full' });
    const cancelled = assert.rejects(b, { code: 'cancelled' });
    assert(pool.cancel(2));
    await cancelled;
    await a;
    const crash = pool.search(4, msg(4, { mode: 'crash' }));
    await assert.rejects(crash, { code: 'worker-crashed' });
    await pool.search(5, msg(5));
    const running = pool.search(6, msg(6, { mode: 'hang' }));
    const rejected = assert.rejects(running, { code: 'cancelled' });
    pool.cancel(6);
    await rejected;
    await Promise.all([pool.close(), pool.close()]);
    assert.equal(pool.stats().workers, 0);
    assert.equal(pool.stats().terminating, 0);
    await assert.rejects(pool.search(7, msg(7)), { code: 'pool-closed' });
  } finally { await pool.close(); }

  const timeout = createBotPool({ workerPath, size: 1, timeoutMs: 200 });
  try {
    await assert.rejects(timeout.search(1, msg(1, { mode: 'hang' })), { code: 'timeout' });
    await timeout.search(2, msg(2));
    assert.equal(timeout.stats().timeouts, 1);
  } finally { await timeout.close(); }

  const load = createBotPool({ workerPath, size: 2, maxQueue: 4 });
  try {
    const jobs = Array.from({ length: 6 }, (_, i) => load.search(i, msg(i, { delay: 50 })));
    await assert.rejects(load.search(9, msg(9)), { code: 'queue-full' });
    while (load.stats().active || load.stats().queued){
      assert(load.stats().workers <= 2);
      assert(load.stats().queued <= 4);
      await sleep(10);
    }
    await Promise.all(jobs);
    assert.equal(load.stats().completed, 6);
  } finally { await load.close(); }
  console.log('OK: bot pool legality, bounds, queue, cancel, crash, timeout, recovery, joined shutdown');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
