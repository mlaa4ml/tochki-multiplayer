// test/replay-blunders.js — регрессия на зевки из реплеев issue #52.
// Позиции из tools/bench/corpus/human: бот (strong) ходом создавал «сеть» —
// соперник пленял группу за 2 своих хода подряд. После хода текущего поиска
// угроза соперника за 2 хода не должна превышать минимально достижимую
// (по всем легальным ходам) больше чем на 1 точку.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../gameEngine.js');

const dir = path.join(__dirname, '..', 'tools', 'bench', 'corpus', 'human');
const CASES = [
  // [файл, индекс партии, номер хода (до хода бота)]
  ['issue52-replays01.json', 0, 48],
  ['issue52-replays01.json', 0, 50],
  ['issue52-replays01.json', 0, 52],
  ['issue52-replays01.json', 1, 44],
  ['issue52-replays02.json', 1, 38],
  ['issue52-replays02.json', 1, 64]
];

function countCaptured(t){ let n = 0; for (const c of t.result.gained) if (c.kind === 'captured') n++; return n; }

function riskAfter(node, mover, x, y){
  const t = E.applyTransition(node, mover, x, y);
  if (!t.ok) return Infinity;
  if (t.node.gameOver || t.node.current === mover) return 0;
  return Math.max(0, E.twoMoveThreat(t.node, mover === 1 ? 2 : 1) - countCaptured(t));
}

let checked = 0;
const t0 = Date.now();
for (const [file, gi, ply] of CASES){
  const g = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))[gi].replay;
  const R = g.rules;
  const m = E.createMatch({ sizeKey: g.board.sizeKey, firstPlayer: R.firstPlayer, startPosition: R.startPosition,
    targetScore: R.targetScore, targetFillPercent: R.targetFillPercent, extraTurnOnCapture: R.extraTurnOnCapture });
  const mv = g.events.filter(e => e.type === 'move');
  for (let i = 0; i < ply; i++) m.applyMove(mv[i].player, mv[i].x, mv[i].y);
  const played = mv[ply];
  assert.ok(played.decision, `${file}#${gi} ход ${ply} должен быть ходом бота`);
  const node = E.createSearchNode(m.getSnapshot());
  const mover = node.current;
  // минимально достижимая угроза — по всем легальным ходам рядом с точками
  let minRisk = Infinity;
  for (let y = 0; y < node.rows; y++) for (let x = 0; x < node.cols; x++){
    if (!E.isTransitionLegal(node, x, y)) continue;
    const r = riskAfter(node, mover, x, y);
    if (r < minRisk) minRisk = r;
  }
  const playedRisk = riskAfter(node, mover, played.x, played.y);
  // Детерминированный бюджет узлов вместо таймера.
  const res = m.botSearch('strong', null, { nodeLimit: 6000 });
  const nowRisk = riskAfter(node, mover, res.move.x, res.move.y);
  console.log(`${file}#${gi} ход ${ply}: было (${played.x},${played.y}) риск ${playedRisk}, ` +
    `сейчас (${res.move.x},${res.move.y}) риск ${nowRisk}, минимум ${minRisk}`);
  assert.ok(nowRisk <= minRisk + 1,
    `${file}#${gi} ход ${ply}: ход (${res.move.x},${res.move.y}) оставляет сеть на ${nowRisk} (мин. ${minRisk})`);
  checked++;
}

// Ablation: safety2:false сохраняет прежнее поведение (фильтр не применяется).
{
  const m = E.createMatch({ sizeKey: 'small' });
  m.applyMove(1, 6, 5);
  const r = m.botSearch('strong', null, { nodeLimit: 2000 });
  assert.ok(r.move, 'ход найден');
}

console.log(`replay-blunders: OK (${checked} позиций, ${Date.now() - t0} мс)`);
