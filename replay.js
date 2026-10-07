// Shared Node/browser replay codec. No SQLite, DOM or active-game globals.
(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./gameEngine.js'));
  else root.TochkiReplay = factory(root.TochkiEngine);
})(typeof self !== 'undefined' ? self : this, function(Engine){
  'use strict';
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_EVENTS = 4096;
  const fail = message => { throw new Error('Replay: ' + message); };
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function object(value, label){
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(label + ' must be an object');
  }
  function keys(value, required, optional, label){
    object(value, label);
    for (const k of required) if (!own(value, k)) fail(label + ': missing ' + k);
    for (const k of Object.keys(value)) if (!required.includes(k) && !optional.includes(k)) fail(label + ': unknown field ' + k);
  }
  function integer(n, min, max, label){
    if (!Number.isSafeInteger(n) || n < min || n > max) fail(label + ': expected integer ' + min + '..' + max);
  }
  function version(v, label){
    if (v !== null && (typeof v !== 'string' || !v.length || v.length > 128)) fail(label + ': expected version string or null');
  }
  function weights(v, label){
    if (v === null) return;
    keys(v, ['potential', 'cohesion', 'stones', 'liberty'], [], label);
    for (const k of Object.keys(v)){
      if (typeof v[k] !== 'number' || !Number.isFinite(v[k]) || Math.abs(v[k]) > 1000000) fail(label + '.' + k + ': invalid weight');
    }
  }
  function budgets(v, label){
    if (v === null) return;
    keys(v, [], ['radius', 'candidateCap', 'timeLimit', 'maxDepth', 'branchWide',
      'branchMid', 'branchNarrow', 'quiescenceExt', 'nodeLimit'], label);
    for (const k of Object.keys(v)) integer(v[k], 0, 1000000000, label + '.' + k);
  }
  function metadata(v, label, decision){
    keys(v, ['botVersion', 'weightsVersion', 'seed', 'budgets', 'weights'],
      decision ? ['difficulty'] : [], label);
    version(v.botVersion, label + '.botVersion');
    version(v.weightsVersion, label + '.weightsVersion');
    if (v.seed !== null) integer(v.seed, 0, 0xffffffff, label + '.seed');
    budgets(v.budgets, label + '.budgets');
    weights(v.weights, label + '.weights');
    if (own(v, 'difficulty') && !['normal', 'strong', 'train', 'custom'].includes(v.difficulty)) fail(label + ': invalid difficulty');
  }

  // Bound work before serialization, including object callers (cycles, nesting,
  // non-JSON values and huge arrays). Text callers are bounded before parsing.
  function decode(input){
    let value = input;
    if (typeof input === 'string'){
      if (input.length > MAX_BYTES) fail('input exceeds byte limit');
      try { value = JSON.parse(input); } catch (_) { fail('invalid JSON'); }
    }
    let nodes = 0, chars = 0;
    const visiting = new Set();
    function walk(v, depth){
      if (++nodes > 150000 || depth > 12) fail('input exceeds structure limit');
      if (v === null || typeof v === 'boolean') return;
      if (typeof v === 'number'){
        if (!Number.isFinite(v)) fail('non-finite number');
        return;
      }
      if (typeof v === 'string'){
        chars += v.length;
        if (chars > MAX_BYTES) fail('input exceeds byte limit');
        return;
      }
      if (typeof v !== 'object') fail('non-JSON value');
      if (visiting.has(v)) fail('cyclic input');
      visiting.add(v);
      if (Array.isArray(v)){
        if (v.length > MAX_EVENTS) fail('array exceeds event limit');
        for (const item of v) walk(item, depth + 1);
      } else {
        object(v, 'input');
        for (const k of Object.keys(v)){
          chars += k.length;
          const descriptor = Object.getOwnPropertyDescriptor(v, k);
          if (!descriptor || !own(descriptor, 'value')) fail('accessors are not JSON');
          walk(descriptor.value, depth + 1);
        }
      }
      visiting.delete(v);
    }
    walk(value, 0);
    const text = JSON.stringify(value);
    const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : Buffer.byteLength(text);
    if (bytes > MAX_BYTES) fail('input exceeds byte limit');
    return JSON.parse(text);
  }

  // Always constructs a separate match. Nothing supplied by the caller is mutated.
  function play(input){
    const replay = decode(input);
    keys(replay, ['format', 'version', 'engineVersion', 'board', 'rules', 'metadata', 'events'], [], 'header');
    if (replay.format !== 'tochki-replay') fail('unsupported format (legacy records cannot be replayed exactly)');
    if (replay.version !== 1) fail('unsupported format version');
    if (replay.engineVersion !== Engine.ENGINE_VERSION) fail('unsupported engine version');
    const b = replay.board, r = replay.rules;
    keys(b, ['sizeKey', 'rows', 'cols'], [], 'board');
    if (!own(Engine.SIZES, b.sizeKey)) fail('unsupported board size');
    const size = Engine.SIZES[b.sizeKey];
    if (b.rows !== size.rows || b.cols !== size.cols) fail('board dimensions do not match sizeKey');
    keys(r, ['targetScore', 'targetFillPercent', 'scoreRuleActive', 'fillRuleActive',
      'totalCells', 'extraTurnOnCapture', 'firstPlayer', 'undoAllowed'], [], 'rules');
    integer(r.targetScore, 0, 9999, 'targetScore');
    integer(r.targetFillPercent, 0, 100, 'targetFillPercent');
    integer(r.firstPlayer, 1, 2, 'firstPlayer');
    for (const k of ['extraTurnOnCapture', 'undoAllowed', 'scoreRuleActive', 'fillRuleActive']){
      if (typeof r[k] !== 'boolean') fail(k + ': expected boolean');
    }
    if (r.totalCells !== b.rows * b.cols || r.scoreRuleActive !== (r.targetScore > 0) ||
        r.fillRuleActive !== (r.targetFillPercent > 0 && r.targetFillPercent < 100)) fail('inconsistent derived rules');
    metadata(replay.metadata, 'metadata', false);
    if (!Array.isArray(replay.events) || replay.events.length > MAX_EVENTS) fail('invalid events array');
    const match = Engine.createMatch({ sizeKey: b.sizeKey, ...r, replayMetadata: replay.metadata });
    let ended = false, pendingRuleEnd = false;
    replay.events.forEach((event, i) => {
      try {
        object(event, 'event');
        if (ended) fail('event after end');
        if (pendingRuleEnd && event.type !== 'end') fail('expected rule end immediately after terminal move');
        let result;
        if (event.type === 'move'){
          keys(event, ['type', 'player', 'x', 'y'], ['decision'], 'move');
          integer(event.player, 1, 2, 'player');
          integer(event.x, 0, b.cols - 1, 'x');
          integer(event.y, 0, b.rows - 1, 'y');
          if (own(event, 'decision')) metadata(event.decision, 'decision', true);
          result = match.applyMove(event.player, event.x, event.y, event.decision);
          if (result.ok) pendingRuleEnd = result.gameOver;
        } else if (event.type === 'undo'){
          keys(event, ['type'], [], 'undo');
          result = match.undoLastMove();
        } else if (event.type === 'end'){
          keys(event, ['type', 'reason', 'winner', 'scores'], [], 'end');
          if (!['manual', 'rule', 'abandoned'].includes(event.reason)) fail('invalid end reason');
          if (event.reason === 'rule'){
            if (!pendingRuleEnd) fail('rule end without terminal move');
          } else {
            if (pendingRuleEnd) fail('terminal move requires rule end');
            result = match.endNow(event.reason);
          }
          integer(event.winner, 0, 2, 'winner');
          keys(event.scores, ['1', '2'], [], 'scores');
          const snap = match.getSnapshot();
          for (const p of [1, 2]){
            integer(event.scores[p], 0, r.totalCells, 'score');
            if (event.scores[p] !== snap.scores[p]) fail('end scores do not match replay');
          }
          const winner = snap.scores[1] > snap.scores[2] ? 1 : snap.scores[2] > snap.scores[1] ? 2 : 0;
          if (event.winner !== winner) fail('end winner does not match replay');
          ended = true;
          pendingRuleEnd = false;
        } else fail('unsupported event type');
        if (result && !result.ok) fail(result.reason);
      } catch (e) {
        fail('event ' + i + ': ' + e.message.replace(/^Replay: /, ''));
      }
    });
    if (pendingRuleEnd) fail('missing rule end event');
    return match;
  }

  function importInto(target, input){
    const replacement = play(input); // validation and playback finish before swap
    target.match = replacement;
    return replacement;
  }
  function stringify(match){
    const replay = match.getReplay();
    play(replay); // never export silently corrupt or oversized data
    return JSON.stringify(replay, null, 2);
  }
  return { MAX_BYTES, MAX_EVENTS, play, importInto, stringify };
});
