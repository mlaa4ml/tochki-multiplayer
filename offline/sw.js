// offline/sw.js — Service Worker PWA-варианта offline-игры (B02, issue #25).
//
// Это ШАБЛОН: tools/build-offline.js подставляет вместо плейсхолдеров
// версию кеша (sha256 от содержимого всех файлов артефакта) и список
// ресурсов, и кладёт результат в dist/offline/sw.js. Из репозитория
// напрямую (offline/index.html через ../) этот файл не регистрируется.
//
// Модель:
//   - install: все ресурсы артефакта кладутся в кеш с именем
//     'tochki-offline-<версия>' (запросы с cache:'reload', мимо HTTP-кеша);
//   - activate: удаляются все прочие кеши 'tochki-offline-*' (старые версии),
//     SW берёт под контроль открытые вкладки;
//   - fetch: same-origin GET отдаётся из кеша (cache-first), промах —
//     в сеть; навигация без сети падает обратно на index.html.
// Новая версия = новые sha256 файлов = новый текст sw.js -> браузер
// устанавливает новый SW, он вызывает skipWaiting(), а страница показывает
// сообщение «доступна новая версия — перезагрузите».
//
// Ограничение: Service Worker работает только в secure context
// (HTTPS или http://localhost). Через file:// он недоступен.
'use strict';

const CACHE_PREFIX = 'tochki-offline-';
const CACHE_VERSION = '__CACHE_VERSION__';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const ASSETS = __ASSETS__;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'get-version' && event.source){
    event.source.postMessage({ type: 'version', version: CACHE_VERSION });
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(req, { ignoreSearch: true }).then(hit => {
        if (hit) return hit;
        return fetch(req).catch(err => {
          if (req.mode === 'navigate') {
            return cache.match('index.html').then(page => page || Promise.reject(err));
          }
          throw err;
        });
      })
    )
  );
});
