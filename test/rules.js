// test/rules.js
//
// Тесты чистого движка правил (без сервера/сети) по машинно-читаемым
// эталонам test/fixtures/rules-v2.json (классические правила, docs/RULES_V2.md).
// Каждый эталон прогоняется дважды: через Node require (module.exports) и
// через браузерную UMD-ветку (window/self.TochkiEngine) в отдельном VM-контексте.
// Результаты обеих сред обязаны совпадать побайтно.
//
// Запуск: node test/rules.js   (входит в npm test)

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ENGINE_PATH = path.join(__dirname, '..', 'gameEngine.js');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rules-v2.json'), 'utf8'));

function loadNodeEngine(){
  delete require.cache[require.resolve(ENGINE_PATH)];
  return require(ENGINE_PATH);
}

function loadBrowserEngine(){
  const code = fs.readFileSync(ENGINE_PATH, 'utf8');
  // Без module/exports — срабатывает браузерная ветка UMD: self.TochkiEngine.
  const sandbox = { performance: { now: () => 0 } };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'gameEngine.js (browser)' });
  assert.ok(sandbox.TochkiEngine, 'браузерная ветка UMD должна выставить self.TochkiEngine');
  // Переводим объекты из чужого realm в обычный JSON для сравнения.
  return sandbox.TochkiEngine;
}

let failures = 0, checks = 0;
function check(cond, msg){
  checks++;
  if (!cond){ failures++; console.error('  FAIL: ' + msg); }
}
function plain(v){ return JSON.parse(JSON.stringify(v)); }

function verifyExpect(label, res, snap, expect){
  if (!expect) return;
  for (const key of ['ok','reason','current','gameOver','winner','extraTurn','stonesPlacedTotal']){
    if (key in expect){
      const actual = key in res ? res[key] : snap[key];
      check(actual === expect[key], `${label}: ${key} ожидалось ${JSON.stringify(expect[key])}, получено ${JSON.stringify(actual)}`);
    }
  }
  if (expect.scores){
    const s = res.scores || snap.scores;
    check(s[1] === expect.scores['1'] && s[2] === expect.scores['2'],
      `${label}: scores ожидалось ${JSON.stringify(expect.scores)}, получено ${JSON.stringify(s)}`);
  }
  if ('suicide' in expect){
    const has = Array.isArray(res.suicide) && res.suicide.length > 0;
    check(has === expect.suicide, `${label}: suicide ожидалось ${expect.suicide}, получено ${has}`);
  }
  if (expect.cells){
    for (const c of expect.cells){
      const got = { stone: snap.stone[c.y][c.x], dead: snap.dead[c.y][c.x], territory: snap.territory[c.y][c.x] };
      check(got.stone === c.stone && got.dead === c.dead && got.territory === c.territory,
        `${label}: клетка (${c.x},${c.y}) ожидалось s/d/t=${c.stone}/${c.dead}/${c.territory}, получено ${got.stone}/${got.dead}/${got.territory}`);
    }
  }
}

// Прогоняет одну последовательность и возвращает трассу для сравнения сред.
function runSequence(E, seq, envName){
  const trace = [];
  const m = E.createMatch(seq.options);
  seq.moves.forEach(([p,x,y], i) => {
    const r = m.applyMove(p, x, y);
    check(r.ok, `[${envName}] ${seq.name}: подготовительный ход #${i} (${p},${x},${y}) отклонён: ${r.reason}`);
    trace.push(plain(r));
  });
  verifyExpect(`[${envName}] ${seq.name}`, {}, plain(m.getSnapshot()), seq.expect);
  (seq.then || []).forEach((step, i) => {
    const before = JSON.stringify(m.getSnapshot());
    let res;
    if (step.move) res = m.applyMove(step.move[0], step.move[1], step.move[2]);
    else if (step.undo) res = m.undoLastMove();
    else if (step.endNow) res = m.endNow();
    res = plain(res);
    const snap = plain(m.getSnapshot());
    const label = `[${envName}] ${seq.name} / шаг ${i}`;
    verifyExpect(label, res, snap, step.expect);
    if (step.noMutation) check(JSON.stringify(snap) === before, `${label}: отказ не должен мутировать состояние`);
    trace.push(res, snap);
  });
  trace.push(plain(m.getSnapshot()), plain(m.getMoveLog()));
  return trace;
}

function runFullBoard(E, fb, envName){
  const m = E.createMatch(fb.options);
  const { rows, cols } = m;
  const used = new Set(fb.firstMoves.map(([,x,y]) => x+','+y));
  const cells = {1:[], 2:[]};
  for (let y=0; y<rows; y++) for (let x=0; x<cols; x++){
    if (used.has(x+','+y)) continue;
    cells[x % 2 === 0 ? 1 : 2].push([x,y]);
  }
  let last;
  for (const [p,x,y] of fb.firstMoves){ last = m.applyMove(p,x,y); check(last.ok, `[${envName}] full-board: первый ход отклонён`); }
  let p = 1, guard = 0;
  while (!last.gameOver && guard++ < 1000){
    const [x,y] = cells[p].shift();
    last = m.applyMove(p, x, y);
    check(last.ok, `[${envName}] full-board: ход (${p},${x},${y}) отклонён: ${last.reason}`);
    if (!last.ok) break;
    p = p === 1 ? 2 : 1;
  }
  verifyExpect(`[${envName}] ${fb.name}`, plain(last), plain(m.getSnapshot()), fb.expect);
  return [plain(last), plain(m.getSnapshot())];
}

function runAll(E, envName){
  const out = [];
  for (const seq of fixtures.sequences) out.push(runSequence(E, seq, envName));
  out.push(runFullBoard(E, fixtures.fullBoard, envName));
  // Дебютная зона: все размеры, обе стороны — первые два хода только в зоне 4×4.
  for (const sizeKey of Object.keys(E.SIZES)){
    for (const fp of [1,2]){
      const m = E.createMatch({ sizeKey, firstPlayer: fp });
      const z = E.getOpeningZone(m.rows, m.cols);
      check(z.maxX - z.minX === 3 && z.maxY - z.minY === 3, `[${envName}] ${sizeKey}: зона 4×4`);
      const second = fp === 1 ? 2 : 1;
      check(m.applyMove(fp, 0, 0).reason === 'illegal-cell', `[${envName}] ${sizeKey}/fp${fp}: угол вне зоны запрещён`);
      check(m.applyMove(fp, z.minX, z.minY).ok, `[${envName}] ${sizeKey}/fp${fp}: первый ход в зоне`);
      check(m.applyMove(second, 0, 0).reason === 'illegal-cell', `[${envName}] ${sizeKey}/fp${fp}: второй ход вне зоны запрещён`);
      check(m.applyMove(second, z.maxX, z.maxY).ok, `[${envName}] ${sizeKey}/fp${fp}: второй ход в зоне`);
      check(m.applyMove(fp, 0, 0).ok, `[${envName}] ${sizeKey}/fp${fp}: третий ход вне зоны разрешён`);
      out.push(plain(m.getSnapshot()));
    }
  }
  return out;
}

const nodeTrace = runAll(loadNodeEngine(), 'node');
const browserTrace = runAll(loadBrowserEngine(), 'browser');
check(JSON.stringify(nodeTrace) === JSON.stringify(browserTrace), 'Node и браузерный API дают разные результаты на одинаковых входах');

if (failures){
  console.error(`rules: ${failures} из ${checks} проверок не прошли`);
  process.exit(1);
}
console.log(`rules: OK (${checks} проверок, ${fixtures.sequences.length + 1} эталонов, Node == browser)`);
