// test/offline-export.js — регрессия: экспорт реплея партии, в которой ходил бот
// в offline-сессии («Replay: event N: decision: missing botVersion»).
'use strict';
const assert = require('assert');
const Engine = require('../gameEngine.js');
const Replay = require('../replay.js');
const { handleBotRequest } = require('../botWorker.js');
const { createLocalSession } = require('../offline/localSession.js');

const workers = [], timers = [];
const s = createLocalSession({
  engine: Engine,
  createWorker(){
    const w = { msgs: [], answered: 0, onmessage: null,
      postMessage(m){ this.msgs.push(JSON.parse(JSON.stringify(m))); }, terminate(){} };
    workers.push(w); return w;
  },
  setTimeout(fn){ timers.push(fn); return timers.length; },
  clearTimeout(){}, searchOpts: { normal: { nodeLimit: 200 }, strong: { nodeLimit: 200 } }
});
s.newGame({ sizeKey: 'small', targetFillPercent: 10, controllers: { 1: 'human', 2: 'strong' } });
const snap = () => s.snapshot();
function pump(){
  for (let i = 0; i < 2000; i++){
    if (timers.length){ timers.shift()(); continue; }
    const w = workers.find(x => x.answered < x.msgs.length);
    if (!w) return;
    const r = handleBotRequest(Engine, w.msgs[w.answered++]);
    w.onmessage({ data: r });
  }
}
let guard = 0;
while (!snap().gameOver && guard++ < 200){
  const sn = snap();
  if (sn.current === 1){
    let done = false;
    for (let y = 0; y < sn.rows && !done; y++) for (let x = 0; x < sn.cols && !done; x++){
      const r = s.move(x, y); if (r && r.ok) done = true;
    }
    assert(done, 'у человека нет хода');
  }
  pump();
}
assert(snap().gameOver, 'партия не закончилась');
const text = s.exportReplay();                    // раньше бросало «missing botVersion»
assert(typeof text === 'string' && text.length > 0);
const obj = JSON.parse(text);
const botMoves = obj.events.filter(e => e.type === 'move' && e.decision);
assert(botMoves.length > 0, 'в реплее нет решений бота');
assert(botMoves.every(e => e.decision.difficulty === 'strong' && e.decision.botVersion));
Replay.play(text);                                // и импорт обратно проходит строгую проверку
console.log('offline-export: OK (' + botMoves.length + ' решений бота)');
