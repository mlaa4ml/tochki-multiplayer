'use strict';
const E = require('../../gameEngine');
const R = require('./runner');
const crypto = require('node:crypto');
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function generateCorpus() {
  const openings = [];
  for (const sizeKey of ['small', 'medium', 'large']) {
    const z = E.getOpeningZone(E.SIZES[sizeKey].rows, E.SIZES[sizeKey].cols);
    const cells = [];
    for (let y = z.minY; y <= z.maxY; y++) for (let x = z.minX; x <= z.maxX; x++) cells.push({ x, y });
    for (const [splitIndex, split] of ['train', 'validation', 'test'].entries()) {
      for (let i = 0; i < 8; i++) {
        const a = cells[i], b = cells[(i + 1 + splitIndex * 4) % cells.length];
        openings.push({ id: `${sizeKey}-${split}-${i}`, split, sizeKey,
          prefix: [{ p: 1, ...a }, { p: 2, ...b }] });
      }
    }
  }
  const positions = [];
  for (const sizeKey of ['small', 'medium', 'large']) {
    const { rows, cols } = E.SIZES[sizeKey];
    const cx = Math.floor(cols / 2) - 1, cy = Math.floor(rows / 2);
    // Six reflections/colour reversals of a real capture-in-one position.
    for (let i = 0; i < 6; i++) {
      const dx = i % 2 ? -1 : 1, dy = i % 3 ? 1 : -1;
      const swap = i >= 3;
      const p = n => swap ? 3 - n : n;
      const prefix = [[1,cx,cy-dy],[2,cx,cy],[1,cx-dx,cy],
        [2,0,0],[1,cx+dx,cy],[2,1,0]].map(([n,x,y]) => ({ p: p(n), x, y }));
      positions.push({ id: `${sizeKey}-capture-${i}`, kind: 'tactical', split: 'test',
        options: { sizeKey, firstPlayer: p(1) }, prefix,
        bestMoves: [{ x: cx, y: cy + dy }], minScoreGain: 1 });
    }
    // A strategic safety constraint, not a claim of optimal long-term play:
    // the opponent has three walls; never complete their enclosure by suicide.
    positions.push({ id: `${sizeKey}-safety`, kind: 'strategic', split: 'test',
      options: { sizeKey }, prefix: [
        { p: 1, x: cx, y: cy-1 }, { p: 2, x: cx+2, y: cy+1 },
        { p: 1, x: cx-1, y: cy }, { p: 2, x: 0, y: 0 },
        { p: 1, x: cx+1, y: cy }, { p: 2, x: 1, y: 0 },
        { p: 1, x: cx, y: cy+1 }
      ], forbiddenMoves: [{ x: cx, y: cy }] });
  }
  return { format: 'tochki-corpus', version: 1, generator: 'synthetic-v1',
    openings, positions };
}

function validateCorpus(corpus) {
  if (corpus.format !== 'tochki-corpus' || corpus.version !== 1 ||
      !Array.isArray(corpus.openings) || !Array.isArray(corpus.positions)) throw new Error('Unsupported corpus');
  const ids = new Set(), seen = new Map();
  for (const entry of [...corpus.openings, ...corpus.positions]) {
    if (!entry.id || ids.has(entry.id)) throw new Error('Duplicate/missing corpus id');
    ids.add(entry.id);
    if (!['train', 'validation', 'test'].includes(entry.split)) throw new Error('Invalid split');
    const options = entry.options || { sizeKey: entry.sizeKey };
    if (!E.SIZES[options.sizeKey] || !Array.isArray(entry.prefix) || entry.prefix.length < 2)
      throw new Error('Invalid corpus entry');
    // Require explicit player on every prefix move (also detects extra-turn mistakes).
    if (entry.prefix.some(m => ![1, 2].includes(m.p))) throw new Error('Missing prefix player');
    const match = R.prefixMatch(options, entry.prefix);
    if (match.getSnapshot().gameOver) throw new Error('Terminal corpus prefix');
    if (entry.sizeKey) {
      // Reject identical positions, and prefix-related openings across splits.
      const key = options.sizeKey;
      const encoded = entry.prefix.map(m => JSON.stringify([m.p, m.x, m.y]));
      for (const old of seen.get(key) || []) {
        if (old.split !== entry.split && old.moves.slice(0, Math.min(old.moves.length, encoded.length))
          .every((m, i) => m === encoded[i])) throw new Error('Cross-split prefix leakage');
      }
      const list = seen.get(key) || [];
      list.push({ split: entry.split, moves: encoded }); seen.set(key, list);
    } else {
      if (!['tactical', 'strategic'].includes(entry.kind)) throw new Error('Invalid position kind');
      for (const m of [...(entry.bestMoves || []), ...(entry.forbiddenMoves || [])]) {
        const probe = R.prefixMatch(options, entry.prefix);
        const before = probe.getSnapshot();
        const result = probe.applyMove(before.current, m.x, m.y);
        if (!result.ok) throw new Error('Illegal corpus expectation');
        if (entry.bestMoves && probe.getSnapshot().scores[before.current] - before.scores[before.current] < entry.minScoreGain)
          throw new Error('Invalid tactical score expectation');
      }
      if (entry.kind === 'tactical' && !entry.bestMoves?.length) throw new Error('Missing tactical expectation');
      if (entry.kind === 'strategic' && !entry.forbiddenMoves?.length) throw new Error('Missing strategic expectation');
    }
  }
  for (const sizeKey of Object.keys(E.SIZES)) for (const split of ['train', 'validation', 'test'])
    if (!corpus.openings.some(o => o.sizeKey === sizeKey && o.split === split)) throw new Error('Missing corpus stratum');
  return fingerprint(corpus);
}
module.exports = { generateCorpus, validateCorpus, fingerprint };
if (require.main === module) {
  const corpus = generateCorpus();
  validateCorpus(corpus);
  process.stdout.write(JSON.stringify(corpus, null, 2) + '\n');
}
