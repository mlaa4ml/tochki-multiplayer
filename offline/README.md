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

В чистом checkout с Node.js 24 (без `npm install` и без зависимостей сервера):

```sh
npm run build:offline
npm run serve:offline
# открыть http://127.0.0.1:8080/
```

Для другого порта/интерфейса: `HOST=0.0.0.0 PORT=8081 npm run serve:offline`.
Альтернативная раздача: `python3 -m http.server 8080 -d dist/offline`.

Публикуйте **только `dist/offline/`**, а не корень репозитория. Сборка
пересоздаёт этот каталог по явному списку исходников:
`gameEngine.js`, `botWorker.js`, `offline/localSession.js`,
`offline/index.html`. Они переносятся побайтно из канонических исходников,
а не поддерживаются как отдельные копии движка. Корневой `index.html`
перенаправляет на `offline/index.html`; сохранение структуры каталогов
позволяет использовать неизменённые относительные URL скриптов и Worker
(в том числе при размещении под URL-префиксом).
`build-manifest.json` содержит исходные пути и SHA-256 файлов.

`server.js`, `node_modules`, `ws`, `better-sqlite3` в артефакт не включаются.
Во время игры нужны только локальные статические файлы; CDN, API и WS нет.
PWA и открытие через `file://` в эту сборку не входят.

### Проверки сборки

```sh
npm run test:build-offline
```

Тест включён также в `npm test`: проверяет точный состав артефакта,
побайтовое совпадение исходников, SHA-256, локальные ссылки скриптов,
HTTP-раздачу файлов и отсутствие серверных файлов по HTTP.

Для автоматической проверки настоящих браузеров установите тестовый
Playwright отдельно от приложения (Linux/macOS; установка браузеров на Linux
может потребовать sudo):

```sh
npm install --prefix /tmp/tochki-browser --no-audit --no-fund playwright
/tmp/tochki-browser/node_modules/.bin/playwright install --with-deps chromium firefox
PLAYWRIGHT_MODULE=/tmp/tochki-browser/package.json npm run test:offline-browser
```

Тест поднимает статический сервер на свободном порту и закрывает его после
проверки. В Chromium и Firefox он играет через реальный UI: человек–бот
до порога заполнения 10%, затем бот–бот до естественного конца на small.
Используется настоящий Web Worker и канонический движок; только в тесте
поиск ограничен 30 узлами для быстрого прогона. Проверяются финальный статус,
отсутствие ошибок страницы, внешних запросов, fetch/XHR и WebSocket.
`BROWSER=chromium` или `BROWSER=firefox` выбирает один браузер;
`BROWSER_REPORT=/tmp/offline-browser.json` сохраняет JSON-результат.
Playwright не входит ни в runtime-зависимости, ни в статический артефакт.

Для ручной приёмки откройте адрес статической раздачи в Chromium и Firefox,
сыграйте человек–бот и запустите бот–бот до «Партия окончена».
Во вкладке Network ожидаются только локальные документы, `gameEngine.js`,
`offline/localSession.js`, `botWorker.js` (Worker повторно загружает движок);
API/WS и внешних доменов быть не должно.

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
