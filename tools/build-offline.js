#!/usr/bin/env node
'use strict';

// No npm dependencies: always build directly from the canonical sources.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist/offline');
const sources = ['gameEngine.js', 'botWorker.js', 'offline/localSession.js', 'offline/index.html'];

function build() {
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(path.join(output, 'offline'), { recursive: true });
  const files = {};
  for (const source of sources) {
    const bytes = fs.readFileSync(path.join(root, source));
    fs.writeFileSync(path.join(output, source), bytes);
    files[source] = {
      source,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')
    };
  }
  // Keep the source directory layout so script/Worker URLs work unchanged,
  // including when the artifact is hosted below a URL prefix.
  fs.writeFileSync(path.join(output, 'index.html'),
    '<!doctype html><html lang="ru"><meta charset="utf-8">' +
    '<meta http-equiv="refresh" content="0;url=offline/index.html">' +
    '<title>Точки — offline</title><a href="offline/index.html">Открыть игру</a></html>\n');
  fs.writeFileSync(path.join(output, 'build-manifest.json'),
    JSON.stringify({ files }, null, 2) + '\n');
  console.log('Built dist/offline (canonical engine, UI and Worker; no server dependencies)');
  return output;
}

if (require.main === module) build();
module.exports = { build, sources };
