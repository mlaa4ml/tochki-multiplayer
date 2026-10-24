#!/usr/bin/env node
'use strict';
// Local secure-context static hosting for the generated PWA; no dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../dist/offline');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let name;
  try { name = decodeURIComponent(req.url.split('?')[0]); }
  catch (_) { res.writeHead(400).end(); return; }
  if (name.includes('\\') || name.split('/').includes('..')){
    res.writeHead(403).end(); return;
  }
  const file = path.join(root, name === '/' ? 'index.html' : name);
  if (!file.startsWith(root + path.sep)){ res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err){ res.writeHead(404).end('Run npm run build:offline first'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache' });
    res.end(data);
  });
});
if (require.main === module){
  const port = Number(process.env.PORT || 8080);
  server.listen(port, '127.0.0.1', () => console.log('Offline PWA: http://localhost:' + port));
}
module.exports = server;
