// test/replay-prefork.js — тактический тест на позициях «до вилки» (issue #57, S3).
// Набор tools/bench/corpus/prefork.regression.json генерируется командой
//   node tools/bench/replay-blunders.js --prefork --game <id партии regression>
// В каждой позиции бот ещё мог спастись: минимальная потеря на 6 полуходов
// (решатель preforkLoss) мала, а сыгранный ход ведёт к взятию группы.
// Тест БЕЗ допуска «минимум + 1»: считаем долю позиций, где текущий поиск
// normal/strong при фиксированном nodeLimit выбирает спасающий ход, и
// сверяем её с зафиксированной базовой линией (baseline). Рост доли —
// улучшение: обновите набор (--prefork) и docs/S3_PREFORK.md. Падение — регрессия.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const B = require('../tools/bench/replay-blunders.js');

const t0 = Date.now();
const data = JSON.parse(fs.readFileSync(B.PREFORK_FILE, 'utf8'));
assert.strictEqual(data.format, 'tochki-prefork-regression');
assert.ok(data.positions.length >= 1, 'в наборе regression есть позиции «до вилки»');

const manifest = B.loadManifest(path.join(B.CORPUS_DIR, 'manifest.json'));
const replays = new Map();
function replayOf(p){
  const k = p.file + '#' + p.index;
  if (!replays.has(k)) replays.set(k, B.loadGames(path.join(B.CORPUS_DIR, p.file))[p.index].replay);
  return replays.get(k);
}

const rate = { normal: 0, strong: 0 };
for (const p of data.positions){
  // Позиция из части regression манифеста.
  assert.strictEqual(B.splitOf(manifest, p.file, p.index).split, 'regression', `${p.id}: партия не в regression`);
  const r = replayOf(p);
  const moves = r.events.filter(e => e.type === 'move');
  assert.ok(moves[p.ply].decision, `${p.id} ход ${p.ply} должен быть ходом бота`);
  assert.deepStrictEqual({ x: moves[p.ply].x, y: moves[p.ply].y }, p.played, `${p.id}: сыгранный ход`);
  const m = B.matchAtPly(r, p.ply);
  const nd = E.createSearchNode(m.getSnapshot());
  assert.strictEqual(nd.current, p.botSeat, `${p.id}: ходит бот`);
  // Спасение существует: пересчёт решателя совпадает с набором.
  const fc = data.params.forkCap;
  const pl = B.preforkLoss(nd, p.botSeat, p.played.x, p.played.y, fc);
  assert.strictEqual(pl.loss, p.playedLoss, `${p.id}: потеря сыгранного хода`);
  assert.ok(p.rescue.length >= 1, `${p.id}: есть спасающие ходы`);
  for (const c of p.rescue){
    const l = B.preforkLoss(nd, p.botSeat, c.x, c.y, fc);
    assert.strictEqual(l.loss, c.loss, `${p.id}: потеря спасающего хода (${c.x},${c.y})`);
    assert.ok(l.loss <= p.minLoss + 1);
  }
  assert.ok(p.minLoss <= Math.floor(p.captured / 2) && p.playedLoss - p.minLoss >= 3,
    `${p.id}: спасение существует (минимум ${p.minLoss}, сыграно ${p.playedLoss})`);
  // Ход текущего поиска при фиксированном nodeLimit (детерминированно).
  for (const level of Object.keys(B.PREFORK_NODE_LIMITS)){
    const nl = data.params.nodeLimits[level];
    const a = B.evalLevel(r, p.ply, level, nl, p.rescue);
    const b = B.evalLevel(r, p.ply, level, nl, p.rescue);
    assert.deepStrictEqual(a, b, `${p.id} ${level}: поиск детерминирован`);
    if (a.saved) rate[level]++;
    console.log(`${p.id} ход ${p.ply} ${level}@${nl}: (${a.move ? a.move.x + ',' + a.move.y : '-'}) ${a.saved ? 'спас' : 'не спас: ' + a.cause}`);
  }
}

for (const level of Object.keys(rate)){
  const base = data.baseline[level];
  console.log(`${level}: спасений ${rate[level]}/${data.positions.length} (база ${base.saved}/${base.positions})`);
  assert.strictEqual(base.positions, data.positions.length);
  // Без допуска: доля не ниже базы; рост — улучшение, базу нужно обновить.
  assert.ok(rate[level] >= base.saved, `${level}: регрессия — спасений ${rate[level]}, база ${base.saved}`);
  if (rate[level] > base.saved) console.log(`  ${level}: улучшение! Обновите набор: node tools/bench/replay-blunders.js --prefork`);
}
console.log(`replay-prefork: OK (${data.positions.length} позиций, ${Date.now() - t0} мс)`);
