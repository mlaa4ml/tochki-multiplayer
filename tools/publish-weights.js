#!/usr/bin/env node
// tools/publish-weights.js
//
// B05 (issue #28): ЕДИНСТВЕННЫЙ путь, которым веса попадают в бой
// (таблица bot_weights, её читает server.js). tools/train-bot.js больше не
// пишет в БД: он сохраняет файл-кандидат. Публикация разрешена только по
// отчёту независимого парного benchmark (tools/bench/benchmark.js) на
// test-наборе и только при заранее выбранном критерии:
//
//   нижняя граница 95% интервала (кластерный bootstrap по парам/дебютам)
//   счёта кандидата против baseline > 0.5 И ноль ошибок корректности.
//
// Каждая публикация хранит в note связку «веса + правила + код» и
// предыдущую активную версию — `--rollback` возвращает её.
//
// Команды:
//   node tools/publish-weights.js --candidate cand.json --report test-report.json [--db path]
//   node tools/publish-weights.js --rollback --difficulty strong [--db path]
//   node tools/publish-weights.js --status --difficulty strong [--db path]
// Подробности: docs/B05_WEIGHTS.md.

const fs = require('fs');
const Engine = require('../gameEngine.js');

const WEIGHT_KEYS = ['potential', 'cohesion', 'stones', 'liberty'];
const CRITERION = 'vsBaseline.ci95.lo > 0.5 on split=test, correctnessErrors = 0';

function sameWeights(a, b){
  if (!a || !b) return false;
  return WEIGHT_KEYS.every(k => typeof a[k] === 'number' && Math.abs(a[k] - b[k]) < 1e-9);
}

// Проверка отчёта benchmark против кандидата. Возвращает { ok, reasons[] }.
function checkReport(report, candidate){
  const reasons = [];
  if (!report || report.format !== 'tochki-bench-report') reasons.push('отчёт не в формате tochki-bench-report');
  if (!candidate || candidate.format !== 'tochki-weights-candidate') reasons.push('кандидат не в формате tochki-weights-candidate');
  if (reasons.length) return { ok: false, reasons };
  if (!report.corpus || report.corpus.split !== 'test') reasons.push(`отчёт сделан на split=${report.corpus && report.corpus.split}, нужен test`);
  const cw = report.candidate && report.candidate.weights;
  if (!sameWeights(cw, candidate.weights)) reasons.push('веса в отчёте не совпадают с весами кандидата');
  const lo = report.vsBaseline && report.vsBaseline.ci95 ? report.vsBaseline.ci95.lo : null;
  if (typeof lo !== 'number') reasons.push('в отчёте нет интервала против baseline');
  else if (!(lo > 0.5)) reasons.push(`нижняя граница 95% CI против baseline = ${lo.toFixed(3)} <= 0.5`);
  const errs = report.acceptance ? report.acceptance.correctnessErrors : undefined;
  if (errs !== 0) reasons.push(`ошибок корректности в отчёте: ${errs}`);
  const code = report.code || {};
  if (code.engineVersion !== Engine.ENGINE_VERSION) reasons.push(`отчёт для движка ${code.engineVersion}, текущий ${Engine.ENGINE_VERSION}`);
  if (code.botVersion !== Engine.BOT_VERSION) reasons.push(`отчёт для бота ${code.botVersion}, текущий ${Engine.BOT_VERSION}`);
  const b = candidate.bundle || {};
  if (b.engineVersion && b.engineVersion !== Engine.ENGINE_VERSION) reasons.push(`кандидат подобран на движке ${b.engineVersion}`);
  if (candidate.difficulty && report.params && Array.isArray(report.params.difficulties) &&
      !report.params.difficulties.includes(candidate.difficulty)) {
    reasons.push(`отчёт не содержит сложности ${candidate.difficulty}`);
  }
  return { ok: reasons.length === 0, reasons };
}

function latestRow(db, difficulty){
  return db.prepare(`SELECT id, potential, cohesion, stones, liberty, source, note, created_at
    FROM bot_weights WHERE difficulty = ? ORDER BY id DESC LIMIT 1`).get(difficulty) || null;
}
function rowWeights(row){
  return row ? { potential: row.potential, cohesion: row.cohesion, stones: row.stones, liberty: row.liberty } : null;
}
function parseNote(row){
  if (!row || !row.note) return null;
  try { const n = JSON.parse(row.note); return n && n.format === 'tochki-weights-publication' ? n : null; }
  catch (_){ return null; }
}

// Публикует кандидата. Бросает Error, если критерий не выполнен.
function publish(db, gameLog, candidate, report){
  const chk = checkReport(report, candidate);
  if (!chk.ok) throw new Error('публикация отклонена:\n - ' + chk.reasons.join('\n - '));
  const difficulty = candidate.difficulty;
  const prevRow = latestRow(db, difficulty);
  const previous = prevRow
    ? { id: prevRow.id, weights: rowWeights(prevRow), source: prevRow.source }
    : { id: null, weights: { ...Engine.BOT_WEIGHTS }, source: 'engine-default' };
  const note = {
    format: 'tochki-weights-publication', version: 1, action: 'publish', criterion: CRITERION,
    bundle: Object.assign({}, candidate.bundle, {
      engineVersion: Engine.ENGINE_VERSION, botVersion: Engine.BOT_VERSION,
      reportCommit: report.code && report.code.commit || null
    }),
    test: { corpus: report.corpus, vsBaseline: report.vsBaseline, createdAt: report.createdAt },
    previous
  };
  gameLog.saveBotWeights(difficulty, candidate.weights, {
    source: 'published', winRate: report.vsBaseline.score,
    gamesPlayed: report.vsBaseline.pairs * 2, note: JSON.stringify(note)
  });
  return { difficulty, weights: candidate.weights, previous };
}

// Откат: снова делает активной версию, сохранённую в note текущей публикации.
function rollback(db, gameLog, difficulty){
  const cur = latestRow(db, difficulty);
  if (!cur) throw new Error(`для ${difficulty} нет опубликованных весов — откатывать нечего (действуют веса движка)`);
  const n = parseNote(cur);
  if (!n || !n.previous || !n.previous.weights) throw new Error(`текущая запись #${cur.id} не содержит предыдущей версии — откат невозможен`);
  // previous самой предыдущей записи (если она была публикацией) переносим,
  // чтобы повторный --rollback уходил дальше в историю, а не «качался».
  let prevPrev = null;
  if (n.previous.id != null){
    const pr = db.prepare(`SELECT id, note FROM bot_weights WHERE id = ?`).get(n.previous.id);
    const pn = parseNote(pr);
    prevPrev = pn ? pn.previous : null;
  }
  const note = { format: 'tochki-weights-publication', version: 1, action: 'rollback',
    rolledBackFrom: { id: cur.id, weights: rowWeights(cur) }, restored: n.previous,
    bundle: n.previous.id != null && n.previous.source !== 'engine-default' ? undefined : { engineVersion: Engine.ENGINE_VERSION },
    previous: prevPrev || { id: null, weights: { ...Engine.BOT_WEIGHTS }, source: 'engine-default' } };
  gameLog.saveBotWeights(difficulty, n.previous.weights, { source: 'rollback', note: JSON.stringify(note) });
  return { difficulty, restored: n.previous, from: cur.id };
}

function parseArgs(argv){
  const o = { difficulty: undefined, dbPath: undefined };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i], v = () => argv[++i];
    if (a === '--candidate') o.candidate = v();
    else if (a === '--report') o.report = v();
    else if (a === '--rollback') o.rollback = true;
    else if (a === '--status') o.status = true;
    else if (a === '--check') o.check = true;
    else if (a === '--difficulty') o.difficulty = v();
    else if (a === '--db') o.dbPath = v();
  }
  return o;
}

function main(){
  const args = parseArgs(process.argv.slice(2));
  const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  if (args.check){
    const chk = checkReport(readJson(args.report), readJson(args.candidate));
    console.log(chk.ok ? 'критерий выполнен' : 'критерий НЕ выполнен:\n - ' + chk.reasons.join('\n - '));
    process.exit(chk.ok ? 0 : 1);
  }
  const { openDatabase } = require('../db.js');
  const { createGameLog } = require('../gamelog.js');
  const db = openDatabase(args.dbPath);
  const gameLog = createGameLog(db);
  try {
    if (args.status){
      const row = latestRow(db, args.difficulty || 'strong');
      console.log(row ? JSON.stringify({ id: row.id, source: row.source, weights: rowWeights(row), note: parseNote(row) }, null, 2)
        : 'нет записей — действуют веса движка: ' + JSON.stringify(Engine.BOT_WEIGHTS));
    } else if (args.rollback){
      const r = rollback(db, gameLog, args.difficulty || 'strong');
      console.log(`Откат ${r.difficulty}: запись #${r.from} -> ${JSON.stringify(r.restored.weights)} (${r.restored.source})`);
    } else {
      if (!args.candidate || !args.report) throw new Error('нужны --candidate и --report (или --rollback/--status)');
      const r = publish(db, gameLog, readJson(args.candidate), readJson(args.report));
      console.log(`Опубликовано ${r.difficulty}: ${JSON.stringify(r.weights)}; предыдущая версия: ${JSON.stringify(r.previous.weights)}`);
    }
  } catch (e){
    console.error(e.message); process.exitCode = 1;
  } finally { db.close(); }
}

if (require.main === module) main();

module.exports = { checkReport, publish, rollback, sameWeights, parseNote, CRITERION };
