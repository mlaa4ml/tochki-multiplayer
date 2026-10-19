/* Shared synchronous browser/CLI contract. Load gameEngine.js before this script. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../gameEngine'));
  else root.TochkiRunner = factory(root.TochkiEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  const copy = x => JSON.parse(JSON.stringify(x));
  class InvalidMoveError extends Error {
    constructor(message) { super(message); this.name = 'InvalidMoveError'; }
  }
  function apply(match, move, label) {
    const s = match.getSnapshot();
    if (!move || !Number.isInteger(move.x) || !Number.isInteger(move.y) ||
        (move.p !== undefined && move.p !== s.current)) {
      throw new InvalidMoveError(label + ': malformed move or wrong player');
    }
    const result = match.applyMove(s.current, move.x, move.y);
    if (!result.ok) throw new InvalidMoveError(label + ': ' + result.reason);
  }
  function makeSearchPlayer({ difficulty = 'normal', weights = E.BOT_WEIGHTS, nodeLimit = 100 } = {}) {
    if (!E.DIFFICULTY[difficulty] || !Number.isInteger(nodeLimit) || nodeLimit <= 0)
      throw new Error('Invalid search configuration');
    return function chooseMove(s) {
      return E.searchMove(s, s.rows, s.cols, s.current, E.DIFFICULTY[difficulty], weights, {
        nodeLimit, stonesPlacedTotal: s.stonesPlacedTotal, gameOver: s.gameOver, rules: s.rules
      });
    };
  }
  function prefixMatch(options, prefix) {
    const match = E.createMatch(options);
    prefix.forEach((m, i) => apply(match, m, 'prefix[' + i + ']'));
    return match;
  }
  function runMatch({ options = {}, prefix = [], players, maxMoves = 1000,
    maxTimeMs = Infinity, clock = () => performance.now(), metadata = {}, onLine = () => {} }) {
    if (!Number.isInteger(maxMoves) || maxMoves < 0 || !(maxTimeMs >= 0)) throw new Error('Invalid limits');
    const match = prefixMatch(options, prefix);
    const records = [], decisions = [];
    const emit = r => { records.push(copy(r)); onLine(JSON.stringify(r)); };
    emit({ type: 'header', format: 'tochki-bench', version: 1,
      engineVersion: E.ENGINE_VERSION, options, prefix, metadata,
      limits: { maxMoves, maxTimeMs: Number.isFinite(maxTimeMs) ? maxTimeMs : null } });
    const start = clock();
    let status;
    while (true) {
      const s = match.getSnapshot();
      if (s.gameOver) { status = 'finished'; break; }
      if (clock() - start >= maxTimeMs) { status = 'truncated-time'; break; }
      if (decisions.length >= maxMoves) { status = 'truncated-moves'; break; }
      const begin = clock();
      const response = players[s.current](copy(s));
      const elapsedMs = clock() - begin;
      const move = response && Object.prototype.hasOwnProperty.call(response, 'move') ? response.move : response;
      // A null result on a nonterminal board is a bot error, never a draw.
      apply(match, move, 'bot turn ' + decisions.length);
      const decision = { type: 'move', p: s.current, x: move.x, y: move.y,
        elapsedMs, trace: response.trace || null };
      decisions.push(decision);
      emit(decision);
      // A single synchronous search can overrun the wall-clock cap.
      if (clock() - start >= maxTimeMs) {
        status = match.getSnapshot().gameOver ? 'finished' : 'truncated-time';
        break;
      }
    }
    const snapshot = match.getSnapshot();
    const truncated = status !== 'finished';
    const winner = truncated ? null : snapshot.scores[1] > snapshot.scores[2] ? 1 :
      snapshot.scores[2] > snapshot.scores[1] ? 2 : 0;
    const end = { type: 'end', status, truncated, winner, snapshot };
    emit(end);
    return { ...end, decisions, records, jsonl: records.map(r => JSON.stringify(r)).join('\n') + '\n' };
  }
  function replayLines(jsonl) {
    const records = jsonl.trim().split('\n').map(l => JSON.parse(l));
    const h = records.shift();
    if (!h || h.type !== 'header' || h.format !== 'tochki-bench' || h.version !== 1 ||
        h.engineVersion !== E.ENGINE_VERSION) throw new Error('Unsupported benchmark log');
    const match = prefixMatch(h.options, h.prefix);
    const end = records.pop();
    records.forEach(r => {
      if (r.type !== 'move') throw new Error('Unexpected replay record');
      apply(match, r, 'replay');
    });
    if (!end || end.type !== 'end' ||
        JSON.stringify(end.snapshot) !== JSON.stringify(match.getSnapshot())) throw new Error('Replay snapshot mismatch');
    const finished = match.getSnapshot().gameOver;
    const scores = match.getSnapshot().scores;
    const winner = finished ? scores[1] > scores[2] ? 1 : scores[2] > scores[1] ? 2 : 0 : null;
    if (end.truncated !== !finished || end.winner !== winner ||
        (finished ? end.status !== 'finished' : !['truncated-moves', 'truncated-time'].includes(end.status)))
      throw new Error('Replay outcome mismatch');
    return match.getSnapshot();
  }
  return { InvalidMoveError, makeSearchPlayer, prefixMatch, runMatch, replayLines };
});
