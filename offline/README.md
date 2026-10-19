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
