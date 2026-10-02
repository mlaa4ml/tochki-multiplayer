// Real HTTP -> child process -> self-play -> SQLite integration.
// Short games bound the workload, not a stub or a larger timeout.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server.js');

function request(port, method, urlPath, body, headers){
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost', port, path: urlPath, method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {},
        headers || {}
      )
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
        } catch (err){ reject(err); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitUntilFinished(port, headers, timeoutMs){
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline){
    const res = await request(port, 'GET', '/api/admin/train', undefined, headers);
    assert.strictEqual(res.status, 200);
    last = res.body;
    if (!last.running && last.startedAt) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`training did not finish within timeout; last status: ${JSON.stringify(last)}`);
}

// All scenarios, including assertion/HTTP/polling failures, use this path.
// Await child close before closing SQLite and deleting its directory.
async function withServer(options, run){
  const server = createServer(options);
  try {
    await new Promise((resolve) => server.httpServer.listen(0, resolve));
    return await run(server, server.httpServer.address().port);
  } finally {
    await server.training.stop();
    for (const client of server.wss.clients) client.terminate();
    await new Promise((resolve) => server.wss.close(resolve));
    await new Promise((resolve) => server.httpServer.close(resolve));
    server.db.close();
  }
}

function assertExited(pid){
  assert.throws(() => process.kill(pid, 0), (err) => err.code === 'ESRCH',
    `child ${pid} should no longer exist`);
}

const headers = { 'X-Admin-Token': 'secret-token' };
const smallRun = {
  difficulty: 'normal', generations: 1, population: 1, games: 1,
  sizeKey: 'small', fillPercent: 10, seed: 42
};

async function main(){
  await withServer({ dbPath: ':memory:', adminToken: '' }, async (_, port) => {
    const res = await request(port, 'POST', '/api/admin/train', {});
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.error, 'admin-training-disabled');
    console.log('OK: without ADMIN_TOKEN training is disabled');
  });

  await withServer({ dbPath: ':memory:', adminToken: 'secret-token' }, async (_, port) => {
    for (const auth of [undefined, { 'X-Admin-Token': 'wrong' }]){
      const res = await request(port, 'POST', '/api/admin/train', {}, auth);
      assert.strictEqual(res.status, 403);
    }
    const res = await request(port, 'POST', '/api/admin/train', {}, headers);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'in-memory-db');
    console.log('OK: authorization and in-memory database protection');
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tochki-train-test-'));
  const options = { dbPath: path.join(tmpDir, 'tochki.db'), adminToken: 'secret-token' };
  try {
    await withServer(options, async (server, port) => {
      const before = await request(port, 'GET', '/api/admin/train', undefined, headers);
      assert.strictEqual(before.status, 200);
      assert.strictEqual(before.body.running, false);
      assert.strictEqual(before.body.startedAt, null);
      const weightsBefore = await request(port, 'GET', '/api/bot/weights/normal');
      assert.deepStrictEqual(weightsBefore.body.history, []);

      // Measured ~1.7 s on Node 20.13.0 versus ~31.5 s for medium/35%.
      // Same real engine/search and persistence, only a smaller board/game.
      const started = await request(port, 'POST', '/api/admin/train', smallRun, headers);
      assert.strictEqual(started.status, 202);
      assert.strictEqual(started.body.started, true);
      assert.strictEqual(started.body.run.running, true);
      assert.deepStrictEqual(started.body.run.params, smallRun);
      const pid = started.body.run.pid;
      const busy = await request(port, 'POST', '/api/admin/train', {}, headers);
      assert.strictEqual(busy.status, 409);
      assert.strictEqual(busy.body.error, 'already-running');

      const finished = await waitUntilFinished(port, headers, 30000);
      assert.strictEqual(finished.exitCode, 0, JSON.stringify(finished));
      assert.strictEqual(finished.signal, null);
      assert.strictEqual(finished.ok, true);
      assert.ok(finished.outputTail.some(line => line.includes('Сохранено в bot_weights')));
      assertExited(pid);
      console.log(`OK: real self-play child exited successfully in ${finished.finishedAt - finished.startedAt} ms`);

      const weightsAfter = await request(port, 'GET', '/api/bot/weights/normal');
      assert.strictEqual(weightsAfter.status, 200);
      assert.strictEqual(weightsAfter.body.history.length, 1);
      const summary = await request(port, 'GET', '/api/admin/summary');
      assert.strictEqual(summary.status, 200);
      assert.strictEqual(summary.body.botWeights.normal.generations, 1);
      const noAuth = await request(port, 'GET', '/api/admin/train');
      assert.strictEqual(noAuth.status, 403);
      await server.training.stop(); // also safe after successful completion
      console.log('OK: persisted weights visible through both HTTP endpoints');
    });

    // Inject a polling timeout while a real long training job is active.
    // It must propagate only after the same finally path reaps the child
    // and closes HTTP/WebSocket/SQLite resources.
    let failedServer, failedPid;
    await assert.rejects(withServer(options, async (server, port) => {
      failedServer = server;
      const started = await request(port, 'POST', '/api/admin/train',
        { ...smallRun, generations: 50, population: 20, games: 100 }, headers);
      assert.strictEqual(started.status, 202);
      failedPid = started.body.run.pid;
      process.kill(failedPid, 0);
      await waitUntilFinished(port, headers, 0);
    }), /training did not finish within timeout/);
    assertExited(failedPid);
    assert.strictEqual(failedServer.httpServer.listening, false);
    assert.strictEqual(failedServer.db.open, false);
    const stopped = failedServer.training.publicState();
    assert.strictEqual(stopped.running, false);
    assert.strictEqual(stopped.ok, false);
    assert.ok(['SIGTERM', 'SIGKILL'].includes(stopped.signal), JSON.stringify(stopped));
    await failedServer.training.stop(); // idempotent
    console.log('OK: timeout reaps training child and closes server/database');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log('\nALL TRAINING INTEGRATION CHECKS PASSED');
}

// Do not force exit: leaked handles should be detected by the test run.
main().catch((err) => { console.error('TEST FAILED:', err); process.exitCode = 1; });
