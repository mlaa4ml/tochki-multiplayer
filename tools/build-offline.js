#!/usr/bin/env node
// tools/build-offline.js — статическая сборка offline-приложения (B01, issue #24).
//
// Собирает в dist/offline/ самодостаточный статический артефакт:
//   index.html      — offline UI (из offline/index.html, пути переписаны);
//   localSession.js — offline/localSession.js без изменений;
//   botWorker.js    — канонический botWorker.js без изменений;
//   gameEngine.js   — КАНОНИЧЕСКИЙ gameEngine.js из корня репозитория,
//                     копируется побайтно при каждой сборке (ручной копии
//                     движка в репозитории нет и быть не должно);
//   build-manifest.json — список файлов, их источники и sha256.
//
// Сборка падает, если:
//   - копия движка/Worker'а не совпадает с исходником по sha256;
//   - в артефакт попал server.js / ws / better-sqlite3 / db.js / auth.js;
//   - артефакт ссылается на внешние URL (CDN) или WebSocket/fetch/XHR.
//
// Зависимостей нет (только встроенные модули Node), npm install не нужен.
// Использование:  node tools/build-offline.js [--out dist/offline]
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv){
  const out = { out: path.join(ROOT, 'dist', 'offline') };
  for (let i = 0; i < argv.length; i++){
    if (argv[i] === '--out' && argv[i + 1]) out.out = path.resolve(argv[++i]);
  }
  return out;
}

function sha256(buf){ return crypto.createHash('sha256').update(buf).digest('hex'); }

// Источник -> имя в артефакте. Плоская структура: Worker грузит движок через
// importScripts('gameEngine.js') относительно своего URL, поэтому оба файла
// лежат в одной папке.
const FILES = [
  { src: 'gameEngine.js', dst: 'gameEngine.js', verbatim: true },
  { src: 'botWorker.js', dst: 'botWorker.js', verbatim: true },
  { src: 'offline/localSession.js', dst: 'localSession.js', verbatim: true },
    { src: 'offline/index.html', dst: 'index.html', verbatim: false, transform: transformHtml },
  { src: 'offline/pwa.js', dst: 'pwa.js', verbatim: true }
];

const FORBIDDEN_FILES = ['server.js', 'db.js', 'auth.js', 'botPool.js', 'gamelog.js', 'replay.js', 'node_modules'];

function transformHtml(html){
  const engineTag = '<script src="../gameEngine.js"></script>';
  if (!html.includes(engineTag)) throw new Error('offline/index.html: не найден тег ' + engineTag);
  // Движок рядом с index.html; URL Worker'а для localSession задаём явно
  // (по умолчанию он ищется в '../botWorker.js' — раскладка репозитория).
  return html.replace(engineTag,
    '<script>self.TOCHKI_BOT_WORKER_URL = \'botWorker.js\';</script>\n<script src="gameEngine.js"></script>')
    .replace('</head>', '<link rel="manifest" href="manifest.webmanifest">\n</head>')
    .replace('</body>', '<script src="pwa.js"></script>\n</body>');
}

// Проверки содержимого артефакта (без комментариев — чтобы не ловить
// упоминания в документации внутри файлов).
function stripComments(code){
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

function checkContent(name, text){
  const problems = [];
  const code = name.endsWith('.js') ? stripComments(text) : text;
  const rules = [
    [/require\(\s*['"]ws['"]\s*\)/, 'require("ws")'],
    [/require\(\s*['"]better-sqlite3['"]\s*\)/, 'require("better-sqlite3")'],
    [/\bnew\s+WebSocket\s*\(/, 'WebSocket'],
    [/\bfetch\s*\(/, 'fetch()'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bEventSource\b/, 'EventSource'],
    [/<(?:script|link|img|iframe)[^>]+(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i, 'внешний ресурс (CDN)'],
    [/importScripts\(\s*['"](?:https?:)?\/\//, 'importScripts с внешним URL'],
    [/@import\s+(?:url\()?\s*['"]?(?:https?:)?\/\//, 'CSS @import с внешним URL']
  ];
  for (const [re, label] of rules) if (re.test(code)) problems.push(name + ': ' + label);
  return problems;
}

function build(opts){
  const outDir = opts.out;
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = { builtFrom: 'tochki-multiplayer', files: [] };
  const problems = [];

  for (const f of FILES){
    const srcPath = path.join(ROOT, f.src);
    const srcBuf = fs.readFileSync(srcPath);
    const outBuf = f.verbatim ? srcBuf : Buffer.from(f.transform(srcBuf.toString('utf8')), 'utf8');
    const dstPath = path.join(outDir, f.dst);
    fs.writeFileSync(dstPath, outBuf);
    const written = fs.readFileSync(dstPath);
    if (f.verbatim && sha256(written) !== sha256(srcBuf))
      problems.push(f.dst + ': содержимое не совпадает с каноническим ' + f.src);
    problems.push(...checkContent(f.dst, written.toString('utf8')));
    manifest.files.push({ file: f.dst, source: f.src, verbatim: !!f.verbatim, bytes: written.length, sha256: sha256(written) });
  }

    const webmanifest = JSON.stringify({
    name: 'Точки — offline', short_name: 'Точки', lang: 'ru',
    start_url: './', scope: './', display: 'standalone',
    background_color: '#f6f4ee', theme_color: '#f6f4ee'
  }, null, 2) + '\n';
  fs.writeFileSync(path.join(outDir, 'manifest.webmanifest'), webmanifest);
  manifest.files.push({ file: 'manifest.webmanifest', source: 'tools/build-offline.js',
    bytes: Buffer.byteLength(webmanifest), sha256: sha256(webmanifest) });
  const template = fs.readFileSync(path.join(ROOT, 'offline/sw.js'), 'utf8');
  manifest.cacheVersion = sha256(JSON.stringify(manifest.files) + template);
  const resources = [...manifest.files.map(f => f.file), 'build-manifest.json'];
  const sw = template.replace('__VERSION__', manifest.cacheVersion)
    .replace('__RESOURCES__', JSON.stringify(resources));
  fs.writeFileSync(path.join(outDir, 'sw.js'), sw);

  const present = fs.readdirSync(outDir);
  for (const bad of FORBIDDEN_FILES) if (present.includes(bad)) problems.push('в артефакт попал ' + bad);

  if (problems.length){
    throw new Error('Сборка offline отклонена:\n  - ' + problems.join('\n  - '));
  }
  fs.writeFileSync(path.join(outDir, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { outDir, manifest };
}

if (require.main === module){
  try {
    const { outDir, manifest } = build(parseArgs(process.argv.slice(2)));
    console.log('offline build -> ' + path.relative(process.cwd(), outDir));
    for (const f of manifest.files) console.log('  ' + f.file.padEnd(16) + ' <- ' + f.source.padEnd(24) + ' ' + f.sha256.slice(0, 12));
  } catch (err){
    console.error(err.message || err);
    process.exit(1);
  }
}

module.exports = { build, transformHtml, checkContent, FILES };
