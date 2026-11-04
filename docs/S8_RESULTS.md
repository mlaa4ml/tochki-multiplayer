# S8 — результаты абляций (бот tochki-ab-1)

| Конфигурация | Сторона | Пар | Доля очков | ci95 | Разность очков | «до вилки» (S3) | p95 хода, мс | Узлы p95 / ср. | Версия бота |
|---|---|---|---|---|---|---|---|---|---|
| base — база (контроль: база против самой себя) | `strong:3000` | 10 | 0.5 | [0.5, 0.5] | 0 | 0/2 | 958 | 3000 / 2847 | tochki-ab-1 (engine tochki-rules-1, weights tochki-weights-1) |
| full — полная версия (monitor:true) | `strong:3000+monitor+safety2` | 10 | 0.075 | [0, 0.175] | -6.4 | 0/2 | 27561 | 3000 / 2859 | tochki-ab-1 (engine tochki-rules-1, weights tochki-weights-1) |
| no-monitor — без монитора | `strong:3000+safety2` | 10 | 0.75 | [0.55, 0.95] | 2.95 | 0/2 | 1202 | 3000 / 2840 | tochki-ab-1 (engine tochki-rules-1, weights tochki-weights-1) |
| no-solver — монитор без решателя | `strong:3000+monitor+no-solver+safety2` | 10 | 0 | [0, 0] | -14.2 | 0/2 | 1036 | 3000 / 2829 | tochki-ab-1 (engine tochki-rules-1, weights tochki-weights-1) |
| safety2-on — с фильтром safety2 (#55) | `strong:3000+safety2` | 20 | 0.688 | [0.563, 0.813] | 2.875 | 0/2 | 1087 | 3000 / 2841 | tochki-ab-1 (engine tochki-rules-1, weights tochki-weights-1) |
| safety2-off — без фильтра safety2 | `strong:3000+no-safety2` | 10 | 0.5 | [0.5, 0.5] | 0 | 0/2 | 1015 | 3000 / 2847 | tochki-ab-1 (engine tochki-rules-1, weights tochki-weights-1) |

| Узел | С узлом / без | Прирост доли очков | Решение |
|---|---|---|---|
| монитор + решатель | full / no-monitor | -0.675 | удалить/не включать (с узлом доказанно хуже базы) |
| решатель | full / no-solver | 0.075 | удалить/не включать (с узлом доказанно хуже базы) |
| safety2 | safety2-on / safety2-off | 0.188 | оставить (прирост есть) |

| Конфигурация | Включать по умолчанию | Причина |
|---|---|---|
| full | нет | ci95.hi 0.175 < 0.5 — доказанно хуже базы, отбросить |
| no-monitor | нет | кандидат: ci95.lo 0.55 > 0.5 на 10 парах, нужно подтверждение на 20 парах |
| no-solver | нет | ci95.hi 0 < 0.5 — доказанно хуже базы, отбросить |
| safety2-on | да | ci95.lo 0.563 > 0.5 на 20 парах (>= 20) |
| safety2-off | нет | ci95.lo 0.5 <= 0.5 — прироста нет |
