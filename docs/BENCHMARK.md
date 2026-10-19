# Independent bot benchmark (A07)

## Decision rule, fixed before the first experiment

An improvement is accepted only on the held-out **test** split when the lower
bound of the 95% paired-opening cluster bootstrap interval for candidate score
against `baseline-v1` is **strictly greater than 0.5**, with no correctness
errors and no truncated games. The score is win=1, draw=0.5, loss=0.
Validation is exploratory and can never accept an improvement. No runner or
benchmark writes or publishes weights. This infrastructure alone is not an
improvement in playing strength.

Freeze this rule, corpus and baseline before experiments; do not move the
threshold or select seeds after seeing results. Use train only in a separate
weight-selection process; neither validation nor test may enter training.
`tools/train-bot.js` remains separate and does not import this corpus.

## Contract and replay

`tools/bench/runner.js` is a pure UMD module. In a browser load `gameEngine.js`
then `tools/bench/runner.js`; use `TochkiRunner`. In Node require the runner.
No SQLite, server, storage or dependency installation is needed.

`runMatch({options, prefix, players, maxMoves, maxTimeMs, metadata, onLine})`
creates a match, strictly applies the prefix, repeatedly snapshots, calls the
current player's synchronous `chooseMove(snapshot)` and checks `applyMove`.
A player returns `{move:{x,y}, trace}` (or just `{x,y}`). Additional turns use
the actual current player, not alternation. A null/illegal move throws
`InvalidMoveError`, never a draw. JSONL contains header, checked moves with
search diagnostics, and terminal snapshot. `replayLines(jsonl)` verifies the
whole snapshot and outcome. Truncation by moves/time is not a terminal draw;
no manual `endNow` is used. A synchronous move can overrun the time cap: it is
recorded then classified; the cap is not a hard interrupt.

## Corpus v1

Generate the committed JSON with:
`node tools/bench/corpus.js > tools/bench/corpus/openings.v1.json`.

Versioned synthetic openings cover small/medium/large and disjoint
train/validation/test prefixes. Validation rejects illegal prefixes, wrong
players, terminal positions, duplicate IDs and cross-split prefix leakage.
Tactical capture-in-one positions have checked legal expected moves and score
gain; strategic safety positions specify a forbidden immediate suicide.
These modest safety constraints are not an oracle for long-term strategy.
The corpus is synthetic, small and correlated by symmetry, not a representative
human-game distribution. A future independently curated corpus should be frozen
before drawing strength conclusions.

## Commands

Node 24, repository root. Fast smoke: `npm run test:bench` (also in `npm test`).
Trial: `npm run bench -- --out tools/bench/reports/sample.json`.
Full evaluation:
`npm run bench:full -- --out tools/bench/reports/full.json`.
Optional flags: `--split validation|test`, `--seed 12012`, `--runs 3`,
`--nodes 200`, `--openings 8`, `--full`, `--out PATH`.
The full matrix uses normal/strong, all fields, standard/extra-turn/score rules,
baseline and two frozen-weight opponents. It can take hours; do not put it in
ordinary `npm test`. JSONL game records are stored next to the report in
`<report>.games.jsonl` (one line per complete game, including its replay records).
No duration or strength is promised by the trial. Reduce openings/nodes for
local checks, never silently compare different budgets.

A pair means the *same exact opening and rules* twice, with the candidate
assigned seat 1 then seat 2, equal node limits and difficulty for both players.
Seeds deterministically shuffle the selected openings for each independent run;
search itself is deterministic with node budgets, with no wall-clock deadline.
Repeated runs therefore measure scheduling/timing variation, not new independent
playing samples. Bootstrap resamples **opening IDs**, keeping both colours,
all repeated runs and all configurations of that opening together. This avoids
treating repeated deterministic games as independent evidence.

Reports retain code commit/hash, engine/rules/bot/weights versions, exact weights,
corpus hash, seeds, search parameters, outcomes/errors, score differences,
truncation fraction, tactical misses, nodes/depth and p50/p95 elapsed times.
Wall-clock timings are observational and not bitwise reproducible. Truncations
are excluded from W/D/L and confidence intervals but disqualify acceptance;
their score differences must not be interpreted as wins.

Small samples, related openings, discrete bootstrap support, multiple opponents
and repeated experimentation limit inference. The single prespecified baseline
criterion is not a multiple-comparison correction. An interval is conditional on
this corpus and rules, not proof of general human-level strength. Keep raw logs,
report failures, and do not claim stronger play from the saved trial report.
