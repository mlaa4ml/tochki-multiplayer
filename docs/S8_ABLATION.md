# S8. Абляции и итоговая проверка силы бота (issue #62)

Часть дорожной карты #53 (`docs/MONITOR_ROADMAP.md`), п. 9 Плана
(«Как проверять, что бот стал сильнее»). Зависит от S4 (#58, парный матч)
и S7 (#61, арбитр).

## Что добавлено в код

- `tools/bench/paired-match.js`: у стороны появились флаги через `+`:
  `strong:3000[:weights.json]+monitor+no-solver+safety2+no-safety2+antiFork+no-antiFork`.
  - `monitor` — ход выбирает `arbiterMove` (`arbiter.js`, `opts.monitor:true`);
  - `no-solver` — арбитр без локального решателя (только вместе с `monitor`);
  - `safety2`/`no-safety2`, `antiFork`/`no-antiFork` — переопределение полей уровня
    (копия, `E.DIFFICULTY` не меняется).
  - Сторона без флагов играет ровно как раньше (`Runner.makeSearchPlayer`).
  - Флаги сохраняются в `params` отчёта и в подписи стороны.
- `arbiter.js`: опция `arbiter.solver` (по умолчанию `true`, поведение S7 не меняется).
  При `solver:false` тревожные группы считаются потерянными, работает только
  ограничение ущерба — это абляция «без решателя».
- `tools/bench/s8-ablation.js`: прогон конфигураций шардами и сборка таблицы.
- `test/s8-ablation.js`: разбор флагов, совпадение ходов с базой, арбитр без
  решателя, правила решения.

## Конфигурации

Все конфигурации играют парный матч против `base` на одинаковых дебютах
(полное поле, fill 64%, старт «крест», ≥ 50 пар, каждая пара — обе стороны).

| Имя | Сторона | Смысл |
|---|---|---|
| `base` | `strong:3000` | база; строка-контроль (база против самой себя, ожидается 0.5) |
| `full` | `strong:3000+monitor+safety2` | полная версия (`monitor:true`) |
| `no-monitor` | `strong:3000+safety2` | без монитора |
| `no-solver` | `strong:3000+monitor+no-solver+safety2` | монитор без решателя |
| `safety2-on` | `strong:3000+safety2` | с фильтром `safety2` (#55) |
| `safety2-off` | `strong:3000+no-safety2` | без фильтра `safety2` |

Тактика (набор `regression` из #57, `tools/bench/corpus/prefork.regression.json`)
считается в шарде, который начинается с пары 0.

## Таблица п. 9 Плана

Заполняется командой `node tools/bench/s8-ablation.js --table --out-dir out/s8 --md docs/S8_RESULTS.md`.
Шаблон (значения — после прогона у владельца, см. issue #62):

| Конфигурация | Пар | Доля очков | ci95 | Разность очков | «до вилки» (S3) | p95 хода, мс | Узлы p95 / ср. | Версия бота |
|---|---|---|---|---|---|---|---|---|
| base | — | — | — | — | — | — | — | — |
| full | — | — | — | — | — | — | — | — |
| no-monitor | — | — | — | — | — | — | — | — |
| no-solver | — | — | — | — | — | — | — | — |
| safety2-on | — | — | — | — | — | — | — | — |
| safety2-off | — | — | — | — | — | — | — | — |

## Правила решения

1. **Флаг включается по умолчанию только при `ci95.lo > 0.5`** против базы и
   при ≥ 50 пар (`decisions.flags` в `out/s8/table.json`).
2. **Узел без прироста удаляется** (`decisions.nodes`):
   - «монитор + решатель»: `full` против `no-monitor`;
   - «решатель»: `full` против `no-solver`;
   - `safety2`: `safety2-on` против `safety2-off`.
   Узел остаётся, только если конфигурация с ним доказанно лучше базы
   (`ci95.lo > 0.5`) и её доля очков выше, чем без него.
3. **Версия бота** (`BOT_VERSION`, `ENGINE_VERSION`, `WEIGHTS_VERSION`)
   пишется в каждый отчёт и в `table.json`; после решения она заносится в
   журнал версий ниже.
4. **Партии с человеком — только контроль.** Версия по ним не выбирается
   (6 партий ничего не доказывают). В S8 они не используются вовсе: дебюты —
   префиксы партий `dev`/`regression`, `holdout` не трогается.

## Как запускать

Одна пара `full` (2 партии) в Codespace заняла ≈105 с, то есть 50 пар —
≈1,5 ч на конфигурацию, все шесть — 6–9 ч. В лимиты Codespace
(300 с на команду, 1800 с на задачу) это не укладывается, поэтому прогон
выполняется у владельца:

```bash
git checkout anthropic-claude-opus-5-5-default-issue-62
node test/s8-ablation.js                       # быстрая проверка
# по конфигурациям, можно параллельно в разных терминалах:
for c in base full no-monitor no-solver safety2-on safety2-off; do
  node tools/bench/s8-ablation.js --config $c --out-dir out/s8 --quiet &
done; wait
# или шардами: --config full --from 0 --to 25, затем --from 25 --to 50
node tools/bench/s8-ablation.js --table --out-dir out/s8 --md docs/S8_RESULTS.md
```

## Журнал версий

| Дата | BOT_VERSION | Включённые флаги | Основание |
|---|---|---|---|
| — | (текущая) | `monitor:false`, `safety2:false`, `antiFork:false` | до результатов S8 флаги выключены |
