// test/paired-match.js — S4 (issue #58): парный матч кандидат против базы.
// Быстрая проверка: дебюты только из dev/regression, обе стороны в паре,
// сводка содержит все метрики. Полный прогон (50 пар) — вручную, см. docs/BENCHMARK.md.
'use strict';
const assert = require('assert');
const PM = require('../tools/bench/paired-match.js');

const opts = PM.parseArgs(['--pairs', '50', '--to', '1', '--no-tactics', '--quiet', '--max-moves', '6']);
assert.strictEqual(opts.sensitivity, true, 'по умолчанию — проверка чувствительности');
assert.strictEqual(opts.candidate.difficulty, 'strong');
assert.strictEqual(opts.candidate.nodeLimit, 3000);
assert.strictEqual(opts.base.difficulty, 'normal');
assert.strictEqual(opts.base.nodeLimit, 300);

const openings = PM.buildOpenings(opts);
assert.ok(openings.length >= 50, 'не меньше 50 дебютов');
const ids = new Set(openings.map(o => o.id));
assert.strictEqual(ids.size, openings.length, 'дебюты уникальны');
for (const o of openings){
  assert.ok(PM.PLAY_SPLITS.includes(o.split), `${o.id}: только dev/regression`);
  assert.notStrictEqual(o.split, 'holdout');
  assert.strictEqual(o.rules.targetFillPercent, 64);
  assert.strictEqual(o.rules.targetScore, 0);
  assert.strictEqual(o.rules.startPosition, 'cross');
}

const rep = PM.run(opts);
assert.strictEqual(rep.summary.pairs, 1);
assert.strictEqual(rep.summary.games, 2);
assert.deepStrictEqual(rep.pairs[0].games.map(g => g.candSeat), [1, 2], 'обе стороны');
for (const k of ['scoreDiffMean', 'nonZeroShare', 'decisiveShare', 'ci95', 'timing', 'candidateBetter'])
  assert.ok(k in rep.summary, 'в сводке есть ' + k);
assert.ok('msP95' in rep.summary.timing.candidate && 'nodesP95' in rep.summary.timing.base);

const s = PM.parseSide('strong:3000');
assert.deepStrictEqual(s, { difficulty: 'strong', nodeLimit: 3000 });
assert.throws(() => PM.parseSide('bogus:1'));
console.log('paired-match: ok');
