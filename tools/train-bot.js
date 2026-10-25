#!/usr/bin/env node
// tools/train-bot.js
//
// Офлайн self-play подбор весов оценочной функции бота (см. BOT_WEIGHTS /
// evaluateStatic в gameEngine.js). У бота нет нейросети и нет обучаемых
// параметров в духе градиентного спуска — есть только вектор весов
// (potential, cohesion, stones, liberty) внутри альфа-бета поиска.
// "Обучение на партиях" здесь означает две связанные вещи:
//
//  1. self-play — движок играет сам с собой множеством вариантов весов;
//     побеждающий вариант становится новым эталоном. Это простой (1+λ)-ES
//     (эволюционная стратегия с одним родителем и λ потомками за
//     поколение) — минимально сложный метод, который реально работает
//     для 4-параметрового вектора весов и не требует ни датасета
//     размеченных позиций, ни фреймворков машинного обучения;
//
//  2. реальные дебюты людей из БД (games/moves — независимо от того, кто
//     играл, человек или бот; важно только что партия доиграна) берутся
//     как стартовые позиции self-play партий. Без этого подбор весов
//     оценивался бы только на дебютах "бот против бота играет как ему
//     привычно" — а нас как раз интересует сила бота в позициях, которые
//     реально возникают в игре с людьми (в т.ч. попытки окружения).
//
// Запуск (из папки multiplayer/):
//   node tools/train-bot.js
//   node tools/train-bot.js --difficulty strong --generations 8 --population 6 --games 12
//   node tools/train-bot.js --db ./data/tochki.db   (по умолчанию — тот же файл, что у сервера)
//
// Пишет итоговый вектор весов в таблицу bot_weights (см. db.js/gamelog.js),
// НЕ трогая предыдущие поколения (история). server.js подхватывает новые
// веса на следующем ходе бота — перезапуск процесса не нужен (см.
// botWeightsFor() в server.js).
//
// Важно про стоимость: self-play использует Engine.TRAIN_DIFF (быстрые
// настройки поиска, см. gameEngine.js) — это специально урезанная сила
// бота ради скорости самих партий, НЕ финальная сила, с которой играют
// люди (та берётся из DIFFICULTY.normal/strong при реальной игре). Полный
// прогон с дефолтными параметрами — это задача для cron/ночного job, а не
// для "подождать 10 секунд в терминале"; смотрите --generations/--population
// /--games ниже, чтобы оценить порядок времени под вашу машину.

const Engine = require('../gameEngine.js');
const { openDatabase } = require('../db.js');
const { createGameLog } = require('../gamelog.js');

function parseArgs(argv){
  const out = {
    difficulty: 'strong', generations: 4, population: 4, games: 8,
    dbPath: undefined, sizeKey: 'medium', seed: Date.now() >>> 0,
    // undefined = поведение по умолчанию (targetFillPercent реальной партии,
    // если есть дебют из БД, иначе 35 — см. playSelfPlayGame). Если задан
    // явно через --fill-percent, self-play партии ВСЕГДА играются до этого
    // процента заполнения поля, независимо от того, какой был у дебюта.
    fillPercent: undefined
  };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--difficulty') out.difficulty = val();
    else if (a === '--generations') out.generations = parseInt(val(), 10);
    else if (a === '--population') out.population = parseInt(val(), 10);
    else if (a === '--games') out.games = parseInt(val(), 10);
    else if (a === '--db') out.dbPath = val();
    else if (a === '--size') out.sizeKey = val();
    else if (a === '--seed') out.seed = parseInt(val(), 10) >>> 0;
    else if (a === '--fill-percent') out.fillPercent = parseInt(val(), 10);
    else if (a === '--out') out.out = val();
  }
  return out;
}

// B05: счётчики для отчёта кандидата — отклонённые (невалидные) дебюты и
// партии, обрезанные по лимиту ходов, учитываются отдельно, а не молча.
const openingStats = { rejected: 0, rejectedReasons: [] };
const gameStats = { truncated: 0 };

// Небольшой детерминированный ГПСЧ (xorshift32) — чтобы прогон с тем же
// --seed был воспроизводим: та же выборка дебютов, те же случайные веса.
// Math.random() для этого не подходит (не параметризуется сидом).
function makeRng(seed){
  let s = (seed >>> 0) || 1;
  return function(){
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

const WEIGHT_KEYS = ['potential', 'cohesion', 'stones', 'liberty'];
// Границы не дают подбору уйти в абсурдные значения — например,
// отрицательный liberty означал бы «поощрять собственное окружение».
const WEIGHT_BOUNDS = {
  potential: [1, 16],
  cohesion:  [0.1, 5],
  stones:    [0, 1],
  liberty:   [0, 20]
};

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

function mutate(weights, rng, strength){
  const out = {};
  for (const k of WEIGHT_KEYS){
    const [lo, hi] = WEIGHT_BOUNDS[k];
    const span = hi - lo;
    const delta = (rng() * 2 - 1) * span * strength;
    out[k] = Math.round(clamp((weights[k] ?? (lo + hi) / 2) + delta, lo, hi) * 100) / 100;
  }
  return out;
}

// ---------- Дебюты людей из лога партий ----------

function loadOpenings(gameLog, sizeKey, maxPrefixLen){
  const games = gameLog.getFinishedGamesForTraining({ limit: 500 });
  const openings = [];
  for (const { game, replay } of games){
    if (game.size_key !== sizeKey || !replay || !replay.exact) continue;
    // Never guess missing legacy rules or use the append-only moves table:
    // it contains cancelled moves. Validate the entire source first.
    let source;
    try { source = require('../replay.js').play(replay.data); }
    catch (e) { rejectOpening(`game ${game.id}: replay invalid: ${e.message}`); continue; }
    const moves = source.getMoveLog();
    if (!moves.length) { rejectOpening(`game ${game.id}: empty move log`); continue; }
    const prefixLen = Math.min(maxPrefixLen, moves.length);
    const prefix = moves.slice(0, prefixLen).map(m => ({ x: m.x, y: m.y, seat: m.p }));
    const opening = { prefix, ...source.getSnapshot().rules };
    const err = validateOpening(sizeKey, opening);
    if (err) { rejectOpening(`game ${game.id}: ${err}`); continue; }
    openings.push(opening);
  }
  return openings;
}

function rejectOpening(reason){
  openingStats.rejected++;
  if (openingStats.rejectedReasons.length < 50) openingStats.rejectedReasons.push(reason);
  console.warn('Дебют отклонён: ' + reason);
}

// B05: строгая проверка префикса тем же правилом, что в benchmark
// (Runner.applyPrefix): любой нелегальный ход или конец партии внутри
// префикса — отказ с причиной. Возвращает null или текст ошибки.
function validateOpening(sizeKey, opening){
  try {
    const Runner = require('./bench/runner.js');
    const m = Engine.createMatch({ sizeKey, targetScore: opening.targetScore || 0,
      targetFillPercent: opening.targetFillPercent, firstPlayer: opening.firstPlayer || 1,
      extraTurnOnCapture: opening.extraTurnOnCapture === true, undoAllowed: opening.undoAllowed !== false });
    Runner.applyPrefix(m, opening.prefix, () => {});
    return null;
  } catch (e){ return e.message; }
}

// B05: дебюты ТОЛЬКО из train-набора версионированного корпуса
// (validation/test зарезервированы под отбор/публикацию в benchmark).
function loadCorpusTrainOpenings(corpusPath, sizeKey){
  const corpus = JSON.parse(require('fs').readFileSync(corpusPath, 'utf8'));
  const list = ((corpus.openings || {})[sizeKey] || {}).train || [];
  const out = [];
  for (const o of list){
    const opening = { prefix: o.prefix, targetScore: o.rules.targetScore, targetFillPercent: o.rules.targetFillPercent,
      firstPlayer: o.rules.firstPlayer, extraTurnOnCapture: o.rules.extraTurnOnCapture, undoAllowed: o.rules.undoAllowed };
    const err = validateOpening(sizeKey, opening);
    if (err) { rejectOpening(`${o.id}: ${err}`); continue; }
    out.push(opening);
  }
  return out;
}

// B05: пул замороженных соперников (baseline + pool из weights.v1.json).
function loadFrozenPool(baselinePath){
  const b = JSON.parse(require('fs').readFileSync(baselinePath, 'utf8'));
  return [{ id: 'baseline', weights: b.weights }].concat(b.pool || []);
}

// ---------- Одна self-play партия между двумя наборами весов ----------

// Диагностика поиска (A04, issue #9):
//   --node-limit N        детерминированный лимит узлов на ход (таймер
//                         TRAIN_DIFF.timeLimit тогда отключён, остаётся только
//                         аварийный --emergency-ms, если задан);
//   --emergency-ms M      аварийный таймер на ход при --node-limit;
//   --trace               печатать trace каждого хода (JSON-строка в stderr).
function parseSearchFlags(argv){
  const out = { nodeLimit: undefined, emergencyTimeLimit: undefined, trace: false };
  for (let i = 0; i < argv.length; i++){
    if (argv[i] === '--node-limit') out.nodeLimit = parseInt(argv[++i], 10);
    else if (argv[i] === '--emergency-ms') out.emergencyTimeLimit = parseInt(argv[++i], 10);
    else if (argv[i] === '--trace') out.trace = true;
  }
  return out;
}
const SEARCH_CLI = parseSearchFlags(process.argv.slice(2));

function pickMove(match, weights){
  const snap = match.getSnapshot();
  // getSnapshot() уже отдаёт свежие копии stone/dead/territory (см.
  // createMatch в gameEngine.js) — этого достаточно для поиска, ему не
  // нужны внутренние поля матча.
  const state = { stone: snap.stone, dead: snap.dead, territory: snap.territory };
  // Полные правила матча (пороги, доп. ход, дебютная зона по
  // stonesPlacedTotal, конец партии) — snapshot подходит как ctx напрямую.
  const opts = Object.assign({}, snap);
  if (SEARCH_CLI.nodeLimit > 0) opts.nodeLimit = SEARCH_CLI.nodeLimit;
  if (SEARCH_CLI.emergencyTimeLimit > 0) opts.emergencyTimeLimit = SEARCH_CLI.emergencyTimeLimit;
  const r = Engine.searchMove(state, snap.rows, snap.cols, snap.current, Engine.TRAIN_DIFF, weights, opts);
  if (SEARCH_CLI.trace) process.stderr.write(JSON.stringify({ trace: r.trace }) + '\n');
  return r.move;
}

// weightsBySeat: {1: weights, 2: weights}. Возвращает 1, 2 или 0 (ничья).
// fillPercentOverride — если задан (см. --fill-percent), игнорирует и
// targetFillPercent реального дебюта, и дефолт 35 — self-play партия всегда
// идёт до этого процента заполнения поля.
function playSelfPlayGame(sizeKey, opening, weightsBySeat, maxMoves, fillPercentOverride){
  const targetFillPercent = fillPercentOverride != null
    ? fillPercentOverride
    : (opening ? opening.targetFillPercent : 35);
  const match = Engine.createMatch({
    sizeKey,
    targetScore: opening ? opening.targetScore : 0,
    targetFillPercent,
    firstPlayer: opening ? opening.firstPlayer : 1,
    extraTurnOnCapture: opening ? opening.extraTurnOnCapture : false,
    undoAllowed: opening ? opening.undoAllowed : true
  });

  if (opening){
    for (const mv of opening.prefix){
      const res = match.applyMove(mv.seat, mv.x, mv.y);
      // B05 (issue #28): невалидный префикс больше НЕ пропускается молча
      // (раньше был break и доигрывание с середины). Дебюты проверяются
      // при загрузке (loadOpenings), здесь — защитная явная ошибка.
      if (!res.ok) throw new Error(`invalid opening prefix move: ${res.reason}`);
      if (res.gameOver) throw new Error('opening prefix ends the game');
    }
  }

  let moves = 0;
  while (moves < maxMoves){
    const snap = match.getSnapshot();
    if (snap.gameOver) break;
    const weights = weightsBySeat[snap.current];
    const move = pickMove(match, weights);
    if (!move) break; // нет легальных ходов — доска заполнена
    const res = match.applyMove(snap.current, move.x, move.y);
    if (!res.ok) break; // защитная проверка, по правилам не должно случаться
    moves++;
    if (res.gameOver) break;
  }
  // B05: партия, упершаяся в лимит ходов, — обрезанная; считаем отдельно.
  if (moves >= maxMoves && !match.getSnapshot().gameOver) gameStats.truncated++;
  const finalSnap = match.getSnapshot();
  const s1 = finalSnap.scores[1], s2 = finalSnap.scores[2];
  return s1 > s2 ? 1 : (s2 > s1 ? 2 : 0);
}

// Играем `games` партий кандидата против эталона, меняя местами места 1/2
// через раз — иначе один из наборов весов систематически получал бы
// преимущество/недостаток первого хода (право первого хода в этой игре
// значимо, как и в го).
function contest(sizeKey, openings, incumbent, candidate, games, rng, fillPercentOverride){
  let candidateWins = 0, incumbentWins = 0, draws = 0;
  for (let i = 0; i < games; i++){
    const opening = openings.length ? openings[Math.floor(rng() * openings.length)] : null;
    const candidateSeat = (i % 2) + 1;
    const weightsBySeat = candidateSeat === 1
      ? { 1: candidate, 2: incumbent }
      : { 1: incumbent, 2: candidate };
    const winner = playSelfPlayGame(sizeKey, opening, weightsBySeat, 260, fillPercentOverride);
    if (winner === 0) draws++;
    else if (winner === candidateSeat) candidateWins++;
    else incumbentWins++;
  }
  return { candidateWins, incumbentWins, draws, winRate: (candidateWins + draws * 0.5) / games };
}

function main(){
  const args = parseArgs(process.argv.slice(2));
  const rng = makeRng(args.seed);

  // Без --db открывает тот же файл, что и сервер по умолчанию (см.
  // DB_PATH / data/tochki.db в db.js) — тренируемся на реальном
  // накопленном логе партий этого же деплоя.
  const db = openDatabase(args.dbPath);
  const gameLog = createGameLog(db);

  const openings = loadOpenings(gameLog, args.sizeKey, 6);
  console.log(`Дебютов из БД для sizeKey=${args.sizeKey}: ${openings.length}` +
    (openings.length ? '' : ' (нет подходящих доигранных партий — self-play стартует с пустой доски)'));

  let incumbent = gameLog.getCurrentBotWeights(args.difficulty) || { ...Engine.BOT_WEIGHTS };
  let incumbentLabel = 'стартовые (БД или дефолт из движка)';
  console.log('Стартовые веса:', incumbent);
  console.log(args.fillPercent != null
    ? `Условие окончания self-play партий: заполнение поля ${args.fillPercent}% (переопределено --fill-percent, дебюты игнорируются в части этого правила)`
    : 'Условие окончания self-play партий: targetFillPercent реального дебюта, либо 35% по умолчанию');

  let totalGamesPlayed = 0;
  let lastWinRate = null;

  for (let gen = 1; gen <= args.generations; gen++){
    // Сила мутации затухает от поколения к поколению — сперва грубый
    // поиск по всему диапазону, затем всё более тонкая подстройка вокруг
    // текущего эталона.
    const strength = Math.max(0.08, 0.35 * (1 - gen / (args.generations + 1)));
    let bestCandidate = null, bestResult = null;

    for (let p = 0; p < args.population; p++){
      const candidate = mutate(incumbent, rng, strength);
      const result = contest(args.sizeKey, openings, incumbent, candidate, args.games, rng, args.fillPercent);
      totalGamesPlayed += args.games;
      console.log(
        `  поколение ${gen}, кандидат ${p + 1}/${args.population}: ` +
        `winRate=${result.winRate.toFixed(2)} (${result.candidateWins}W/${result.incumbentWins}L/${result.draws}D)` +
        ` weights=${JSON.stringify(candidate)}`
      );
      if (!bestResult || result.winRate > bestResult.winRate){
        bestResult = result;
        bestCandidate = candidate;
      }
    }

    // Порог 0.55, а не 0.5 — партии self-play короткие и играются на
    // урезанном TRAIN_DIFF, поэтому в разнице 0.50-0.55 больше шума, чем
    // сигнала; принимаем эталон только при заметном перевесе.
    if (bestResult.winRate > 0.55){
      incumbent = bestCandidate;
      lastWinRate = bestResult.winRate;
      incumbentLabel = `поколение ${gen}`;
      console.log(`  -> новый эталон (${incumbentLabel}), winRate=${bestResult.winRate.toFixed(2)}`);
    } else {
      console.log(`  -> поколение ${gen} не улучшило эталон (лучший winRate=${bestResult.winRate.toFixed(2)})`);
    }
  }

  console.log('\nИтоговые веса:', incumbent);
  // B05 (issue #28): результат отбора на обучающих партиях НЕ публикуется.
  // Пишем файл-кандидат со связкой «веса + правила + код»; в bot_weights
  // веса попадают только через tools/publish-weights.js по отчёту
  // независимого парного benchmark на test-наборе.
  const candidate = {
    format: 'tochki-weights-candidate', version: 1,
    difficulty: args.difficulty, weights: incumbent,
    bundle: {
      engineVersion: Engine.ENGINE_VERSION, botVersion: Engine.BOT_VERSION,
      baseWeightsVersion: Engine.WEIGHTS_VERSION, commit: codeCommit(),
      selection: { method: '(1+λ)-ES self-play', split: 'train', sizeKey: args.sizeKey,
        seed: args.seed, generations: args.generations, population: args.population,
        games: args.games, fillPercent: args.fillPercent ?? null, nodeLimit: SEARCH_CLI.nodeLimit ?? null,
        openings: openings.length, rejectedOpenings: openingStats.rejected,
        gamesPlayed: totalGamesPlayed, truncatedGames: gameStats.truncated, lastWinRate, label: incumbentLabel }
    },
    createdAt: new Date().toISOString()
  };
  const outPath = args.out || require('path').join(process.cwd(), `weights-candidate-${args.difficulty}-${args.seed}.json`);
  require('fs').writeFileSync(outPath, JSON.stringify(candidate, null, 2));
  console.log(`Обрезанных партий (лимит ходов): ${gameStats.truncated} из ${totalGamesPlayed}; отклонённых дебютов: ${openingStats.rejected}`);
  console.log(`Кандидат сохранён: ${outPath}. В бой НЕ опубликован — проверьте benchmark на test и используйте tools/publish-weights.js (docs/B05_WEIGHTS.md).`);

  db.close();
}

function codeCommit(){
  try { return require('child_process').execSync('git rev-parse HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (_){ return null; }
}

// Только когда файл запущен напрямую (node tools/train-bot.js) — не когда
// server.js делает require('./tools/train-bot.js') для переиспользования
// contest()/loadOpenings() в /api/admin/selfplay-eval (см. server.js).
if (require.main === module){
  main();
}

module.exports = {
  parseArgs, makeRng, mutate, loadOpenings, playSelfPlayGame, contest,
  WEIGHT_KEYS, WEIGHT_BOUNDS
};
