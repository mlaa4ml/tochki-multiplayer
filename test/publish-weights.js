// B05 (issue #28): публикация весов только по заранее выбранному критерию
// (test-benchmark, нижняя граница 95% CI против baseline > 0.5, ноль ошибок
// корректности) и проверка отката на предыдущую версию.
const assert = require('assert');
const Engine = require('../gameEngine.js');
const { openDatabase } = require('../db.js');
const { createGameLog } = require('../gamelog.js');
const P = require('../tools/publish-weights.js');

const W1 = { potential: 7, cohesion: 1.1, stones: 0.2, liberty: 6 };
const W2 = { potential: 8, cohesion: 1.0, stones: 0.25, liberty: 7 };

function candidate(weights){
  return { format: 'tochki-weights-candidate', version: 1, difficulty: 'strong', weights,
    bundle: { engineVersion: Engine.ENGINE_VERSION, botVersion: Engine.BOT_VERSION, selection: { split: 'train' } } };
}
function report(weights, over){
  over = over || {};
  return {
    format: 'tochki-bench-report', createdAt: new Date().toISOString(),
    code: { commit: 'test', engineVersion: Engine.ENGINE_VERSION, botVersion: Engine.BOT_VERSION },
    corpus: { version: 1, seed: 1, split: over.split || 'test' },
    params: { difficulties: ['strong'] },
    candidate: { id: 'cand', weights },
    vsBaseline: { pairs: 24, clusters: 12, score: 0.62, ci95: { lo: over.lo == null ? 0.53 : over.lo, hi: 0.7 } },
    acceptance: { correctnessErrors: over.errors == null ? 0 : over.errors }
  };
}

function main(){
  // --- критерий ---
  assert.ok(P.checkReport(report(W1), candidate(W1)).ok);
  assert.ok(!P.checkReport(report(W1, { lo: 0.5 }), candidate(W1)).ok, 'lo = 0.5 не проходит');
  assert.ok(!P.checkReport(report(W1, { lo: 0.45 }), candidate(W1)).ok);
  assert.ok(!P.checkReport(report(W1, { split: 'validation' }), candidate(W1)).ok, 'только test');
  assert.ok(!P.checkReport(report(W1, { errors: 1 }), candidate(W1)).ok, 'ошибки корректности');
  assert.ok(!P.checkReport(report(W2), candidate(W1)).ok, 'отчёт о других весах');
  console.log('OK: критерий публикации проверяется заранее и строго');

  const db = openDatabase(':memory:');
  const gameLog = createGameLog(db);
  try {
    // отказ ничего не пишет
    assert.throws(() => P.publish(db, gameLog, candidate(W1), report(W1, { lo: 0.4 })), /отклонена/);
    assert.strictEqual(gameLog.getCurrentBotWeights('strong'), null);
    // откат без публикаций невозможен
    assert.throws(() => P.rollback(db, gameLog, 'strong'), /откатывать нечего/);

    // публикация 1 и 2
    P.publish(db, gameLog, candidate(W1), report(W1));
    let cur = gameLog.getCurrentBotWeights('strong');
    assert.strictEqual(cur.potential, W1.potential);
    assert.strictEqual(cur.meta.source, 'published');
    P.publish(db, gameLog, candidate(W2), report(W2));
    cur = gameLog.getCurrentBotWeights('strong');
    assert.strictEqual(cur.potential, W2.potential);
    console.log('OK: публикация при выполненном критерии, версия хранит предыдущую');

    // откат W2 -> W1 -> веса движка
    P.rollback(db, gameLog, 'strong');
    cur = gameLog.getCurrentBotWeights('strong');
    assert.deepStrictEqual({ potential: cur.potential, cohesion: cur.cohesion, stones: cur.stones, liberty: cur.liberty }, W1);
    assert.strictEqual(cur.meta.source, 'rollback');
    P.rollback(db, gameLog, 'strong');
    cur = gameLog.getCurrentBotWeights('strong');
    assert.strictEqual(cur.potential, Engine.BOT_WEIGHTS.potential);
    assert.strictEqual(cur.liberty, Engine.BOT_WEIGHTS.liberty);
    console.log('OK: откат на предыдущую версию и далее на веса движка');
  } finally { db.close(); }
  console.log('\nALL PUBLISH-WEIGHTS CHECKS PASSED');
}

try { main(); } catch (err){ console.error('TEST FAILED:', err); process.exitCode = 1; }
