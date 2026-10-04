#!/usr/bin/env node
'use strict';

// This runner deliberately never imports the live engine or learned DB weights.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const manifest = require('../baselines/original-v1/manifest.json');
const filename = path.join(__dirname, '../baselines/original-v1/gameEngine.js');
const bytes = fs.readFileSync(filename);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const pinnedHash = '897302b1c3358e6914359e0d3488f4cf71363185381eca63f99f2bf5023aa30f';
assert.equal(sha256, pinnedHash, 'Frozen baseline changed: create a new version instead');
assert.equal(manifest.sha256, pinnedHash);
const args = process.argv.slice(2);
assert.ok(args.every(a => ['normal','strong','--verify','--fixed-clock'].includes(a)), 'Usage: node tools/baseline-v1.js [normal|strong] [--fixed-clock] [--verify]');
assert.ok(!(args.includes('normal') && args.includes('strong')), 'Choose one difficulty');
const difficulty = args.includes('strong') ? 'strong' : 'normal';
const fixedClock = args.includes('--fixed-clock');
let engine;
if (fixedClock) {
  // Diagnostic mode ONLY: exact full-depth search, not the timed playing strength.
  const context = {self:{},performance:{now:() => 0}};
  vm.runInNewContext(bytes.toString('utf8'),context,{filename});
  engine = context.self.TochkiEngine;
} else {
  engine = require(filename);
}
const plain = x => JSON.parse(JSON.stringify(x));
assert.deepStrictEqual(plain(engine.BOT_WEIGHTS),manifest.weights);
assert.deepStrictEqual(plain(engine.DIFFICULTY),manifest.difficulty);
if (args.includes('--verify')) {
  console.log(`PASS ${manifest.id}: pinned source SHA-256, weights, normal/strong settings`);
  process.exit(0);
}
const match = engine.createMatch(manifest.matchOptions);
for (const move of manifest.opening) assert.equal(match.applyMove(...move).ok,true);
const before = match.getSnapshot();
const start = performance.now();
const move = match.botMove(difficulty,manifest.weights);
const elapsedMs = performance.now()-start;
assert.ok(move,'Baseline failed to return a move');
assert.deepStrictEqual(plain(match.getSnapshot()),plain(before),'Search mutated match');
const result = match.applyMove(before.current,move.x,move.y);
assert.equal(result.ok,true,'Baseline returned illegal move');
console.log(JSON.stringify({
  baseline:manifest.id, sourceRevision:manifest.sourceRevision, sha256,
  node:process.version, platform:process.platform, arch:process.arch,
  difficulty, settings:manifest.difficulty[difficulty], weights:manifest.weights,
  rulesVersion:manifest.rulesVersion, options:manifest.matchOptions, opening:manifest.opening,
  mode:fixedClock ? 'fixed-clock-full-depth-diagnostic' : 'original-wall-clock',
  move:{x:move.x,y:move.y}, result, elapsedMs
},null,2));
