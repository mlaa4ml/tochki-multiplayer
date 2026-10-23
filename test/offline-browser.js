'use strict';

// Install test-only tooling separately: see offline/README.md.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { build } = require('../tools/build-offline');
const { serve } = require('../tools/serve-offline');
const playwright = process.env.PLAYWRIGHT_MODULE
  ? createRequire(path.resolve(process.env.PLAYWRIGHT_MODULE))('playwright')
  : require('playwright');

async function check(name, base) {
  const browser = await playwright[name].launch({ headless: true });
  const errors = [], requests = [];
  try {
    const context = await browser.newContext();
    // Capture the real UI-created session, without changing production files.
    // Bound search work only; all moves still use the canonical engine/Worker.
    await context.addInitScript(() => {
      let api;
      Object.defineProperty(window, 'TochkiLocalSession', {
        get: () => api,
        set(value) {
          api = { ...value, createLocalSession(opts) {
            const session = value.createLocalSession({
              ...opts, searchOpts: { normal: { nodeLimit: 30, timeLimit: 0 } }
            });
            window.testSession = session;
            return session;
          } };
        }
      });
    });
    context.on('request', req => requests.push({ url: req.url(), type: req.resourceType() }));
    const page = await context.newPage();
    page.on('pageerror', err => errors.push(String(err)));
    page.on('websocket', ws => errors.push('Unexpected WebSocket: ' + ws.url()));
    await page.goto(base + '/');
    await page.waitForFunction(() => !!window.testSession);
    await page.selectOption('#c1', 'human');
    await page.selectOption('#c2', 'normal');
    await page.fill('#targetFill', '10');
    await page.click('#btnNew');
    // Real canvas input for the human; real Web Worker replies for the bot.
    for (let turns = 0; turns < 100; turns++) {
      await page.waitForFunction(() => {
        const s = window.testSession;
        return s.snapshot().gameOver || s.status().humanTurn || s.status().workerError;
      });
      const state = await page.evaluate(() => ({
        snap: window.testSession.snapshot(), status: window.testSession.status()
      }));
      assert.equal(state.status.workerError, null);
      if (state.snap.gameOver) break;
      const before = state.status.moveCount;
      const canvas = await page.locator('#board').boundingBox();
      let moved = false;
      for (let y = 0; y < state.snap.rows && !moved; y++) {
        for (let x = 0; x < state.snap.cols && !moved; x++) {
          if (state.snap.stone[y][x]) continue;
          await page.mouse.click(
            canvas.x + canvas.width * (x + 1) / (state.snap.cols + 1),
            canvas.y + canvas.height * (y + 1) / (state.snap.rows + 1));
          moved = await page.evaluate(n => window.testSession.status().moveCount > n, before);
        }
      }
      assert(moved, 'Human must have a legal canvas move');
    }
    assert(await page.evaluate(() => window.testSession.snapshot().gameOver));
    assert.match(await page.locator('#status').textContent(), /Партия окончена/);
    const humanBotMoves = await page.evaluate(() => window.testSession.status().moveCount);
    assert(humanBotMoves >= 2);

    await page.selectOption('#c1', 'normal');
    await page.fill('#targetFill', '100');
    await page.locator('#delay').evaluate(el => { el.value = '0'; });
    await page.locator('#delay').dispatchEvent('input');
    await page.click('#btnNew');
    await page.click('#btnStart');
    await page.waitForFunction(() => window.testSession.snapshot().gameOver ||
      window.testSession.status().workerError, { timeout: 180000 });
    assert.equal(await page.locator('#error').textContent(), '');
    assert.match(await page.locator('#status').textContent(), /Партия окончена/);
    const botBotMoves = await page.evaluate(() => window.testSession.status().moveCount);
    assert(botBotMoves > 20);
    assert.deepEqual(errors, []);
    const allowed = new Set(['/', '/offline/index.html', '/gameEngine.js', '/offline/localSession.js', '/botWorker.js']);
    for (const req of requests) {
      const url = new URL(req.url);
      assert.equal(url.origin, base);
      assert(allowed.has(url.pathname), 'Unexpected request: ' + req.url);
      assert(!['fetch', 'xhr', 'websocket'].includes(req.type), 'Unexpected API request');
    }
    return { browser: name, version: browser.version(), humanBotMoves, botBotMoves, errors, requests };
  } finally { await browser.close(); }
}

async function main() {
  build();
  const server = serve({ port: 0 });
  try {
    await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const results = [];
    for (const name of (process.env.BROWSER || 'chromium,firefox').split(',')) {
      results.push(await check(name, base));
    }
    const output = { results };
    if (process.env.BROWSER_REPORT) fs.writeFileSync(process.env.BROWSER_REPORT, JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify(output, null, 2));
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
