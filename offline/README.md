# Offline-лаборатория (A06, issue #11)

Человек–бот и бот–бот без игрового `server.js`, аккаунта, WebSocket, API и SQLite.

## Запуск (статическая раздача для разработки)

Worker нельзя загрузить через `file://`, поэтому нужна любая статическая
раздача **корня репозитория** (оттуда берутся `gameEngine.js` и `botWorker.js`):

```sh
python3 -m http.server 8080        # или: npx http-server -p 8080 .
# открыть http://localhost:8080/offline/index.html
```

`server.js`, `npm install`, `ws`, `better-sqlite3` не нужны. Страница загружает
только `gameEngine.js`, `offline/localSession.js` и `botWorker.js`; других
сетевых запросов нет (проверяется во вкладке Network).

## Статическая сборка (B01, issue #24)

Сборка кладёт в `dist/offline/` самодостаточный статический артефакт, который
можно раздавать любым статическим сервером:

```sh
npm run build:offline              # = node tools/build-offline.js [--out <папка>]
python3 -m http.server 8080 -d dist/offline   # или: npx http-server dist/offline -p 8080
# открыть http://localhost:8080/  (index.html)
```

Требуется только Node (см. `.node-version`) и любой статический сервер;
`npm install` для сборки **не нужен** — скрипт использует лишь встроенные
модули Node. `dist/` в `.gitignore`.

Состав артефакта (плоская папка):

| файл | источник |
|---|---|
| `gameEngine.js` | канонический `gameEngine.js` из корня, побайтно |
| `botWorker.js` | канонический `botWorker.js`, побайтно |
| `localSession.js` | `offline/localSession.js`, побайтно |
| `index.html` | `offline/index.html`; `../gameEngine.js` → `gameEngine.js`, задаётся `self.TOCHKI_BOT_WORKER_URL = 'botWorker.js'` |
| `build-manifest.json` | список файлов, источники и sha256 |

Ручной копии движка в репозитории нет: движок копируется из канонического
исходника при каждой сборке, и сборка падает, если sha256 копии не совпадает
с исходником. Сборка также падает, если в артефакте оказались `server.js`,
`db.js`, `auth.js`, `ws`, `better-sqlite3`, внешние URL (CDN) в
`src`/`href`/`importScripts`/`@import`, либо `WebSocket`/`fetch`/
`XMLHttpRequest`/`EventSource`.

Автотест: `node test/build-offline.js` (входит в `npm test`). Он собирает
артефакт во временную папку и проверяет:
- состав артефакта и совпадение sha256 с исходниками;
- что все ссылки `index.html` локальные и разрешаются внутри артефакта;
- что партия бот–бот на **собранных** файлах доводится до конца с настоящим
  Worker (`worker_threads`, тот же `botWorker.js`).

Ручная проверка артефакта в Chromium и Firefox:
1. Раздать `dist/offline`, как показано выше.
2. Довести партию до конца: человек–бот, затем бот–бот «▶ Запуск».
3. Во вкладке Network должны быть только `index.html`, `gameEngine.js`,
   `localSession.js` и `botWorker.js`, а также повторная загрузка
   `gameEngine.js` из Worker. Внешних доменов и WS/API-запросов быть не должно.

## PWA: игра без сети (B02, issue #25)

По решению автора в #25 реализован только PWA-вариант. Вариант с одним HTML-файлом для `file://` отложен в #40.

`npm run build:offline` дополнительно кладёт в `dist/offline/`:

| файл | что это |
|---|---|
| `sw.js` | Service Worker, собранный из шаблона `offline/sw.js`. Подставляются версия кеша (16 символов sha256 от содержимого всех кешируемых файлов, она же `cacheVersion` в `build-manifest.json`) и список ресурсов |
| `manifest.webmanifest` | Web App Manifest; в `index.html` добавлены `<link rel="manifest">` и регистрация SW |

В кеш попадают `index.html`, `gameEngine.js`, `botWorker.js`, `localSession.js` и `manifest.webmanifest`. Исключение из запрета `fetch()` при сборке сделано только для `sw.js`: это сам механизм кеша, и он работает только со своим origin.

Как это работает:
1. **Первая загрузка** идёт по HTTPS или с `http://localhost` (`npm run serve:offline`, GitHub Pages и т.п.). SW кладёт все ресурсы в кеш `tochki-offline-<версия>`, запрашивая их с `cache: 'reload'`.
2. **Без сети** ресурсы своего origin отдаются из кеша (cache-first), включая `botWorker.js` и его `importScripts('gameEngine.js')`. Навигация без сети получает `index.html`, поэтому партию можно доиграть и начать новую.
3. **Обновление:**
   - любая правка любого файла меняет версию, а значит и текст `sw.js`;
   - SW регистрируется с `updateViaCache: 'none'`, поэтому при следующем открытии онлайн браузер ставит новый SW;
   - новый SW вызывает `skipWaiting` и `clients.claim` и удаляет все прежние кеши `tochki-offline-*`, не трогая чужие;
   - страница показывает баннер «Загружена новая версия» с кнопкой «Перезагрузить». Автоперезагрузки нет, чтобы не оборвать партию.

Ограничения PWA-варианта:
- **Через `file://` не работает.** Service Worker доступен только в secure context (HTTPS или localhost). На `file://` страница показывает сообщение, что офлайн-кеш недоступен. Без поддержки SW или вне secure context тоже выводится явное сообщение.
- Офлайн работает только после первой загрузки с сервера в этом браузере и профиле. Очистка данных сайта удаляет кеш.
- Новая версия подхватывается только тогда, когда страница открыта при наличии сети.
- Отказ Worker обрабатывается как и без PWA: явное `workerError` и сообщение «Ошибка бота (Worker)», страница не зависает.

Автотест `test/build-offline.js` проверяет:
- подстановку версии и ресурсов в `sw.js`;
- детерминированность версии и её смену при изменении файла;
- в эмуляции Cache Storage:
  - install и activate;
  - удаление старого кеша;
  - отдачу всех ресурсов при отключённой сети;
  - замену кеша новой версией;
- отказ Worker (Worker недоступен или упал → `workerError`, без зависшего поиска).

Ручная проверка в Chromium и Firefox:
1. Выполнить `npm run serve:offline` и открыть http://localhost:8080.
2. DevTools → Application: SW активен, в Cache Storage есть `tochki-offline-<cacheVersion>`.
3. Network → Offline, перезагрузить страницу и доиграть партию с ботом до конца.
4. Изменить исходник, пересобрать и открыть страницу онлайн. Должен появиться баннер новой версии, а в Cache Storage остаться только новый кеш.

## Устройство

- `offline/localSession.js` — `createLocalSession(opts)`: единственный владелец
  `Engine.createMatch`. API: `newGame(options)`, `move(x,y)`, `snapshot()`,
  `undo()`, `end()`, `subscribe(listener)`, `dispose()`, плюс `start()`,
  `pause()`, `step()`, `setControllers()`, `setDelay()`, `status()`, `getReplay()`.
- Контроллер каждого места: `human` / `normal` / `strong` (+ свои веса);
  первый игрок — отдельная настройка `firstPlayer`.
- Ход бота считает `botWorker.js` в Web Worker. Запрос несёт
  `{gameId, revision, requestId}`; ответ применяется только при совпадении всех
  трёх и только через `match.applyMove`.
- restart / undo / end / pause / смена контроллеров / dispose вызывают
  `worker.terminate()` и увеличивают `revision` — запоздалые ответы отбрасываются.
- Следующий игрок — всегда `snapshot.current` (повторный ход при захвате —
  забота движка); после `gameOver` ничего не планируется.
- Отказ Worker (нет `Worker`, ошибка создания, `onerror`, ответ `error`,
  нелегальный ход) — явное состояние `workerError` и сообщение в UI.
  Синхронного fallback-поиска в основном потоке нет.

## Тесты

```sh
npm run test:offline   # node test/offline-session.js — fake Worker, гонки, партии до конца
```

## Ручная проверка в браузерах

Chromium и Firefox: strong на поле medium/big — кнопки и прокрутка отзывчивы
во время поиска; эмуляция мобильного экрана и touch (DevTools → device mode);
Network — только три скрипта; отказ Worker — например, временно переименовать
`botWorker.js`: на странице должно появиться «Ошибка бота (Worker)».
