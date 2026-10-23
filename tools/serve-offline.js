#!/usr/bin/env node
'use strict';

// Dependency-free static server. Deliberately serves only the built artifact.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../dist/offline');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function serve({ port = 8080, host = '127.0.0.1' } = {}) {
  if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error('Run npm run build:offline first');
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch (_) { res.writeHead(400).end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    const file = path.resolve(root, '.' + pathname, pathname.endsWith('/') ? 'index.html' : '');
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, bytes) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    });
  });
  server.listen(port, host, () => {
    console.log(`Offline: http://${host}:${server.address().port}/`);
  });
  return server;
}

if (require.main === module) serve({ port: Number(process.env.PORT || 8080), host: process.env.HOST || '127.0.0.1' });
module.exports = { serve };
