'use strict';
const { parentPort } = require('worker_threads');
parentPort.on('message', msg => {
  if (msg.mode === 'hang') return;
  if (msg.mode === 'crash') process.exit(1);
  setTimeout(() => parentPort.postMessage({
    type: 'result', roomId: msg.roomId, gameId: msg.gameId,
    revision: msg.revision, requestId: msg.requestId, move: { x: 0, y: 0 }
  }), msg.delay || 10);
});
