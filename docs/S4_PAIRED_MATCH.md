# S4: измерительная база — парный матч (issue #58)

Инструмент: `tools/bench/paired-match.js`, тест: `test/paired-match.js`.

## Зачем

На корпусе `fill30` (`benchmark.js`) 8–9 партий из 12 заканчивались 0:0. Из-за этого любой кандидат получал 0.5. Парный матч S4 убирает эту проблему за счёт других условий.

## Условия

- Полное поле, правила `fill 64%`, `targetScore 0` (без порога очков), старт «крест». Это правила реальных партий корпуса.
- Дебюты — префиксы реальных партий из частей `dev` и `regression` манифеста `tools/bench/corpus/human/manifest.json`. Длина префикса: `--min-ply` + `--ply-step`·k. Партии берутся по кругу. Часть `holdout` не используется.
- Пара — две партии из одной позиции, стороны в них меняются местами. По умолчанию 50 пар (100 партий).
- Сторона задаётся как `уровень:лимитУзлов[:веса.json]`. Лимит узлов детерминированный, таймер выключен.

## Вывод (`summary` в JSON)

| Поле | Что значит |
|---|---|
| `scoreDiffMean` | средняя разность очков «кандидат − база» |
| `candPointsMean`, `basePointsMean` | средние очки сторон |
| `nonZeroShare` | доля партий со счётом не 0:0 |
| `decisiveShare` | доля партий не вничью |
| `score` | доля очков кандидата |
| `ci95` | bootstrap по парам; критерий проекта `ci95.lo > 0.5` → `candidateBetter` |
| `ci95ByGame` | справочно: кластеры по исходной партии |
| `timing.*.msP95`, `nodesP95`, `nodesMean` | p95 времени хода и узлы |
| `tactics` | метрика S3 (#57): сколько позиций «до вилки» из `prefork.regression.json` (без `holdout`) сторона решает спасающим ходом |

## Команды

```bash
# проверка чувствительности: strong/3000 против normal/300 (по умолчанию)
node tools/bench/paired-match.js --sensitivity --out r.json

# кандидат против базы
node tools/bench/paired-match.js --candidate strong:3000:cand.json --base strong:3000 --out r.json

# шардирование под лимит Codespace (≈35 с на пару при strong/3000 против normal/300)
node tools/bench/paired-match.js --sensitivity --from 0 --to 5 --out p0.json
node tools/bench/paired-match.js --sensitivity --from 5 --to 10 --out p1.json
# ...
node tools/bench/paired-match.js --merge p0.json p1.json ... --out tools/bench/reports/s4-baseline.json
```

Если чувствительность не подтверждена на 50 и более парах, код выхода равен 2. В этом случае исправляется тест, а не используется как есть.

## Проверка чувствительности (первые данные)

`tools/bench/reports/s4-sensitivity-part0.json` — пары 0–4:

- счёт `+8 =0 −2`, доля очков 0.8, `ci95 [0.6, 1]`;
- не 0:0 — 100% партий;
- разность очков +4.5;
- p95 хода: 684 мс / 3000 узлов против 53 мс / 300 узлов.

Тест различает уровни уже на 5 парах. Полный прогон на 50 пар занимает около 30 минут и не укладывается в лимит Codespace. Инструкция для запуска у владельца — в issue #58.
