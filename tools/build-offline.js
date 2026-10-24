#!/usr/bin/env node
// tools/build-offline.js — статическая сборка offline-приложения (B01, issue #24)
// + PWA-вариант (B02, issue #25).
//
// Собирает в dist/offline/ самодостаточный статический артефакт:
//   index.html      — offline UI (из offline/index.html, пути переписаны,
//                     добавлены ссылка на манифест и регистрация Service Worker);
//   localSession.js — offline/localSession.js без изменений;
//   botWorker.js    — канонический botWorker.js без изменений;
//   gameEngine.js   — КАНОНИЧЕСКИЙ gameEngine.js из корня репозитория,
//                     копируется побайтно при каждой сборке (ручной копии
//                     движка в репозитории нет и быть не должно);
//   manifest.webmanifest — Web App Manifest (генерируется);
//   sw.js           — Service Worker из шаблона offline/sw.js: версия кеша =
//                     sha256 от содержимого всех кешируемых файлов, список
//                     ресурсов = все файлы артефакта (кроме sw.js и
//                     build-manifest.json);
//   build-manifest.json — список файлов, их источники, sha256 и cacheVersion.
//
// Сборка падает, если:
//   - копия движка/Worker'а не совпадает с исходником по sha256;
//   - в артефакт попал server.js / ws / better-sqlite3 / db.js / auth.js;
//   - артефакт ссылается на внешние URL (CDN) или WebSocket/fetch/XHR
//     (исключение: fetch() в sw.js — это сам механизм офлайн-кеша, он
//     обращается только к ресурсам своего origin).
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
    { src: 'replay.js', dst: 'replay.js', verbatim: true },
  { src: 'offline/storage.js', dst: 'storage.js', verbatim: true },
  { src: 'offline/replayUI.js', dst: 'replayUI.js', verbatim: true },
  { src: 'offline/localSession.js', dst: 'localSession.js', verbatim: true },
  { src: 'offline/index.html', dst: 'index.html', verbatim: false, transform: transformHtml }
];

const SW_TEMPLATE = 'offline/sw.js';
const SW_FILE = 'sw.js';
const WEBMANIFEST_FILE = 'manifest.webmanifest';

const FORBIDDEN_FILES = ['server.js', 'db.js', 'auth.js', 'botPool.js', 'gamelog.js', 'node_modules'];

// Разрешённые исключения из checkContent по имени файла.
const CONTENT_ALLOW = { 'sw.js': ['fetch()'] };

const PWA_HEAD =
  '<link rel="manifest" href="manifest.webmanifest">\n' +
  '<meta name="theme-color" content="#f6f4ee">\n';

// Регистрация Service Worker. Только в secure context (HTTPS/localhost);
// на file:// и в браузерах без SW — явное сообщение, игра при этом работает
// как обычная страница. Новая версия: SW сам ставится и чистит старый кеш,
// страница показывает баннер с кнопкой перезагрузки (без авто-перезагрузки,
// чтобы не оборвать идущую партию).
const PWA_BODY = [
  '<div id="pwa" style="display:none;margin:8px 0;padding:6px 8px;border:1px solid #c9b458;background:#fff7d6"></div>',
  '<script>',
  '(function(){',
  '  \'use strict\';',
  '  var box = document.getElementById(\'pwa\');',
  '  function say(text, withReload){',
  '    box.textContent = text + \' \';',
  '    if (withReload){',
  '      var b = document.createElement(\'button\');',
  '      b.textContent = \'Перезагрузить\';',
  '      b.onclick = function(){ location.reload(); };',
  '      box.appendChild(b);',
  '    }',
  '    box.style.display = \'block\';',
  '  }',
  '  if (location.protocol === \'file:\'){',
  '    say(\'Страница открыта через file:// — офлайн-кеш (PWA) недоступен: Service Worker работает только по HTTPS или на localhost.\');',
  '    return;',
  '  }',
  '  if (!(\'serviceWorker\' in navigator) || !window.isSecureContext){',
  '    say(\'Офлайн-кеш недоступен: браузер не поддерживает Service Worker или страница открыта не по HTTPS/localhost. Игра работает только при доступе к серверу.\');',
  '    return;',
  '  }',
  '  var hadController = !!navigator.serviceWorker.controller;',
  '  navigator.serviceWorker.addEventListener(\'controllerchange\', function(){',
  '    if (hadController) say(\'Загружена новая версия игры. Перезагрузите страницу, чтобы её применить (текущая партия будет потеряна).\', true);',
  '    hadController = true;',
  '  });',
  '  window.addEventListener(\'load\', function(){',
  '    navigator.serviceWorker.register(\'sw.js\', { updateViaCache: \'none\' }).catch(function(e){',
  '      say(\'Не удалось включить офлайн-кеш: \' + ((e && e.message) || e));',
  '    });',
  '  });',
  '})();',
  '</script>',
  ''
].join('\n');

function transformHtml(html){
  const engineTag = '<script src="../gameEngine.js"></script>';
  if (!html.includes(engineTag)) throw new Error('offline/index.html: не найден тег ' + engineTag);
  if (!html.includes('</head>')) throw new Error('offline/index.html: не найден </head>');
  if (!html.includes('</body>')) throw new Error('offline/index.html: не найден </body>');
  // Движок рядом с index.html; URL Worker'а для localSession задаём явно
  // (по умолчанию он ищется в '../botWorker.js' — раскладка репозитория).
  return html
    .replace(engineTag, '<script>self.TOCHKI_BOT_WORKER_URL = \'botWorker.js\';</script>\n<script src="gameEngine.js"></script>')
        .replace('<script src="../replay.js"></script>', '<script src="replay.js"></script>')
    .replace('</head>', PWA_HEAD + '</head>')
    .replace('</body>', PWA_BODY + '</body>');
}

function makeWebManifest(){
  return JSON.stringify({
    name: 'Точки — offline',
    short_name: 'Точки',
    lang: 'ru',
    start_url: './index.html',
    scope: './',
    display: 'standalone',
    background_color: '#f6f4ee',
    theme_color: '#f6f4ee'
  }, null, 2) + '\n';
}

// Версия кеша — от содержимого всех кешируемых файлов: любая правка любого
// файла (движок, UI, Worker, сессия, манифест) даёт новую версию.
function computeCacheVersion(entries){
  const h = crypto.createHash('sha256');
  for (const e of entries.slice().sort((a, b) => a.file < b.file ? -1 : 1)) h.update(e.file + ':' + e.sha256 + '\n');
  return h.digest('hex').slice(0, 16);
}

function renderServiceWorker(template, version, assets){
  for (const ph of ["'__CACHE_VERSION__'", '__ASSETS__']){
    if (template.split(ph).length !== 2) throw new Error(SW_TEMPLATE + ': плейсхолдер ' + ph + ' должен встречаться ровно один раз');
  }
  return template
    .replace("'__CACHE_VERSION__'", JSON.stringify(version))
    .replace('__ASSETS__', JSON.stringify(assets));
}

// Проверки содержимого артефакта (без комментариев — чтобы не ловить
// упоминания в документации внутри файлов).
function stripComments(code){
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

function checkContent(name, text){
  const problems = [];
  const code = name.endsWith('.js') ? stripComments(text) : text;
  const allow = CONTENT_ALLOW[name] || [];
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
  for (const [re, label] of rules){
    if (allow.includes(label)) continue;
    if (re.test(code)) problems.push(name + ': ' + label);
  }
  return problems;
}

// opts.overrides: { 'gameEngine.js': Buffer } — подмена содержимого
// исходников (только для тестов: проверка смены версии кеша).
function build(opts){
  const outDir = opts.out;
  const overrides = opts.overrides || {};
  const readSrc = rel => overrides[rel] !== undefined ? Buffer.from(overrides[rel]) : fs.readFileSync(path.join(ROOT, rel));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = { builtFrom: 'tochki-multiplayer', cacheVersion: null, files: [] };
  const problems = [];

  function emitFile(dst, source, verbatim, outBuf, srcBuf){
    const dstPath = path.join(outDir, dst);
    fs.writeFileSync(dstPath, outBuf);
    const written = fs.readFileSync(dstPath);
    if (verbatim && sha256(written) !== sha256(srcBuf))
      problems.push(dst + ': содержимое не совпадает с каноническим ' + source);
    problems.push(...checkContent(dst, written.toString('utf8')));
    manifest.files.push({ file: dst, source, verbatim: !!verbatim, bytes: written.length, sha256: sha256(written) });
  }

  for (const f of FILES){
    const srcBuf = readSrc(f.src);
    const outBuf = f.verbatim ? srcBuf : Buffer.from(f.transform(srcBuf.toString('utf8')), 'utf8');
    emitFile(f.dst, f.src, f.verbatim, outBuf, srcBuf);
  }
  emitFile(WEBMANIFEST_FILE, 'generated', false, Buffer.from(makeWebManifest(), 'utf8'));

  // Кешируемые ресурсы = всё, что уже записано (sw.js и build-manifest.json
  // в кеш не кладутся: обновление SW браузер проверяет по сети сам).
  const cached = manifest.files.slice();
  const version = computeCacheVersion(cached);
  manifest.cacheVersion = version;
  const swText = renderServiceWorker(readSrc(SW_TEMPLATE).toString('utf8'), version, cached.map(e => e.file));
  emitFile(SW_FILE, SW_TEMPLATE, false, Buffer.from(swText, 'utf8'));

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
    console.log('offline build -> ' + path.relative(process.cwd(), outDir) + ' (cache ' + manifest.cacheVersion + ')');
    for (const f of manifest.files) console.log('  ' + f.file.padEnd(22) + ' <- ' + f.source.padEnd(24) + ' ' + f.sha256.slice(0, 12));
  } catch (err){
    console.error(err.message || err);
    process.exit(1);
  }
}

module.exports = { build, transformHtml, checkContent, computeCacheVersion, renderServiceWorker, FILES };
