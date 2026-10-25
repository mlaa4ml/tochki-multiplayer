# B05 — достоверный подбор и публикация весов оценки (issue #28)

Это не повтор #2: там чинился интеграционный smoke-тест обучения
(таймаут, Node/SQLite). Здесь описана методика отбора весов.

## Поток: подбор → независимая проверка → публикация → откат

```
tools/train-bot.js        подбор на TRAIN, пишет файл-кандидат (НЕ в БД)
tools/bench/benchmark.js  независимый парный benchmark на TEST
tools/publish-weights.js  публикация по критерию; --status; --rollback
```

`train-bot.js` больше не вызывает `saveBotWeights`. Результат отбора на
обучающих партиях не публикуется автоматически: веса попадают в таблицу
`bot_weights`, которую читает сервер, только через `publish-weights.js`.
`POST /api/admin/train` тоже лишь создаёт файл
`weights-candidate-<difficulty>-<seed>.json` рядом с БД.

## Разделение дебютов

- **train** — дебюты людей из БД и набор `train` корпуса
  `tools/bench/corpus/openings.v1.json`. Используются только в
  `train-bot.js`, функция `loadCorpusTrainOpenings`.
- **validation** — для промежуточного сравнения вариантов:
  `benchmark.js --split validation`.
- **test** — только для решения о публикации: `benchmark.js --split test`.
  `publish-weights.js` отклоняет отчёт с любым другим split.

`benchmark.js` отказывается измерять `split=train`. `train-bot.js` никогда
не читает validation и test.

## Равные бюджеты поиска

`normal` и `strong` сравниваются только при одинаковом детерминированном
лимите узлов: один и тот же `--node-limit` для обеих сложностей в одном
прогоне benchmark. Параметры каждой сложности записываются в отчёт
(`params.difficultyParams`). Сравнение отчётов с разными `--node-limit`
некорректно.

## Пул замороженных соперников

Источник — `tools/bench/baseline/weights.v1.json`: baseline плюс `pool`.
Файл не меняется; новая версия пула оформляется новым файлом.

- В `train-bot.js` fitness кандидата — средний winRate против текущего
  эталона и всех замороженных соперников. Это защищает от «переобучения»
  под последнего эталона. Флаги: `--baseline <file>`, `--no-pool`.
- В benchmark кандидат играет против того же пула: он загружается из
  `--baseline` (по умолчанию `weights.v1.json`).

## Невалидные префиксы и обрезанные партии

- Каждый дебют проверяется строго через `Runner.applyPrefix`, как в
  benchmark. Дебют с нелегальным ходом или с окончанием партии внутри
  префикса отклоняется явно: выводится предупреждение `Дебют отклонён: …`,
  а случай учитывается в `bundle.selection.rejectedOpenings`.
  Раньше такой дебют молча обрезался (`break`).
- В `playSelfPlayGame` нелегальный ход префикса бросает ошибку.
- Партии, упёршиеся в лимит ходов, считаются отдельно:
  - в `train-bot.js` — `bundle.selection.truncatedGames`;
  - в benchmark — `truncationRate` по каждой конфигурации.

## Версионирование «веса + правила + код»

Файл-кандидат (`format: tochki-weights-candidate`) содержит:

- веса и сложность;
- `bundle`: `engineVersion`, `botVersion`, `baseWeightsVersion`, git-коммит;
- параметры отбора: split, sizeKey, seed, поколения, популяция, число
  партий, `fillPercent`, `nodeLimit`, число дебютов и отклонённых дебютов,
  число обрезанных партий.

Правила каждого дебюта хранятся в корпусе, у которого есть версия.

При публикации в `bot_weights.note` записывается JSON
(`format: tochki-weights-publication`). В нём:

- `bundle` с версиями движка и бота и коммитом отчёта;
- сводка test-отчёта (`vsBaseline` с W/D/L по конфигурациям в самом отчёте);
- `previous` — предыдущая активная версия весов для отката.

`publish-weights.js` отклоняет отчёт или кандидата, если они получены на
другой версии движка или бота.

## Критерий публикации (выбран заранее)

```
vsBaseline.ci95.lo > 0.5   на split=test
correctnessErrors = 0
веса в отчёте == веса кандидата
```

95% интервал считается кластерным bootstrap по исходным дебютам. Пара —
это две партии из одной позиции со сменой цветов, её счёт равен
(очки₁ + очки₂) / 2. Все прогоны одного дебюта ресэмплируются вместе, так
что парность и корреляция учтены. W/D/L приводится в `configs[]` отчёта.

Регрессии корректности проверяет `npm test`, включая контракт A01
(`test/rules.js`) и `test/publish-weights.js`.

## Команды

```bash
# 1. Подбор (train). Пишет кандидата, БД не меняет.
node tools/train-bot.js --difficulty strong --size small --node-limit 300 \
  --generations 4 --population 4 --games 8 --seed 1 --out cand.json

# 2. Независимая проверка на test (одинаковый --node-limit для normal и strong).
node tools/bench/benchmark.js --split test --sizes small,medium \
  --difficulties normal,strong --node-limit 300 --runs 2 \
  --candidate cand.json --out test-report.json
#   (формат --candidate и прочие флаги см. docs/BENCHMARK.md)

# 3. Проверка критерия без записи в БД.
node tools/publish-weights.js --check --candidate cand.json --report test-report.json

# 4. Публикация. Отказ, если критерий не выполнен.
node tools/publish-weights.js --candidate cand.json --report test-report.json --db ./data/tochki.db

# Текущая версия и её предыдущая.
node tools/publish-weights.js --status --difficulty strong --db ./data/tochki.db

# 5. Откат на предыдущую версию.
node tools/publish-weights.js --rollback --difficulty strong --db ./data/tochki.db
```

Сервер подхватывает новые веса из `bot_weights` на следующем ходе бота,
поэтому откат вступает в силу без перезапуска. Откат не удаляет историю:
он добавляет запись с `source='rollback'`. Повторный `--rollback` уходит
дальше по истории; последний шаг возвращает веса движка
(`Engine.BOT_WEIGHTS`).

Проверка откатов — `test/publish-weights.js`:

- публикация W1, затем W2;
- откат W2 → W1;
- откат W1 → веса движка;
- отказ в публикации ничего не пишет в БД.

## Статус

Инструменты и процедура готовы. Новые веса публикуются только тогда,
когда test-отчёт удовлетворяет критерию. Если отчёт показывает
`lo <= 0.5`, действующие веса остаются без изменений; такой
отрицательный результат — тоже результат.
