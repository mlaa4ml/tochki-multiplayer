'use strict';
// Optional real-browser integration: install Playwright externally, see offline/README.md.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium, firefox } = require('playwright');
const { build } = require('../tools/build-offline');
const server = require('../tools/serve-offline');
const out = path.resolve(__dirname, '../dist/offline');
async function main(){
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  for (const [name, type] of [['Chromium', chromium], ['Firefox', firefox]]){
    build({ out });
    const browser = await type.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      await page.goto(url);
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      await context.setOffline(true);
      await page.reload();
      await page.selectOption('#c1', 'normal');
      await page.selectOption('#c2', 'normal');
      await page.fill('#targetFill', '1');
      await page.locator('#delay').evaluate(el => { el.value = '0'; el.dispatchEvent(new Event('input')); });
      await page.click('#btnNew');
      await page.click('#btnStart');
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Партия окончена'));
      assert.strictEqual(await page.locator('#error').textContent(), '');
      assert.match(await page.locator('#info').textContent(), /Ходов: [1-9]/);
      console.log('ok - ' + name + ': offline reload and bot game completed using real Web Worker');
      await context.setOffline(false);
      const original = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
      const version = JSON.parse(fs.readFileSync(path.join(out, 'build-manifest.json'))).cacheVersion;
      fs.writeFileSync(path.join(out, 'sw.js'), original.replace(version, version + '-new'));
      fs.appendFileSync(path.join(out, 'pwa.js'), '\n// browser update fixture\n');
      await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); });
      await page.getByRole('button', { name: 'Обновить и перезагрузить' }).waitFor();
      await Promise.all([
        page.waitForEvent('load'),
        page.getByRole('button', { name: 'Обновить и перезагрузить' }).click()
      ]);
      await page.waitForFunction(async () => {
        const keys = (await caches.keys()).filter(k => k.startsWith('tochki-offline-/'));
        return keys.length === 1 && keys[0].endsWith('-new');
      });
      await context.setOffline(true);
      await page.reload();
      assert.ok(await page.evaluate(async () => (await (await caches.open((await caches.keys())[0])).match('pwa.js')).text().then(t => t.includes('browser update fixture'))));
      console.log('ok - ' + name + ': update offered, consent reload, old cache removed, new version works offline');
      await context.close();
      build({ out });
      const failed = await browser.newContext();
      await failed.addInitScript(() => {
        window.Worker = function(){ throw new Error('Worker deliberately unavailable'); };
      });
      const p = await failed.newPage();
      await p.goto(url);
      await p.selectOption('#c1', 'normal');
      await p.selectOption('#c2', 'normal');
      await p.click('#btnNew');
      await p.click('#btnStart');
      await p.waitForFunction(() => document.querySelector('#error').textContent.includes('Worker deliberately unavailable'));
      assert.strictEqual(await p.locator('#spinner').getAttribute('class'), '');
      await p.click('#btnEnd');
      assert.match(await p.locator('#status').textContent(), /Партия окончена/);
      console.log('ok - ' + name + ': Worker rejection visible, spinner cleared, UI still responsive');
      await failed.close();
    } finally { await browser.close(); }
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  build({ out });
  server.close();
});
