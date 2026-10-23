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
