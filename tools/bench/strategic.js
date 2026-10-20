#!/usr/bin/env node
// tools/bench/strategic.js
//
// Версионированный СТРАТЕГИЧЕСКИЙ корпус позиций для benchmark (A07, issue #12).
// Дополняет тактику capture-in-1 из openings.v1.json позициями, где правильный
// ход определяется не немедленным захватом, а последствиями хода:
//
//  - defend-threat — у соперника есть угроза окружения (захват в 1 ход, если
//    ходящий её проигнорирует), у ходящего своего захвата нет. Ожидаемые
//    ходы — ВСЕ ходы, после которых у соперника не остаётся ни одного
//    захвата (проверено перебором движком). Позиция берётся, только если
//    «безопасных» ходов не больше половины легальных — иначе она не различает.
//  - endgame-fill — последний ход перед порогом заполнения поля: любой
//    легальный ход завершает партию, и ожидаемые ходы — те, что дают
//    максимальную итоговую разницу очков (точный ответ, без эвристики).
//
// Корпус только для ИЗМЕРЕНИЯ: tools/train-bot.js его не читает, и он не
// используется в подборе весов. Файл не редактируется; новая версия —
// новый файл strategic.vN.json (--gen с другим seed).
//
//   node tools/bench/strategic.js --gen tools/bench/corpus/strategic.v1.json --seed 20240613
//   node tools/bench/strategic.js --check tools/bench/corpus/strategic.v1.json   (глубокая перепроверка)

const fs = require('fs');
const path = require('path');
const Engine = require('../../gameEngine.js');
const Runner = require('./runner.js');

const STRATEGIC_VERSION = 1;
const DEFAULT_PATH = path.join(__dirname, 'corpus', 'strategic.v1.json');
const KINDS = ['defend-threat', 'endgame-fill'];

function makeRng(seed){
  let s = (seed >>> 0) || 1;
  return function(){
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function shuffle(a, rng){
  for (let k = a.length - 1; k > 0; k--){ const j = Math.floor(rng() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; }
  return a;
}

function rulesFor(sizeKey, fill){
  return { sizeKey, targetScore: 0, targetFillPercent: fill, firstPlayer: 1, extraTurnOnCapture: false, undoAllowed: false };
}

function nodeFromPrefix(rules, prefix){
  const m = Engine.createMatch(rules);
  for (const mv of prefix){
    const r = m.applyMove(mv.seat, mv.x, mv.y);
    if (!r.ok || r.gameOver) return null;
  }
  return Engine.createSearchNode(m.getSnapshot());
}

function emptyCells(stone, rows, cols){
  const out = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (!stone[y][x]) out.push({ x, y });
  return out;
}

// Клетки, ходом в которые `seat` немедленно увеличивает свой счёт (захват).
function captureCells(node, seat){
  const n = Object.assign({}, node, { current: seat, gameOver: false, winner: null });
  const before = node.scores[seat];
  const out = [];
  for (const c of emptyCells(node.state.stone, node.rows, node.cols)){
    const t = Engine.applyTransition(n, seat, c.x, c.y);
    if (t.ok && t.result.scores[seat] > before) out.push(c);
  }
  return out;
}

function defendThreatExpected(node){
  const A = node.current, B = 3 - A;
  if (captureCells(node, A).length) return null; // это уже capture-in-1
  if (!captureCells(node, B).length) return null; // угрозы нет
  const safe = []; let legal = 0;
  for (const c of emptyCells(node.state.stone, node.rows, node.cols)){
    const t = Engine.applyTransition(node, A, c.x, c.y);
    if (!t.ok || t.result.gameOver) continue;
    legal++;
    if (!captureCells(t.node, B).length) safe.push(c);
  }
  if (!safe.length || safe.length * 2 > legal) return null;
  return safe;
}

function endgameExpected(node){
  const A = node.current;
  const vals = [];
  for (const c of emptyCells(node.state.stone, node.rows, node.cols)){
    const t = Engine.applyTransition(node, A, c.x, c.y);
    if (!t.ok) continue;
    if (!t.result.gameOver) return null; // не все ходы последние
    vals.push({ x: c.x, y: c.y, d: t.result.scores[A] - t.result.scores[3 - A] });
  }
  if (!vals.length) return null;
  const best = Math.max(...vals.map(v => v.d)), worst = Math.min(...vals.map(v => v.d));
  if (best === worst) return null; // все ходы равноценны — позиция не различает
  return vals.filter(v => v.d === best).map(v => ({ x: v.x, y: v.y }));
}

const EXPECTED = { 'defend-threat': defendThreatExpected, 'endgame-fill': endgameExpected };

// Случайная легальная партия на `plies` ходов. endedAt — ход, завершивший
// партию (в prefix он НЕ входит).
function randomPrefix(rules, plies, rng){
  const m = Engine.createMatch(rules);
  const prefix = [];
  for (let i = 0; i < plies; i++){
    const snap = m.getSnapshot();
    if (snap.gameOver) return null;
    let moved = false;
    for (const c of shuffle(emptyCells(snap.stone, snap.rows, snap.cols), rng)){
      const r = m.applyMove(snap.current, c.x, c.y);
      if (r.ok){
        if (r.gameOver) return { prefix, endedAt: c };
        prefix.push({ x: c.x, y: c.y, seat: snap.current }); moved = true; break;
      }
    }
    if (!moved) return null;
  }
  return { prefix, endedAt: null };
}

function generateStrategic(seed){
  const rng = makeRng(seed);
  const out = {
    format: 'tochki-bench-strategic', version: STRATEGIC_VERSION, seed, engineVersion: Engine.ENGINE_VERSION,
    kinds: {
      'defend-threat': 'соперник угрожает окружением; ожидаются все ходы, после которых у соперника нет захвата в 1 ход',
      'endgame-fill': 'последний ход до порога заполнения; ожидаются ходы с максимальной итоговой разницей очков'
    },
    note: 'Только для измерения (test-only), в подборе весов не используется. Не редактировать: новая версия = новый файл.',
    positions: {}
  };
  for (const sizeKey of ['small', 'medium']){
    const list = [];
    let n = 0, attempts = 0;
    while (n < 8 && attempts < 250){
      attempts++;
      const rules = rulesFor(sizeKey, 45);
      const r = randomPrefix(rules, 12 + Math.floor(rng() * 24), rng);
      if (!r || r.endedAt) continue;
      const node = nodeFromPrefix(rules, r.prefix);
      const exp = node && defendThreatExpected(node);
      if (!exp) continue;
      list.push({ id: `${sizeKey}-defend-${n}`, kind: 'defend-threat', rules, prefix: r.prefix, expected: exp });
      n++;
    }
    n = 0; attempts = 0;
    while (n < 8 && attempts < 80){
      attempts++;
      const rules = rulesFor(sizeKey, 30);
      const r = randomPrefix(rules, 1000, rng);
      if (!r || !r.endedAt) continue;
      const node = nodeFromPrefix(rules, r.prefix);
      const exp = node && endgameExpected(node);
      if (!exp) continue;
      list.push({ id: `${sizeKey}-endgame-${n}`, kind: 'endgame-fill', rules, prefix: r.prefix, expected: exp });
      n++;
    }
    out.positions[sizeKey] = list;
  }
  return out;
}

const key = (arr) => JSON.stringify(arr.map(c => [c.x, c.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]));

// Строгая проверка: префикс целиком легален, ожидаемые ходы легальны.
// deep=true — ожидаемые ходы пересчитываются движком и должны совпасть.
function validateStrategic(st, deep){
  if (!st || st.format !== 'tochki-bench-strategic') throw new Error('bad strategic corpus format');
  const errors = []; const ids = new Set();
  for (const list of Object.values(st.positions || {})) for (const p of list){
    if (ids.has(p.id)) errors.push('duplicate id ' + p.id);
    ids.add(p.id);
    if (!KINDS.includes(p.kind)) { errors.push(p.id + ': unknown kind ' + p.kind); continue; }
    try { Runner.applyPrefix(Engine.createMatch(p.rules), p.prefix, () => {}); }
    catch (e){ errors.push(p.id + ': ' + e.message); continue; }
    const node = nodeFromPrefix(p.rules, p.prefix);
    if (!p.expected || !p.expected.length) errors.push(p.id + ': empty expected');
    else for (const c of p.expected) if (!Engine.isTransitionLegal(node, c.x, c.y)) errors.push(p.id + ': expected move is illegal');
    if (deep){
      const exp = EXPECTED[p.kind](node);
      if (!exp || key(exp) !== key(p.expected)) errors.push(p.id + ': expected moves do not match engine recomputation');
    }
  }
  if (errors.length) throw new Error('strategic corpus invalid:\n' + errors.join('\n'));
  return true;
}

function loadDefault(){
  return fs.existsSync(DEFAULT_PATH) ? JSON.parse(fs.readFileSync(DEFAULT_PATH, 'utf8')) : null;
}

function main(){
  const argv = process.argv.slice(2);
  let gen = null, check = null, seed = 20240613;
  for (let i = 0; i < argv.length; i++){
    if (argv[i] === '--gen') gen = argv[++i];
    else if (argv[i] === '--check') check = argv[++i];
    else if (argv[i] === '--seed') seed = parseInt(argv[++i], 10) >>> 0;
    else throw new Error('unknown arg ' + argv[i]);
  }
  if (gen){
    const st = generateStrategic(seed);
    validateStrategic(st, true);
    fs.mkdirSync(path.dirname(gen), { recursive: true });
    fs.writeFileSync(gen, JSON.stringify(st, null, 1) + '\n');
    for (const [k, l] of Object.entries(st.positions))
      console.log(k, KINDS.map(kind => kind + ':' + l.filter(p => p.kind === kind).length).join(' '));
    console.log('strategic corpus written:', gen);
  } else if (check){
    validateStrategic(JSON.parse(fs.readFileSync(check, 'utf8')), true);
    console.log('strategic corpus OK:', check);
  } else {
    console.log('usage: --gen <path> [--seed N] | --check <path>');
  }
}

if (require.main === module) main();

module.exports = { STRATEGIC_VERSION, DEFAULT_PATH, KINDS, generateStrategic, validateStrategic, loadDefault,
  defendThreatExpected, endgameExpected, captureCells, nodeFromPrefix };
