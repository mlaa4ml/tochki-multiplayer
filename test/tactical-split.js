// test/tactical-split.js — #83: разбиение тактического набора по партиям,
// восстановление позиций и легальность меток rescue[], конфигурации fork4*.
'use strict';
const assert = require('assert');
const fs = require('fs');
const E = require('../gameEngine.js');
const A = require('../arbiter.js');
const T = require('../tools/bench/tactical-set.js');
const RB = require('../tools/bench/replay-blunders.js');

// 1. Файл разбиения корректен: части известны, по умолчанию — test.
const sp = T.loadSplit(T.SPLIT_FILE);
assert.deepStrictEqual(sp.data.splits, ['train', 'validation', 'test']);
assert.strictEqual(sp.data.defaultSplit, 'test');
assert.strictEqual(sp.of('новая-непросмотренная-партия'), 'test');

// 2. Разбиение по ЦЕЛЫМ партиям: все позиции одной партии в одной части.
const set = JSON.parse(fs.readFileSync(T.SET_FILE, 'utf8'));
const partOfGame = new Map();
for (const p of set.positions){
  assert.ok(p.game, `${p.id}: нет поля game`);
  const part = sp.of(p.game);
  if (partOfGame.has(p.game)) assert.strictEqual(partOfGame.get(p.game), part);
  partOfGame.set(p.game, part);
  // Партии текущего набора уже просмотрены (#81/#83) — не тест.
  assert.notStrictEqual(part, 'test', `${p.game}: просмотренная партия не может быть в test`);
}
// Каждая партия набора указана в разбиении явно; train и validation непусты.
for (const g of partOfGame.keys()) assert.ok(sp.data.games[g], `${g}: партия не указана в разбиении`);
const parts = new Set(partOfGame.values());
assert.ok(parts.has('train') && parts.has('validation'));

// 3. selectPositions: --split отбирает только свою часть, части не пересекаются.
const base = { set: T.SET_FILE, splitFile: T.SPLIT_FILE, offset: 0, limit: 0 };
const tr = T.selectPositions(Object.assign({ split: 'train' }, base));
const va = T.selectPositions(Object.assign({ split: 'validation' }, base));
assert.ok(tr.length > 0 && va.length > 0);
assert.strictEqual(tr.length + va.length, set.positions.length);
const trGames = new Set(tr.map(p => p.game));
for (const p of va) assert.ok(!trGames.has(p.game), `утечка партии ${p.game} между train и validation`);

// 4. Позиции восстанавливаются, ход за ботом, все метки rescue[] легальны.
const files = RB.listCorpusFiles();
const cache = new Map();
let checked = 0;
for (const p of set.positions){
  const key = p.file + '#' + p.index;
  if (!cache.has(key)){
    const f = files.find(x => require('path').basename(x) === p.file);
    assert.ok(f, `${p.id}: файл реплея ${p.file} не найден`);
    cache.set(key, RB.loadGames(f)[p.index].replay);
  }
  const errs = T.checkPosition(cache.get(key), p);
  assert.deepStrictEqual(errs, [], `${p.id}: ${errs.join('; ')}`);
  checked++;
}
assert.strictEqual(checked, set.positions.length);

// 5. Новые конфигурации #83 — только через monitor:true; по умолчанию арбитр
// forkRescue не включает, при monitor:false ход ровно как у базы.
for (const c of ['fork4', 'fork4-r2', 'fork4-10s']){
  assert.ok(T.CONFIGS[c] && T.CONFIGS[c].monitor === true && T.CONFIGS[c].arbiter.forkRescue === true);
  assert.strictEqual(T.CONFIGS[c].arbiter.forkMinSize, 4);
}
assert.ok(!A.ARBITER_DEFAULTS.forkRescue);
const m = E.createMatch({ sizeKey: 'small' });
const s = m.getSnapshot();
const st = { stone: s.stone, dead: s.dead, territory: s.territory };
const opts = { nodeLimit: 500, stonesPlacedTotal: s.stonesPlacedTotal, rules: s.rules };
const a = E.searchMove(st, s.rows, s.cols, s.current || 1, E.DIFFICULTY.strong, null, opts);
const b = A.arbiterMove(st, s.rows, s.cols, s.current || 1, E.DIFFICULTY.strong, null,
  Object.assign({}, opts, { monitor: false, arbiter: T.CONFIGS['fork4-10s'].arbiter }));
assert.deepStrictEqual({ x: b.move.x, y: b.move.y }, { x: a.move.x, y: a.move.y });
console.log('tactical-split: OK');
