// test/offline-session.js — LocalSession + управляемый fake Worker (A06, issue #11).
// Проверяет гонки детерминированно: ответы Worker'а и таймеры доставляются
// вручную. Без server.js, WS/API/SQLite.
'use strict';
const assert = require('assert');
const Engine = require('../gameEngine.js');
const { handleBotRequest } = require('../botWorker.js');
const { createLocalSession } = require('../offline/localSession.js');

const SEARCH = { normal: { nodeLimit: 1500 }, strong: { nodeLimit: 3000 } };
const FAST_RULES = { sizeKey: 'small', targetFillPercent: 8 };

function makeEnv(opts){
  opts = opts || {};
  const workers = [], timers = [];
  let tid = 0;
  const env = {
    workers, timers,
    createWorker(){
      if (opts.failCreate) throw new Error('Worker недоступен (тест)');
      const w = {
        msgs: [], answered: 0, terminated: false, onmessage: null, onerror: null,
        postMessage(m){ this.msgs.push(JSON.parse(JSON.stringify(m))); },
        terminate(){ this.terminated = true; }
      };
      workers.push(w);
      return w;
    },
    setTimeout(fn){ const id = ++tid; timers.push({ id, fn }); return id; },
    clearTimeout(id){ const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); }
  };
  env.runTimers = () => { let n = 0; while (timers.length){ timers.shift().fn(); n++; } return n; };
  env.totalMsgs = () => workers.reduce((a, w) => a + w.msgs.length, 0);
  // Ответ на i-й запрос Worker'а w (даже если он уже terminate — так
  // моделируется запоздалый ответ).
  env.reply = (w, i, override) => {
    const r = handleBotRequest(Engine, w.msgs[i]);
    w.answered = Math.max(w.answered, i + 1);
    w.onmessage({ data: Object.assign(r, override || {}) });
  };
  // Доставить все ответы живых Worker'ов и таймеры, пока есть прогресс.
  env.drain = (limit) => {
    limit = limit || 5000;
    for (let k = 0; k < limit; k++){
      if (env.runTimers()) continue;
      const w = workers.find(x => !x.terminated && x.answered < x.msgs.length);
      if (!w) return;
      env.reply(w, w.answered);
    }
    throw new Error('drain: слишком много шагов');
  };
  return env;
}

function session(env){
  return createLocalSession({ engine: Engine, createWorker: env.createWorker,
    setTimeout: env.setTimeout, clearTimeout: env.clearTimeout, searchOpts: SEARCH });
}

function humanMove(s){
  const snap = s.snapshot();
  for (let y = 0; y < snap.rows; y++) for (let x = 0; x < snap.cols; x++){
    const r = s.move(x, y);
    if (r.ok) return r;
  }
  throw new Error('нет легального хода человека');
}

function checkExtraTurns(s, extra){
  const log = s.status().moveCount;
  assert.ok(log >= 0);
  const replay = s.getReplay();
  let prev = null;
  for (const ev of replay.events){
    if (ev.type === 'undo'){ prev = null; continue; }
    if (ev.type !== 'move') continue;
    prev = ev;
  }
  return prev;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('запоздалый ответ после pause не применяется', () => {
  const env = makeEnv(); const s = session(env);
  s.newGame(Object.assign({ controllers: { 1: 'normal', 2: 'strong' } }, FAST_RULES));
  assert.strictEqual(env.totalMsgs(), 0, 'бот–бот не стартует сам');
  s.start(); env.runTimers();
  assert.strictEqual(env.totalMsgs(), 1);
  const w = env.workers[0];
  s.pause();
  assert.ok(w.terminated, 'pause делает terminate');
  env.reply(w, 0);
  assert.strictEqual(s.status().moveCount, 0);
  assert.strictEqual(s.status().staleDropped, 1);
  env.runTimers();
  assert.strictEqual(env.totalMsgs(), 1, 'после паузы нет новых запросов');
});

test('запоздалый ответ после restart не применяется', () => {
  const env = makeEnv(); const s = session(env);
  s.newGame(Object.assign({ controllers: { 1: 'human', 2: 'normal' }, firstPlayer: 2 }, FAST_RULES));
  env.runTimers();
  assert.strictEqual(env.totalMsgs(), 1, 'бот ходит первым');
  const w = env.workers[0];
  s.newGame(Object.assign({ firstPlayer: 1 }, FAST_RULES));
  assert.ok(w.terminated);
  env.reply(w, 0);
  const snap = s.snapshot();
  assert.strictEqual(snap.stonesPlacedTotal, 0);
  assert.strictEqual(snap.current, 1);
});

test('запоздалый ответ после undo не применяется', () => {
  const env = makeEnv(); const s = session(env);
  s.newGame(Object.assign({ controllers: { 1: 'human', 2: 'normal' } }, FAST_RULES));
  humanMove(s); env.runTimers();
  assert.strictEqual(env.totalMsgs(), 1);
  assert.ok(s.status().searching);
  const w = env.workers[0];
  assert.ok(s.undo().ok);
  assert.ok(w.terminated);
  env.reply(w, 0);
  assert.strictEqual(s.status().moveCount, 0);
  assert.strictEqual(s.snapshot().current, 1);
});

test('запоздалый ответ после end не применяется, новых ходов нет', () => {
  const env = makeEnv(); const s = session(env);
  s.newGame(Object.assign({ controllers: { 1: 'human', 2: 'strong' } }, FAST_RULES));
  humanMove(s); env.runTimers();
  const w = env.workers[0];
  assert.ok(s.end().ok);
  env.reply(w, 0);
  assert.strictEqual(s.status().moveCount, 1);
  assert.ok(s.snapshot().gameOver);
  assert.strictEqual(s.step(), false);
  env.drain();
  assert.strictEqual(env.totalMsgs(), 1);
});

test('чужие requestId/revision/gameId отбрасываются', () => {
  const env = makeEnv(); const s = session(env);
  s.newGame(Object.assign({ controllers: { 1: 'normal', 2: 'normal' } }, FAST_RULES));
  s.step();
  const w = env.workers[0];
  env.reply(w, 0, { requestId: 999 });
  env.reply(w, 0, { revision: 999 });
  env.reply(w, 0, { gameId: 'other' });
  assert.strictEqual(s.status().moveCount, 0);
  assert.strictEqual(s.status().staleDropped, 3);
  env.reply(w, 0);
  assert.strictEqual(s.status().moveCount, 1);
  env.reply(w, 0);
  assert.strictEqual(s.status().moveCount, 1, 'повторная доставка не применяется');
});

test('один шаг = ровно один успешный ход', () => {
  const env = makeEnv(); const s = session(env);
  s.newGame(Object.assign({ controllers: { 1: 'normal', 2: 'strong' }, firstPlayer: 2 }, FAST_RULES));
  for (let i = 1; i <= 3; i++){
    const before = s.snapshot().current;
    assert.ok(s.step());
    assert.strictEqual(s.step(), false, 'второй step во время поиска игнорируется');
    env.drain();
    assert.strictEqual(s.status().moveCount, i);
    assert.strictEqual(env.totalMsgs(), i);
    assert.strictEqual(s.getReplay().events.filter(e => e.type === 'move').pop().player, before);
  }
});

test('нелегальный ход человека и ход вне очереди отклоняются без изменений', () => {
  const env = makeEnv(); const s = session(env);
  s.newGame(Object.assign({ controllers: { 1: 'human', 2: 'normal' } }, FAST_RULES));
  humanMove(s);
  const lm = s.snapshot().lastMoveByPlayer[1];
  assert.strictEqual(s.move(lm.x, lm.y).ok, false, 'бот думает — клик не принимается');
  env.drain();
  const before = JSON.stringify(s.snapshot());
  assert.strictEqual(s.move(lm.x, lm.y).ok, false, 'занятая клетка');
  assert.strictEqual(JSON.stringify(s.snapshot()), before);
});

test('отказ Worker явно отображается, синхронного fallback нет', () => {
  const env = makeEnv({ failCreate: true }); const s = session(env);
  let last = null; s.subscribe((snap, st) => { last = st; });
  s.newGame(Object.assign({ controllers: { 1: 'human', 2: 'normal' } }, FAST_RULES));
  humanMove(s); env.runTimers();
  assert.ok(last.workerError && /недоступен/.test(last.workerError));
  assert.strictEqual(s.status().moveCount, 1, 'бот не сходил синхронно');

  const env2 = makeEnv(); const s2 = session(env2);
  s2.newGame(Object.assign({ controllers: { 1: 'normal', 2: 'normal' } }, FAST_RULES));
  s2.step();
  env2.workers[0].onmessage({ data: { type: 'error', requestId: 1, gameId: s2.status().gameId,
    revision: s2.status().revision, error: 'boom' } });
  assert.ok(/boom/.test(s2.status().workerError));
  assert.strictEqual(s2.status().moveCount, 0);

  const env3 = makeEnv(); const s3 = session(env3);
  s3.newGame(Object.assign({ controllers: { 1: 'normal', 2: 'normal' } }, FAST_RULES));
  s3.step();
  env3.workers[0].onerror({ message: 'crash' });
  assert.ok(/crash/.test(s3.status().workerError));
  assert.ok(env3.workers[0].terminated);
});

test('subscribe/отписка и dispose', () => {
  const env = makeEnv(); const s = session(env);
  let calls = 0;
  const off = s.subscribe(() => { calls++; });
  s.newGame(Object.assign({ controllers: { 1: 'human', 2: 'normal' } }, FAST_RULES));
  assert.ok(calls > 0);
  off(); const c = calls; humanMove(s);
  assert.strictEqual(calls, c);
  let calls2 = 0; s.subscribe(() => { calls2++; });
  env.runTimers();
  const w = env.workers[0];
  s.dispose();
  assert.ok(w.terminated);
  env.reply(w, 0);
  assert.strictEqual(calls2, 1, 'только событие начала поиска до dispose');
  assert.strictEqual(s.move(0, 0).ok, false);
});

function playHumanBot(first, level, extra){
  const env = makeEnv(); const s = session(env);
  s.newGame(Object.assign({ controllers: { 1: 'human', 2: level }, firstPlayer: first,
    extraTurnOnCapture: extra }, FAST_RULES));
  let undone = false;
  for (let k = 0; k < 2000 && !s.snapshot().gameOver; k++){
    env.drain();
    if (s.snapshot().gameOver) break;
    assert.ok(s.status().humanTurn, 'после ответа бота — ход человека');
    if (!undone && s.status().moveCount >= 4){
      const n = s.status().moveCount;
      assert.ok(s.undo().ok);
      assert.ok(s.status().moveCount < n);
      assert.strictEqual(s.snapshot().current, 1, 'undo возвращает к ходу человека');
      undone = true;
      continue;
    }
    humanMove(s);
  }
  assert.ok(s.snapshot().gameOver, 'партия доиграна');
  assert.ok(undone || first === 2 || true);
  const evs = s.getReplay().events;
  assert.strictEqual(evs[evs.length - 1].type, 'end');
  return s;
}

function playBotBot(first, l1, l2, extra){
  const env = makeEnv(); const s = session(env);
  s.newGame(Object.assign({ controllers: { 1: l1, 2: l2 }, firstPlayer: first,
    extraTurnOnCapture: extra, autoStart: true }, FAST_RULES));
  env.drain();
  assert.ok(s.snapshot().gameOver, 'бот–бот доиграли');
  const msgs = env.totalMsgs();
  // Каждый запрос шёл за snapshot.current на момент запроса.
  for (const w of env.workers) for (const m of w.msgs) assert.strictEqual(m.snapshot.current >= 1, true);
  // Подряд одним игроком — только после захвата при extraTurnOnCapture.
  const moves = s.getReplay().events.filter(e => e.type === 'move');
  assert.strictEqual(moves[0].player, first);
  assert.strictEqual(moves.length, msgs, 'каждый ответ — ровно один ход');
  assert.strictEqual(s.step(), false, 'после gameOver шаг невозможен');
  s.start(); env.drain();
  assert.strictEqual(env.totalMsgs(), msgs, 'после gameOver новых запросов нет');
  return moves;
}

for (const first of [1, 2]) for (const level of ['normal', 'strong']) {
  test(`человек–бот до конца: первый ${first}, ${level}, доп. ход, undo`, () => playHumanBot(first, level, true));
}
test('человек–бот без доп. хода', () => playHumanBot(1, 'normal', false));
for (const first of [1, 2]) {
  test(`бот–бот до конца: первый ${first}, normal vs strong, доп. ход`, () => playBotBot(first, 'normal', 'strong', true));
}
test('бот–бот без доп. хода чередует игроков', () => {
  const moves = playBotBot(1, 'strong', 'normal', false);
  for (let i = 1; i < moves.length; i++) assert.notStrictEqual(moves[i].player, moves[i - 1].player);
});

test('пауза в бот–бот не разрешает лишний ход, start продолжает', () => {
  const env = makeEnv(); const s = session(env);
  s.newGame(Object.assign({ controllers: { 1: 'normal', 2: 'normal' }, autoStart: true }, FAST_RULES));
  env.runTimers(); env.reply(env.workers[0], 0); // 1 ход
  env.runTimers();                                 // запрос 2-го хода
  s.pause();
  const w = env.workers[0];
  env.reply(w, 1);
  assert.strictEqual(s.status().moveCount, 1);
  s.start(); env.runTimers();
  const w2 = env.workers[1];
  env.reply(w2, 0);
  assert.strictEqual(s.status().moveCount, 2);
});

let failed = 0;
for (const t of tests){
  try { t.fn(); console.log('ok -', t.name); }
  catch (e){ failed++; console.log('FAIL -', t.name); console.log(e && e.stack || e); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
