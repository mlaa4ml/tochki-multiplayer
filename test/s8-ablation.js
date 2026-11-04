// test/s8-ablation.js — S8 (issue #62): флаги сторон парного матча,
// арбитр без решателя и правила решения таблицы абляций.
'use strict';
const assert = require('assert');
const E = require('../gameEngine.js');
const PM = require('../tools/bench/paired-match.js');
const S8 = require('../tools/bench/s8-ablation.js');
const A = require('../arbiter.js');

// 1. Разбор флагов стороны.
{
  const s = PM.parseSide('strong:3000+monitor+safety2');
  assert.strictEqual(s.difficulty, 'strong');
  assert.strictEqual(s.nodeLimit, 3000);
  assert.deepStrictEqual(s.flags, ['monitor', 'safety2']);
  assert.strictEqual(PM.sideLabel(s), 'strong/3000+monitor+safety2');
  assert.strictEqual(PM.parseSide('normal:300').flags, undefined);
  assert.throws(() => PM.parseSide('strong:3000+bogus'));
  assert.throws(() => PM.parseSide('strong:3000+no-solver'));
  const d = PM.sideDiff(PM.parseSide('strong:3000+safety2+antiFork'));
  assert.strictEqual(d.safety2, true);
  assert.strictEqual(d.antiFork, true);
  assert.strictEqual(E.DIFFICULTY.strong.safety2, true, 'DIFFICULTY не должен меняться (safety2:true в strong с tochki-ab-2, #62)');
  assert.strictEqual(PM.sideDiff(PM.parseSide('strong:3000+no-safety2')).safety2, false);
}

// 2. Конфигурации S8 и их стороны.
{
  for (const n of ['base', 'full', 'no-monitor', 'no-solver', 'safety2-on', 'safety2-off'])
    assert.ok(S8.CONFIGS[n], 'нет конфигурации ' + n);
  assert.strictEqual(S8.sideSpec('base', 3000), 'strong:3000');
  assert.strictEqual(S8.sideSpec('full', 3000), 'strong:3000+monitor+safety2');
  assert.strictEqual(S8.sideSpec('no-solver', 500), 'strong:500+monitor+no-solver+safety2');
  for (const n of Object.keys(S8.CONFIGS)) PM.parseSide(S8.sideSpec(n, 100)); // все валидны
  assert.strictEqual(A.ARBITER_DEFAULTS.solver, true);
}

// 3. Флаги, совпадающие с уровнем по умолчанию, дают те же ходы, что и база
//    (детерминированный лимит узлов).
{
  const op = PM.buildOpenings(Object.assign(PM.parseArgs(['--quiet']), { pairs: 1 }))[0];
  const Runner = require('../tools/bench/runner.js');
  const m = E.createMatch(op.rules);
  Runner.applyPrefix(m, op.prefix, () => {});
  const snap = m.getSnapshot();
  const a = PM.makePlayer(PM.parseSide('strong:200'))(snap);
  const b = PM.makePlayer(PM.parseSide('strong:200+no-safety2'))(snap);
  assert.ok(a.move, 'база должна вернуть ход');
  assert.deepStrictEqual(b.move, a.move);
  // Арбитр без решателя возвращает легальный ход и решатель не вызывает.
  const c = PM.makePlayer(PM.parseSide('strong:200+monitor+no-solver'))(snap);
  assert.ok(c.move, 'арбитр без решателя должен вернуть ход');
  const node = E.createSearchNode(snap);
  assert.ok(E.isTransitionLegal(node, c.move.x, c.move.y), 'ход арбитра легален');
  const arb = c.trace && c.trace.arbiter;
  if (arb) for (const g of arb.groups) assert.strictEqual(g.saved, false);
}

// 4. Правила решения: флаг — только при ci95.lo > 0.5 и >= 50 пар; узел без прироста — удалить.
{
  const mk = (config, score, lo, pairs) => ({ config, score, ci95: { lo, hi: score + 0.05 }, better: lo > 0.5, pairs: pairs || 50 });
  const dec = S8.decide([mk('base', 0.5, 0.45), mk('full', 0.6, 0.53), mk('no-monitor', 0.5, 0.44),
    mk('no-solver', 0.62, 0.55), mk('safety2-on', 0.51, 0.49), mk('safety2-off', 0.5, 0.46)]);
  const node = n => dec.nodes.find(x => x.node === n);
  assert.strictEqual(node('монитор + решатель').keep, true);
  assert.strictEqual(node('решатель').keep, false, 'решатель без прироста удаляется');
  assert.strictEqual(node('safety2').keep, false);
  const flag = c => dec.flags.find(x => x.config === c);
  assert.strictEqual(flag('full').enableByDefault, true);
  assert.strictEqual(flag('safety2-on').enableByDefault, false);
  const few = S8.decide([mk('full', 0.7, 0.6, 10)]);
  assert.strictEqual(few.flags[0].enableByDefault, false, '10 пар — только отбор, не включать');
  assert.strictEqual(few.flags[0].status, 'confirm', '10 пар с ci95.lo > 0.5 — на подтверждение');
  // Ступенчатый протокол: 10 пар — отбор, 20 пар — подтверждение.
  const conf = S8.decide([mk('full', 0.7, 0.6, 20)]);
  assert.strictEqual(conf.flags[0].enableByDefault, true, '20 пар и ci95.lo > 0.5 — включать');
  const bad = S8.decide([{ config: 'full', score: 0.1, ci95: { lo: 0, hi: 0.2 }, better: false, pairs: 10 }]);
  assert.strictEqual(bad.flags[0].status, 'reject', 'ci95.hi < 0.5 — отбросить');
  const short = S8.decide([mk('full', 0.7, 0.6, 4)]);
  assert.strictEqual(short.flags[0].status, 'insufficient');
  assert.deepStrictEqual(conf.protocol, { screenPairs: 10, confirmPairs: 20 });
}

console.log('s8-ablation: ok');
