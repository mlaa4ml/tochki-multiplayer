// test/mcts.js — smoke-тест прототипа B06 (issue #29): UCT-MCTS из
// tools/mcts/mcts.js делает только легальные ходы, укладывается в бюджет
// узлов и детерминирован при одном seed. Основной поиск не затрагивается.
'use strict';
const assert = require('assert');
const Engine = require('../gameEngine.js');
const Runner = require('../tools/bench/runner.js');
const MCTS = require('../tools/mcts/mcts.js');

const rules = { sizeKey: 'small', targetScore: 0, targetFillPercent: 30, firstPlayer: 1, extraTurnOnCapture: true, undoAllowed: false };

// 1) Полная партия MCTS против baseline: InvalidMoveError выбросится при любом нелегальном ходе.
const cand = MCTS.makeMctsPlayer(Engine, { nodeLimit: 60 });
const base = Runner.makeSearchPlayer(Engine, { difficulty: 'normal', nodeLimit: 60 });
const { result, lines } = Runner.playGame(Engine, { rules, players: { 1: cand, 2: base }, maxMoves: 400 });
assert.ok(result.end === 'finished' || result.end === 'no-move', 'game must end by rules, got ' + result.end);
assert.ok(Runner.replayLines(Engine, lines).ok, 'replay must reproduce the score');

// 2) Бюджет узлов соблюдается, результат детерминирован.
const snap = Engine.createMatch(rules).getSnapshot();
const r1 = MCTS.mctsSearch(Engine, snap, { nodeLimit: 100 });
const r2 = MCTS.mctsSearch(Engine, snap, { nodeLimit: 100 });
assert.ok(r1.trace.nodes <= 100, 'node budget exceeded: ' + r1.trace.nodes);
assert.deepStrictEqual(r1.move, r2.move, 'MCTS must be deterministic for a fixed seed');
assert.ok(Engine.isTransitionLegal(Engine.createSearchNode(snap), r1.move.x, r1.move.y), 'root move must be legal');

console.log('mcts smoke ok:', result.end, result.scores, 'moves', result.moves);
