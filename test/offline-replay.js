// test/offline-replay.js — B03 (issue #26): offline-реплеи и хранилище.
//   node test/offline-replay.js
// Проверяет:
//   - экспорт -> импорт реплея (общий формат A02, replay.js) восстанавливает
//     счёт, очередь хода и конец партии;
//   - невалидный импорт даёт понятную ошибку и не меняет текущую партию;
//   - отказ/квота localStorage и недоступный IndexedDB не мешают доиграть.
'use strict';
const assert = require('assert');
const { createLocalSession } = require('../offline/localSession.js');
const { createStorage } = require('../offline/storage.js');
const Replay = require('../replay.js');

function noWorker(){ throw new Error('Worker не нужен в этом тесте'); }

function play(session, moves){
  for (const [x, y] of moves){
    const r = session.move(x, y);
    assert.ok(r.ok, 'ход (' + x + ',' + y + '): ' + (r.reason || ''));
  }
}

const HH = { 1: 'human', 2: 'human' };
// Первые два камня — в стартовой зоне (центр поля), дальше — свободные клетки.
const MOVES = [[5, 5], [6, 5], [5, 4], [6, 4], [2, 2], [9, 7], [2, 7], [9, 2]];

async function main(){
  // 1. Экспорт -> импорт: оконченная партия.
  const a = createLocalSession({ createWorker: noWorker, replay: Replay });
  a.newGame({ sizeKey: 'small', controllers: HH });
  play(a, MOVES);
  a.end();
  const before = a.snapshot();
  assert.ok(before.gameOver, 'партия окончена');
  const text = a.exportReplay();
  assert.strictEqual(JSON.parse(text).format, 'tochki-replay', 'экспорт в общем формате A02');

  const b = createLocalSession({ createWorker: noWorker, replay: Replay });
  b.newGame({ sizeKey: 'small', controllers: HH });
  const res = b.loadReplay(text);
  assert.ok(res.ok, 'импорт: ' + res.reason);
  const after = b.snapshot();
  assert.deepStrictEqual(after.scores, before.scores, 'счёт');
  assert.strictEqual(after.current, before.current, 'очередь хода');
  assert.strictEqual(after.gameOver, true, 'конец партии');
  assert.strictEqual(b.status().moveCount, a.status().moveCount, 'число ходов');
  assert.strictEqual(b.exportReplay(), text, 'повторный экспорт совпадает побайтно');
  console.log('ok - экспорт -> импорт оконченной партии: счёт/очередь/конец совпадают');

  // 2. Неоконченная партия: очередь хода восстанавливается.
  const c = createLocalSession({ createWorker: noWorker, replay: Replay });
  c.newGame({ sizeKey: 'small', controllers: HH, firstPlayer: 2 });
  play(c, MOVES.slice(0, 3));
  const cText = c.exportReplay();
  const d = createLocalSession({ createWorker: noWorker, replay: Replay });
  assert.ok(d.loadReplay(cText).ok);
  assert.strictEqual(d.snapshot().current, c.snapshot().current, 'очередь хода (неоконченная)');
  assert.strictEqual(d.snapshot().gameOver, false);
  console.log('ok - неоконченная партия: очередь хода восстановлена');

  // 3. Невалидный импорт не меняет текущую партию.
  const e = createLocalSession({ createWorker: noWorker, replay: Replay });
  e.newGame({ sizeKey: 'small', controllers: HH });
  play(e, MOVES.slice(0, 4));
  const snapBefore = JSON.stringify(e.snapshot());
  const replayBefore = JSON.stringify(e.getReplay());
  const tampered = JSON.parse(text);
  tampered.events[tampered.events.length - 1].scores = { 1: 99, 2: 0 };
  const bad = ['{не json', '{"format":"other"}', JSON.stringify(tampered), JSON.stringify({ ...JSON.parse(text), version: 99 })];
  for (const input of bad){
    const r = e.loadReplay(input);
    assert.strictEqual(r.ok, false, 'невалидный импорт отклонён');
    assert.ok(/^Replay: /.test(r.reason), 'понятная ошибка: ' + r.reason);
    assert.strictEqual(JSON.stringify(e.snapshot()), snapBefore, 'партия не изменилась');
    assert.strictEqual(JSON.stringify(e.getReplay()), replayBefore, 'реплей не изменился');
  }
  play(e, MOVES.slice(4, 5)); // партию можно продолжать
  console.log('ok - невалидный импорт: ошибка, текущая партия без изменений');

  // 4. Отказ хранилища / quota не мешает доиграть.
  const quotaLs = {
    getItem(){ throw Object.assign(new Error('denied'), { name: 'SecurityError' }); },
    setItem(){ throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); },
    removeItem(){ throw new Error('denied'); }
  };
  const brokenIdb = { open(){ throw new Error('IndexedDB disabled'); } };
  for (const st of [createStorage({ localStorage: quotaLs, indexedDB: brokenIdb }),
                    createStorage({ localStorage: null, indexedDB: null })]){
    const g = createLocalSession({ createWorker: noWorker, replay: Replay });
    g.newGame({ sizeKey: 'small', controllers: HH });
    assert.strictEqual(st.loadSettings(), null);
    assert.strictEqual(st.loadAutosave(), null);
    for (const [x, y] of MOVES){
      assert.ok(g.move(x, y).ok);
      const s = st.saveAutosave(g.getReplay());
      assert.strictEqual(s.ok, false, 'автосохранение сообщает об отказе');
    }
    assert.strictEqual(st.saveSettings({ sizeKey: 'small' }).ok, false);
    const saved = await st.saveReplay('x', g.getReplay());
    assert.strictEqual(saved.ok, false, 'IndexedDB: отказ без исключения');
    assert.strictEqual((await st.listReplays()).ok, false);
    g.end();
    assert.ok(g.snapshot().gameOver, 'партия доиграна несмотря на отказ хранилища');
  }
  // Квота: превышение лимита автосохранения.
  const mem = new Map();
  const memLs = { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  const st2 = createStorage({ localStorage: memLs, indexedDB: null });
  assert.ok(st2.saveAutosave({ small: true }).ok);
  assert.deepStrictEqual(st2.loadAutosave(), { small: true });
  const huge = st2.saveAutosave({ blob: 'x'.repeat(300 * 1024) });
  assert.strictEqual(huge.ok, false);
  assert.ok(/квот/.test(huge.error), huge.error);
  assert.ok(st2.saveSettings({ a: 1 }).ok);
  assert.deepStrictEqual(st2.loadSettings(), { a: 1 });
  console.log('ok - отказ/quota localStorage и недоступный IndexedDB не мешают доиграть партию');
  console.log('all offline-replay tests passed');
}

main().catch(err => { console.error(err); process.exit(1); });
