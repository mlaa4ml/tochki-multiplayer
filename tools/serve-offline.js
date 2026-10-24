#!/usr/bin/env node
// tools/serve-offline.js — минимальный статический сервер для dist/offline
// (B02, issue #25). Без зависимостей (только встроенные модули Node).
//
// Service Worker работает только в secure context (HTTPS или localhost),
// поэтому сервер по умолчанию слушает 127.0.0.1 — http://localhost:<port>
// браузеры считают безопасным.
//
// Использование:  node tools/serve-offline.js [--dir dist/offline] [--port 8080] [--host 127.0.0.1]
// Перед запуском соберите артефакт:  npm run build:offline
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv){
  const o = { dir: path.join(ROOT, 'dist', 'offline'), port: 8080, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++){
    if (argv[i] === '--dir' && argv[i + 1]) o.dir = path.resolve(argv[++i]);
    else if (argv[i] === '--port' && argv[i + 1]) o.port = Number(argv[++i]);
    else if (argv[i] === '--host' && argv[i + 1]) o.host = argv[++i];
  }
  return o;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function createServer(dir){
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD'){ res.writeHead(405); res.end(); return; }
    let rel;
    // Путь берём из req.url напрямую: new URL('//...') считает такой путь
    // адресом хоста и падает. Выход за пределы dir отсекается ниже.
    try { rel = decodeURIComponent(String(req.url).split(/[?#]/)[0]).replace(/\/{2,}/g, '/'); }
    catch (_) { res.writeHead(400); res.end(); return; }
    if (!rel.startsWith('/')) rel = '/' + rel;
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(dir, '.' + rel);
    if (file !== dir && !file.startsWith(dir + path.sep)){ res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err){ res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        // Свежесть обеспечивает Service Worker (версионированный кеш);
        // HTTP-кеш не должен подсовывать старый sw.js/index.html.
        'Cache-Control': 'no-cache'
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  });
}

if (require.main === module){
  const o = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(o.dir, 'index.html'))){
    console.error('Нет ' + path.join(o.dir, 'index.html') + ' — сначала выполните: npm run build:offline');
    process.exit(1);
  }
  createServer(o.dir).listen(o.port, o.host, () => {
    const shown = o.host === '127.0.0.1' ? 'localhost' : o.host;
    console.log('offline: http://' + shown + ':' + o.port + '/  (раздаётся ' + path.relative(process.cwd(), o.dir) + ', Ctrl+C — стоп)');
  });
}

module.exports = { createServer };
