# Замороженный контрольный соперник original-bot-v1

Каталог `baselines/original-v1/` — неизменяемый эталон A01, а не вторая
актуальная реализация production-движка. Он получен командой
`git show 4bfab9f4bc310c87096318dd31e870711fc037a6:gameEngine.js`
без правок. В будущих экспериментах изменять основной движок, а не этот
каталог; для другого baseline создавать новый версионированный каталог.

- Исходная ревизия: `4bfab9f4bc310c87096318dd31e870711fc037a6`.
- SHA-256 файла: `897302b1c3358e6914359e0d3488f4cf71363185381eca63f99f2bf5023aa30f`.
- Правила: [tochki-rules-v1](RULES_V1.md), пока ожидающие согласования автора.
- Среда: Node 24.x; проверено в Codespaces Linux x64, Node v24.21.0.
- Веса: potential=6, cohesion=1.2, stones=0.15, liberty=5.
  Вес захваченной клетки в исходном коде — 100.
- normal: radius=2, candidateCap=10, timeLimit=220 ms, maxDepth=3,
  branchWide/Mid/Narrow=5/4/3, quiescenceExt=2.
- strong: radius=4, candidateCap=20, timeLimit=2000 ms, maxDepth=6,
  branchWide/Mid/Narrow=8/6/5, quiescenceExt=3.

Все параметры, настройки матча и дебют находятся в машиночитаемом
`manifest.json`. Это ручные исходные веса, не веса из SQLite и не TRAIN_DIFF.
Runner не импортирует основной `gameEngine.js`, БД или обученные веса.

## Команды

Из корня репозитория:

```sh
node --version                   # 24.x
npm ci
npm run test:engine              # чистые правила, Node + браузерная UMD-ветка
npm run test:baseline            # SHA-256, веса, обе сложности
npm run baseline:v1 -- normal
npm run baseline:v1 -- strong
npm run baseline:v1 -- normal --fixed-clock
npm test                        # включая все прежние сетевые/интеграционные тесты
```

Команды baseline делают **один ход** после фиксированного дебюта
`1:(5,4), 2:(6,4)` на small; firstPlayer=1, extraTurnOnCapture=false,
targetScore=0, targetFillPercent=100, undoAllowed=true.
Вывод JSON содержит идентификатор, ревизию, hash, ОС/архитектуру/Node,
параметры, ход, результат перехода и время. Можно сохранить stdout:
`node tools/baseline-v1.js normal > baseline-normal.json`.
Runner проверяет легальность хода и отсутствие мутации матча поиском.
Это воспроизведение контрольного соперника, не измерение силы и не
полный парный benchmark (A07).

## Что именно воспроизводимо

Оригинальный поиск ограничен **настенными часами**, поэтому одинаковые
исходники, веса и позиция не гарантируют одинаковый ход strong на другом
CPU или при другой нагрузке. Исправлять таймер или поиск внутри baseline
запрещено: известные ограничения описаны в BOT_ANALYSIS и вынесены в A03/A04.

Для точной диагностики есть отдельный `--fixed-clock`: тот же неизменённый
UMD-файл запускается в VM с `performance.now() = 0`, поиск заканчивается
по исходной максимальной глубине, а не дедлайну. На зафиксированном дебюте
normal проверен ход `(4,4)`. Время выполнения в JSON всегда реальное и
не является частью детерминированного результата. Это **не** исходная
игровая сложность по времени; нельзя сравнивать её с timed-ботом и
выдавать результат за рост силы. Для strong этот режим может быть дорогим;
обычный smoke запускает strong с оригинальным лимитом 2000 ms.

## Использование в будущем сравнении

```js
const baseline = require('../baselines/original-v1/gameEngine');
const manifest = require('../baselines/original-v1/manifest.json');
const match = baseline.createMatch(manifest.matchOptions);
// Внешний runner применяет одинаковые легальные ходы обеих сторон.
const move = match.botMove('normal', manifest.weights);
```

Либо использовать экспортированный `chooseMove` для позиции с согласованной
семантикой. Не заменять baseline новыми весами по умолчанию, общим новым
поиском или новыми правилами. Проверка hash намеренно имеет независимую
константу в runner, чтобы случайное изменение manifest вместе с копией
движка не прошло незаметно.
