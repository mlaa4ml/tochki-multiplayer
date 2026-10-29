// test/corpus-manifest.js — проверка манифеста корпуса реальных партий (issue #56).
// Корпус делится по партиям: ни одна партия не входит в две части,
// все файлы манифеста существуют, правила/поле совпадают с реплеями,
// неизвестные партии попадают в holdout, replay-blunders.js понимает --split.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RB = require('../tools/bench/replay-blunders.js');

const dir = RB.CORPUS_DIR;
const manifestPath = path.join(dir, 'manifest.json');
assert.ok(fs.existsSync(manifestPath), 'manifest.json существует');
const M = RB.loadManifest(manifestPath);
const SPLITS = ['dev', 'regression', 'holdout'];
assert.deepStrictEqual(RB.SPLITS, SPLITS, 'набор частей');
assert.strictEqual(M.defaultSplit, 'holdout', 'новая партия по умолчанию — holdout');

const ids = new Map();
const keys = new Map();
const cache = new Map();
for (const g of M.games){
  assert.ok(typeof g.id === 'string' && g.id, 'у партии есть id');
  assert.ok(SPLITS.includes(g.split), `${g.id}: недопустимая часть ${g.split}`);
  assert.ok(!ids.has(g.id), `${g.id}: id повторяется (части ${ids.get(g.id)} и ${g.split})`);
  ids.set(g.id, g.split);
  const key = g.file + '#' + g.index;
  assert.ok(!keys.has(key), `${key}: партия входит в две части (${keys.get(key)} и ${g.split})`);
  keys.set(key, g.split);
  const fp = path.join(dir, g.file);
  assert.ok(fs.existsSync(fp), `${g.id}: файл ${g.file} не существует`);
  if (!cache.has(fp)) cache.set(fp, RB.loadGames(fp));
  const arr = cache.get(fp);
  assert.ok(Number.isInteger(g.index) && g.index >= 0 && g.index < arr.length, `${g.id}: нет партии #${g.index} в ${g.file}`);
  const r = arr[g.index].replay;
  assert.strictEqual(r.board.sizeKey, g.board, `${g.id}: поле`);
  assert.ok(g.rules, `${g.id}: правила указаны`);
  assert.strictEqual(r.rules.targetFillPercent, g.rules.fill, `${g.id}: fill`);
  assert.strictEqual(r.rules.startPosition, g.rules.startPosition, `${g.id}: старт`);
  assert.strictEqual(r.rules.firstPlayer, g.rules.firstPlayer, `${g.id}: кто ходит первым`);
}

// Все партии корпуса: явно размечены или получают holdout по умолчанию.
const files = RB.listCorpusFiles(dir);
assert.ok(!files.some(f => path.basename(f) === 'manifest.json'), 'манифест не считается реплеем');
const all = RB.selectGames(files, M, null);
for (const g of all) assert.ok(SPLITS.includes(g.split), `${g.id}: часть ${g.split}`);
assert.strictEqual(RB.splitOf(M, 'new-game.json', 0).split, 'holdout', 'неизвестная партия → holdout');
assert.strictEqual(RB.splitOf(null, 'x.json', 0).split, 'holdout', 'без манифеста → holdout');

// Части не пересекаются и вместе дают весь корпус.
const seen = new Set();
let sum = 0;
for (const s of SPLITS){
  const part = RB.selectGames(files, M, s);
  sum += part.length;
  for (const g of part){
    const k = g.file + '#' + g.index;
    assert.ok(!seen.has(k), `${k}: попала в несколько частей`);
    seen.add(k);
    assert.strictEqual(g.split, s);
  }
  const expected = M.games.filter(g => g.split === s).map(g => g.id).sort();
  const got = part.map(g => g.id).filter(id => ids.has(id)).sort();
  assert.deepStrictEqual(got, expected, `часть ${s} совпадает с манифестом`);
}
assert.strictEqual(sum, all.length, 'сумма частей = весь корпус');

// 6 партий из #52 (4 small + 2 medium) размечены, все три части непусты.
const i52 = M.games.filter(g => g.file.startsWith('issue52-'));
assert.strictEqual(i52.length, 6, '6 партий #52 в манифесте');
assert.strictEqual(i52.filter(g => g.board === 'small').length, 4, '4 small');
assert.strictEqual(i52.filter(g => g.board === 'medium').length, 2, '2 medium');
for (const s of SPLITS) assert.ok(M.games.some(g => g.split === s), `часть ${s} непуста`);

// Разбор --split.
assert.strictEqual(RB.parseArgs(['--split', 'dev']).split, 'dev');
assert.strictEqual(RB.parseArgs(['--split', 'holdout']).split, 'holdout');
assert.strictEqual(RB.parseArgs([]).split, null);
assert.throws(() => RB.parseArgs(['--split', 'test']), /--split/);

console.log(`corpus-manifest: OK (${M.games.length} партий: ` +
  SPLITS.map(s => `${s} ${M.games.filter(g => g.split === s).length}`).join(', ') + ')');
