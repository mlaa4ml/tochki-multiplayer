// test/transition.js
//
// Дифференциальные тесты единого лёгкого перехода (issue #8, A03):
// E.applyTransition (узел поиска/self-play) против match.applyMove (полный
// createMatch) на каждом узле небольших деревьев, в фикстурах rules-v2 и в
// случайных партиях до конца. Сравниваются все слои доски, счёт, current,
// stonesPlacedTotal, конец и победитель, а также формат результата хода.
// Плюс: нелегальный ход не мутирует ни узел, ни матч; терминальный узел
// не порождает продолжений; бот берёт немедленную победу.
//
// Запуск: node test/transition.js   (входит в npm test)

'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../gameEngine.js');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rules-v2.json'), 'utf8'));

let checks = 0, failures = 0;
function check(cond, msg){
  checks++;
  if (!cond){ failures++; if (failures <= 60) console.error('  FAIL: ' + msg); }
}
const J = v => JSON.stringify(v);

function mulberry32(seed){
  return function(){
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function nodeView(n){
  return { stone: n.state.stone, dead: n.state.dead, territory: n.state.territory,
    scores: { 1: n.scores[1], 2: n.scores[2] }, current: n.current,
    gameOver: n.gameOver, stonesPlacedTotal: n.stonesPlacedTotal };
}
function snapView(s){
  return { stone: s.stone, dead: s.dead, territory: s.territory,
    scores: { 1: s.scores[1], 2: s.scores[2] }, current: s.current,
    gameOver: s.gameOver, stonesPlacedTotal: s.stonesPlacedTotal };
}
function resView(r){
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, player: r.player, x: r.x, y: r.y, current: r.current, gameOver: r.gameOver,
    winner: r.winner, extraTurn: r.extraTurn, scores: { 1: r.scores[1], 2: r.scores[2] },
    stonesPlacedTotal: r.stonesPlacedTotal, gained: r.gained, suicide: r.suicide };
}

const stats = { moves: 0, illegal: 0, captures: 0, freed: 0, suicides: 0, extraTurns: 0,
  terminalNodes: 0, fullBoardEnds: 0, scoreEnds: 0, fillEnds: 0 };

// Один и тот же ход в матче и в переходе; сравнение всего, что можно сравнить.
function stepBoth(match, node, p, x, y, label){
  const nodeBefore = J(nodeView(node));
  const snapBefore = J(snapView(match.getSnapshot()));
  check(snapBefore === nodeBefore, `${label}: состояние до хода (${p},${x},${y}) расходится`);
  const mres = match.applyMove(p, x, y);
  const t = E.applyTransition(node, p, x, y);
  check(J(nodeView(node)) === nodeBefore, `${label}: applyTransition мутировал входной узел`);
  const tres = t.ok ? t.result : t;
  check(J(resView(mres)) === J(resView(tres)),
    `${label}: результат хода (${p},${x},${y}) расходится: match=${J(resView(mres))} transition=${J(resView(tres))}`);
  const next = t.ok ? t.node : node;
  const snapAfter = match.getSnapshot();
  check(J(snapView(snapAfter)) === J(nodeView(next)), `${label}: состояние после хода (${p},${x},${y}) расходится`);
  if (!mres.ok){
    stats.illegal++;
    check(J(snapView(snapAfter)) === snapBefore, `${label}: нелегальный ход (${p},${x},${y}) мутировал матч`);
  } else {
    stats.moves++;
    if (mres.gained.some(g => g.kind === 'captured')) stats.captures++;
    if (mres.gained.some(g => g.kind === 'freed') || mres.suicide.some(g => g.kind === 'freed')) stats.freed++;
    if (mres.suicide.length) stats.suicides++;
    if (mres.extraTurn) stats.extraTurns++;
    if (next.gameOver){
      check(next.winner === mres.winner, `${label}: победитель узла ${next.winner} != ${mres.winner}`);
      const s = next.scores;
      check(next.winner === (s[1] > s[2] ? 1 : s[2] > s[1] ? 2 : 0), `${label}: победитель не соответствует счёту`);
    }
  }
  return { mres, next };
}

function legalMoves(node){
  const out = [];
  for (let y = 0; y < node.rows; y++)
    for (let x = 0; x < node.cols; x++)
      if (E.isTransitionLegal(node, x, y)) out.push({ x, y });
  return out;
}

// Нелегальные пробы: чужая очередь, занятая клетка, вне поля, вне дебютной зоны.
function illegalProbes(match, node, label){
  const other = node.current === 1 ? 2 : 1;
  const probes = [[other, 0, 0], [node.current, -1, 0], [node.current, node.cols, 0], [node.current, 1.5, 2]];
  outer: for (let y = 0; y < node.rows; y++)
    for (let x = 0; x < node.cols; x++)
      if (node.state.stone[y][x] !== 0){ probes.push([node.current, x, y]); break outer; }
  if (node.stonesPlacedTotal < 2) probes.push([node.current, 0, 0]);
  let n = node;
  for (const [p, x, y] of probes){
    const r = stepBoth(match, n, p, x, y, label + ' [probe]');
    check(!r.mres.ok, `${label}: проба (${p},${x},${y}) неожиданно принята`);
    n = r.next;
  }
}

function terminalChecks(node, label){
  stats.terminalNodes++;
  check(legalMoves(node).length === 0, `${label}: у терминального узла есть легальные ходы`);
  let firstEmpty = null;
  outer: for (let y = 0; y < node.rows; y++)
    for (let x = 0; x < node.cols; x++)
      if (node.state.stone[y][x] === 0){ firstEmpty = { x, y }; break outer; }
  if (firstEmpty){
    const t = E.applyTransition(node, node.current, firstEmpty.x, firstEmpty.y);
    check(!t.ok && t.reason === 'game-over', `${label}: терминальный узел породил продолжение`);
  }
  const mv = E.chooseMove(node.state, node.rows, node.cols, node.current, E.DIFFICULTY.normal, E.BOT_WEIGHTS,
    { stonesPlacedTotal: node.stonesPlacedTotal, gameOver: true, rules: node.rules });
  check(mv === null, `${label}: chooseMove вернул ход в терминальной позиции`);
}

function replay(options, pathMoves, label){
  const m = E.createMatch(options);
  for (const [p, x, y] of pathMoves){
    const r = m.applyMove(p, x, y);
    check(r.ok, `${label}: повтор пути отклонён (${p},${x},${y}): ${r.reason}`);
  }
  return m;
}

function capturePrefix(first){
  const a = first, b = first === 1 ? 2 : 1;
  // b-точка (5,4) окружается a-точками (5,3),(4,4),(6,4) и далее (5,5).
  return [[a,5,3],[b,5,4],[a,4,4],[b,0,0],[a,6,4],[b,0,9]];
}
const SPECIAL = [{x:5,y:5},{x:4,y:5},{x:6,y:5},{x:5,y:6}];

function exploreTree(options, prefix, depth, branch, rng, label){
  const m0 = E.createMatch(options);
  let node = E.createSearchNode(m0.getSnapshot());
  for (const [p, x, y] of prefix) node = stepBoth(m0, node, p, x, y, label + ' prefix').next;
  // Узел, построенный из снимка матча, совпадает с узлом, построенным переходами.
  check(J(nodeView(E.createSearchNode(m0.getSnapshot()))) === J(nodeView(node)), `${label}: createSearchNode(snapshot) расходится`);
  (function dfs(pathMoves, n, d){
    illegalProbes(replay(options, pathMoves, label), n, label);
    if (n.gameOver){ terminalChecks(n, label); return; }
    if (d === 0) return;
    const legal = legalMoves(n);
    const picked = [];
    for (const s of SPECIAL) if (legal.some(c => c.x === s.x && c.y === s.y)) picked.push(s);
    const rest = legal.filter(c => !picked.some(s => s.x === c.x && s.y === c.y));
    while (picked.length < branch && rest.length) picked.push(rest.splice(Math.floor(rng() * rest.length), 1)[0]);
    for (const mv of picked.slice(0, branch)){
      const m = replay(options, pathMoves, label);
      const p = n.current;
      const r = stepBoth(m, n, p, mv.x, mv.y, label);
      check(r.mres.ok, `${label}: легальный по переходу ход (${p},${mv.x},${mv.y}) отклонён матчем`);
      if (r.mres.ok) dfs(pathMoves.concat([[p, mv.x, mv.y]]), r.next, d - 1);
    }
  })(prefix.slice(), node, depth);
}

function playout(options, rng, label){
  const m = E.createMatch(options);
  let node = E.createSearchNode(m.getSnapshot());
  for (let i = 0; i < 400 && !node.gameOver; i++){
    const legal = legalMoves(node);
    if (!legal.length) break;
    if (i % 7 === 3) node = stepBoth(m, node, node.current === 1 ? 2 : 1, legal[0].x, legal[0].y, label + ' [wrong-turn]').next;
    const mv = legal[Math.floor(rng() * legal.length)];
    node = stepBoth(m, node, node.current, mv.x, mv.y, label).next;
  }
  if (node.gameOver){
    terminalChecks(node, label);
    if (E.isBoardFull(node.state, node.rows, node.cols)) stats.fullBoardEnds++;
    else if (node.rules.scoreRuleActive && (node.scores[1] >= node.rules.targetScore || node.scores[2] >= node.rules.targetScore)) stats.scoreEnds++;
    else if (node.rules.fillRuleActive) stats.fillEnds++;
  }
}

// ---------- 1. Деревья и случайные партии по всем конфигурациям ----------
const RULESETS = [
  { name: 'полное поле', r: {} },
  { name: 'порог очков 1', r: { targetScore: 1 } },
  { name: 'порог очков 3', r: { targetScore: 3 } },
  { name: 'заполнение 6%', r: { targetFillPercent: 6 } },
  { name: 'заполнение 40%', r: { targetFillPercent: 40 } }
];
let seed = 1;
for (const firstPlayer of [1, 2]){
  for (const extraTurnOnCapture of [false, true]){
    for (const rs of RULESETS){
      const options = { sizeKey: 'small', firstPlayer, extraTurnOnCapture, ...rs.r };
      const label = `first=${firstPlayer} extra=${extraTurnOnCapture} ${rs.name}`;
      exploreTree(options, [], 3, 3, mulberry32(seed++), label + ' [дебют]');
      exploreTree(options, capturePrefix(firstPlayer), 3, 4, mulberry32(seed++), label + ' [захват]');
      for (let k = 0; k < 3; k++) playout(options, mulberry32(seed++), label + ` [партия ${k}]`);
    }
  }
}

// ---------- 2. Все последовательности фикстур rules-v2 (захват/перезахват/самоубийство) ----------
let fixtureSeqs = 0;
(function walk(v){
  if (Array.isArray(v)){ v.forEach(walk); return; }
  if (!v || typeof v !== 'object') return;
  if (Array.isArray(v.moves) && v.moves.every(mv => Array.isArray(mv) && mv.length === 3)){
    fixtureSeqs++;
    const options = v.options || {};
    const m = E.createMatch(options);
    let node = E.createSearchNode(m.getSnapshot());
    for (const [p, x, y] of v.moves) node = stepBoth(m, node, p, x, y, `fixture ${v.name || fixtureSeqs}`).next;
    if (node.gameOver) terminalChecks(node, `fixture ${v.name || fixtureSeqs}`);
  }
  for (const k of Object.keys(v)) if (k !== 'moves') walk(v[k]);
})(fixtures);
check(fixtureSeqs > 0, 'в фикстурах не найдено ни одной последовательности ходов');

// ---------- 3. Немедленная победа приоритетнее эвристики ----------
for (const firstPlayer of [1, 2]){
  for (const extraTurnOnCapture of [false, true]){
    const options = { sizeKey: 'small', firstPlayer, extraTurnOnCapture, targetScore: 1 };
    const label = `победа first=${firstPlayer} extra=${extraTurnOnCapture}`;
    const m = replay(options, capturePrefix(firstPlayer), label);
    const snap = m.getSnapshot();
    check(snap.current === firstPlayer, `${label}: ожидался ход ${firstPlayer}`);
    for (const dk of ['normal', 'strong']){
      const mv = E.chooseMove({ stone: snap.stone, dead: snap.dead, territory: snap.territory },
        snap.rows, snap.cols, snap.current, E.DIFFICULTY[dk], E.BOT_WEIGHTS, snap);
      check(mv && mv.x === 5 && mv.y === 5, `${label} ${dk}: chooseMove не взял немедленную победу: ${J(mv)}`);
    }
    const bm = m.botMove('normal');
    check(bm && bm.x === 5 && bm.y === 5, `${label}: botMove не взял немедленную победу: ${J(bm)}`);
    const r = m.applyMove(firstPlayer, bm.x, bm.y);
    check(r.ok && r.gameOver && r.winner === firstPlayer, `${label}: ход не завершил партию победой`);
  }
}
check(E.terminalValue({ winner: 1 }, 1, 5) > 1e8 && E.terminalValue({ winner: 2 }, 1, 5) < -1e8 &&
  E.terminalValue({ winner: 0 }, 1, 5) === 0, 'terminalValue: победа/поражение/ничья');
check(E.terminalValue({ winner: 1 }, 1, 1) > E.terminalValue({ winner: 1 }, 1, 3), 'terminalValue: ближняя победа лучше дальней');

// ---------- 4. Доп. ход: после захвата поиск продолжает за фактического current ----------
for (const firstPlayer of [1, 2]){
  const m = replay({ sizeKey: 'small', firstPlayer, extraTurnOnCapture: true }, capturePrefix(firstPlayer), 'extra');
  const node = E.createSearchNode(m.getSnapshot());
  const t = E.applyTransition(node, firstPlayer, 5, 5);
  check(t.ok && t.result.extraTurn && t.node.current === firstPlayer, `доп. ход first=${firstPlayer}: current после захвата`);
  const mv = E.chooseMove(t.node.state, t.node.rows, t.node.cols, t.node.current, E.DIFFICULTY.normal, E.BOT_WEIGHTS, t.node);
  check(mv && E.isTransitionLegal(t.node, mv.x, mv.y), `доп. ход first=${firstPlayer}: бот вернул нелегальный ход`);
}

// ---------- 5. Старый вызов chooseMove без ctx по-прежнему работает ----------
{
  const s = E.createEmptyState(10, 12);
  const mv = E.chooseMove(s, 10, 12, 1, E.DIFFICULTY.normal, E.BOT_WEIGHTS);
  check(mv && E.inZone(mv.x, mv.y, E.getOpeningZone(10, 12)), 'chooseMove без ctx: первый ход в дебютной зоне');
}

check(stats.captures > 0 && stats.extraTurns > 0 && stats.terminalNodes > 0, 'покрытие: захваты/доп. ходы/терминальные узлы');
check(stats.fullBoardEnds > 0, 'покрытие: партия до полного поля');
check(stats.scoreEnds > 0, 'покрытие: конец по порогу очков');
check(stats.fillEnds > 0, 'покрытие: конец по порогу заполнения');

console.log(`transition: ${checks} проверок, фикстур ${fixtureSeqs}, статистика ${J(stats)}`);
if (failures){
  console.error(`transition: FAILED (${failures} из ${checks})`);
  process.exit(1);
}
console.log('transition: OK');
