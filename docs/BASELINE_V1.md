# Контрольный соперник: baseline v1

Исходный бот и правила, зафиксированные **до** перехода на классику (docs/RULES_V2.md). Baseline **не изменять** при будущих экспериментах с поиском/весами: новые версии бота сравниваются именно с ним.

- Файл: `baseline/gameEngine.v1.js` — побайтная копия `gameEngine.js` из `main` @ `4bfab9f`.
- SHA-256: `897302b1c3358e6914359e0d3488f4cf71363185381eca63f99f2bf5023aa30f`
  (проверка: `sha256sum baseline/gameEngine.v1.js` и `git show 4bfab9f:gameEngine.js | sha256sum` должны совпасть).
- Правила baseline — v1: очки за пленные точки и окружённые пустые клетки, своя пленная точка при перезахвате получает `dead = освободивший`, ход в `territory ≠ 0` запрещён, захват проверяется только за ходившего.
- Веса по умолчанию: `BOT_WEIGHTS = { potential: 6, cohesion: 1.2, stones: 0.15, liberty: 5 }`, `CAPTURED_WEIGHT = 100`.
- Уровни:
  - `normal`: `radius 2, candidateCap 10, timeLimit 220 мс, maxDepth 3, branch 5/4/3, quiescenceExt 2`
  - `strong`: `radius 4, candidateCap 20, timeLimit 2000 мс, maxDepth 6, branch 8/6/5, quiescenceExt 3`
- Окружение: Node 24.x (`.node-version`).

## Воспроизведение
Ход baseline-бота из фиксированной позиции:
```
node -e "const E=require('./baseline/gameEngine.v1.js');for(const d of ['normal','strong']){const m=E.createMatch({sizeKey:'medium'});m.applyMove(1,7,5);console.log(d, JSON.stringify(m.botMove(d)))}"
```
Поиск ограничен временем (`timeLimit`, итеративное углубление), поэтому на медленном CPU достигнутая глубина и, в редких позициях, выбранный ход могут отличаться; для строго детерминированного сравнения используйте одинаковое железо или сравнивайте по сериям партий (win-rate), а не по единичным ходам.

Целостность baseline проверяется перед экспериментами командой из раздела SHA-256; при несовпадении результаты сравнения недействительны.
