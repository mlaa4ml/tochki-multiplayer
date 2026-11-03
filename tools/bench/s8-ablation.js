#!/usr/bin/env node
// tools/bench/s8-ablation.js
//
// S8 (issue #62, дорожная карта docs/MONITOR_ROADMAP.md, п. 9 Плана):
// абляции и итоговая проверка силы бота. Для каждой конфигурации —
// парный матч из S4 (#58: полное поле, fill 64%, >= 50 пар, обе стороны)
// против базы и тактический набор regression из S3 (#57,
// tools/bench/corpus/prefork.regression.json). Плюс p95 времени хода и узлы.
//
// Конфигурации (сторона в синтаксисе paired-match: уровень:узлы[+флаги]):
//   base        — strong:N (флаги уровня по умолчанию);
//   full        — strong:N+monitor+safety2 (полная версия, monitor:true);
//   no-monitor  — strong:N+safety2 (полная версия без монитора);
//   no-solver   — strong:N+monitor+no-solver+safety2 (монитор без решателя);
//   safety2-on  — strong:N+safety2 (фильтр #55 включён) против базы;
//   safety2-off — strong:N+no-safety2 (фильтр выключен) против базы.
// Каждая конфигурация играет против base. Строка base — контроль (база против
// самой себя, ожидается 0.5) и её время/узлы/тактика.
//
// Команды:
//   node tools/bench/s8-ablation.js --config full --from 0 --to 10 --out-dir out/s8
//       сыграть шард [from, to) одной конфигурации (под лимиты Codespace);
//   node tools/bench/s8-ablation.js --config all --out-dir out/s8
//       все конфигурации целиком (локально у владельца, долго);
//   node tools/bench/s8-ablation.js --table --out-dir out/s8 [--md docs/S8_RESULTS.md]
//       склеить шарды, построить таблицу п. 9 Плана и вывести решения;
//   --nodes N (3000) --pairs N (50) --no-tactics --list.
//
// Правила решения (критерий готовности #62):
//   * флаг включается по умолчанию только при ci95.lo > 0.5 против базы;
//   * узел (монитор, решатель, safety2), который не даёт прироста
//     (вклад в сравнении «с узлом / без узла» не доказан), удаляется;
//   * партии с человеком — только контроль, версию по ним не выбирают
//     (здесь они не используются вовсе: дебюты — префиксы dev/regression).
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../../gameEngine.js');
const PM = require('./paired-match.js');

const CONFIGS = {
  'base':        { flags: [], note: 'база (контроль: база против самой себя)' },
  'full':        { flags: ['monitor', 'safety2'], note: 'полная версия (monitor:true)' },
  'no-monitor':  { flags: ['safety2'], note: 'без монитора' },
  'no-solver':   { flags: ['monitor', 'no-solver', 'safety2'], note: 'монитор без решателя' },
  'safety2-on':  { flags: ['safety2'], note: 'с фильтром safety2 (#55)' },
  'safety2-off': { flags: ['no-safety2'], note: 'без фильтра safety2' }
};

// Сравнения «с узлом / без узла» для правила удаления узла. Оценка вклада —
// по разности долей очков против общей базы (у обеих сторон одинаковые дебюты),
// узел полезен, если его конфигурация доказанно лучше базы (ci95.lo > 0.5)
// и не хуже конфигурации без него по доле очков.
const NODES = [
  { node: 'монитор + решатель', with: 'full', without: 'no-monitor' },
  { node: 'решатель', with: 'full', without: 'no-solver' },
  { node: 'safety2', with: 'safety2-on', without: 'safety2-off' }
];

function parseArgs(argv){
  const o = { config: null, nodes: 3000, pairs: 50, from: 0, to: Infinity, outDir: 'out/s8', table: false,
    md: null, tactics: true, list: false, quiet: false };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a === '--config') o.config = argv[++i];
    else if (a === '--nodes') o.nodes = Number(argv[++i]);
    else if (a === '--pairs') o.pairs = Number(argv[++i]);
    else if (a === '--from') o.from = Number(argv[++i]);
    else if (a === '--to') o.to = Number(argv[++i]);
    else if (a === '--out-dir') o.outDir = argv[++i];
    else if (a === '--table') o.table = true;
    else if (a === '--md') o.md = argv[++i];
    else if (a === '--no-tactics') o.tactics = false;
    else if (a === '--list') o.list = true;
    else if (a === '--quiet') o.quiet = true;
    else throw new Error('неизвестный параметр: ' + a);
  }
  return o;
}

function sideSpec(name, nodes){
  const c = CONFIGS[name];
  if (!c) throw new Error('неизвестная конфигурация: ' + name + ' (есть: ' + Object.keys(CONFIGS).join(', ') + ')');
  return `strong:${nodes}${c.flags.length ? '+' + c.flags.join('+') : ''}`;
}

function shardFile(o, name, from, to){
  return path.join(o.outDir, `${name}.${from}-${Number.isFinite(to) ? to : 'end'}.json`);
}

function runConfig(o, name){
  const pmOpts = PM.parseArgs(['--candidate', sideSpec(name, o.nodes), '--base', sideSpec('base', o.nodes),
    '--pairs', String(o.pairs), '--from', String(o.from), '--to', String(Number.isFinite(o.to) ? o.to : 1e9)]
    .concat(o.tactics && o.from === 0 ? [] : ['--no-tactics']).concat(o.quiet ? ['--quiet'] : []));
  const rep = PM.run(pmOpts);
  rep.s8 = { config: name, note: CONFIGS[name].note, nodes: o.nodes };
  fs.mkdirSync(o.outDir, { recursive: true });
  const f = shardFile(o, name, o.from, o.to);
  fs.writeFileSync(f, JSON.stringify(rep) + '\n');
  PM.printSummary(rep);
  console.log('  -> ' + f);
  return rep;
}

function collect(o){
  const out = {};
  if (!fs.existsSync(o.outDir)) return out;
  const files = fs.readdirSync(o.outDir).filter(f => /\.json$/.test(f) && !f.startsWith('table'));
  for (const name of Object.keys(CONFIGS)){
    const mine = files.filter(f => f.startsWith(name + '.')).map(f => path.join(o.outDir, f));
    if (!mine.length) continue;
    const rep = PM.merge(mine, PM.parseArgs(['--quiet']));
    rep.s8 = { config: name, note: CONFIGS[name].note, shards: mine.length };
    out[name] = rep;
  }
  return out;
}

function row(name, rep){
  const s = rep.summary, t = s.timing.candidate, tc = rep.tactics && rep.tactics.candidate;
  return { config: name, note: CONFIGS[name].note, side: sideSpec(name, rep.params.candidate.nodeLimit),
    pairs: s.pairs, score: s.score, ci95: s.ci95, better: s.candidateBetter, scoreDiff: s.scoreDiffMean,
    nonZero: s.nonZeroShare, prefork: tc ? `${tc.saved}/${tc.positions}` : null, preforkRate: tc ? tc.rate : null,
    msP95: t.msP95, nodesP95: t.nodesP95, nodesMean: t.nodesMean, botVersion: rep.botVersion,
    engineVersion: rep.engineVersion, weightsVersion: rep.weightsVersion };
}

function decide(rows){
  const by = Object.fromEntries(rows.map(r => [r.config, r]));
  const nodes = NODES.map(n => {
    const a = by[n.with], b = by[n.without];
    if (!a || !b) return { node: n.node, verdict: 'нет данных', keep: null };
    const gain = +(a.score - b.score).toFixed(3);
    const keep = a.better && gain > 0;
    return { node: n.node, with: n.with, without: n.without, gain, keep,
      verdict: keep ? 'оставить (прирост есть)' : 'удалить/не включать (прироста не доказано)' };
  });
  const flags = rows.filter(r => r.config !== 'base').map(r => ({ config: r.config,
    enableByDefault: !!r.better && r.pairs >= 50,
    reason: r.pairs < 50 ? `пар ${r.pairs} < 50` : (r.better ? `ci95.lo ${r.ci95.lo} > 0.5` : `ci95.lo ${r.ci95.lo} <= 0.5`) }));
  return { nodes, flags };
}

function markdown(rows, dec){
  const L = [];
  L.push('| Конфигурация | Сторона | Пар | Доля очков | ci95 | Разность очков | «до вилки» (S3) | p95 хода, мс | Узлы p95 / ср. | Версия бота |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) L.push(`| ${r.config} — ${r.note} | \`${r.side}\` | ${r.pairs} | ${r.score} | [${r.ci95.lo}, ${r.ci95.hi}] | ${r.scoreDiff} | ${r.prefork || '—'} | ${r.msP95} | ${r.nodesP95} / ${r.nodesMean} | ${r.botVersion} (engine ${r.engineVersion}, weights ${r.weightsVersion}) |`);
  L.push('', '| Узел | С узлом / без | Прирост доли очков | Решение |', '|---|---|---|---|');
  for (const n of dec.nodes) L.push(`| ${n.node} | ${n.with || '—'} / ${n.without || '—'} | ${n.gain ?? '—'} | ${n.verdict} |`);
  L.push('', '| Конфигурация | Включать по умолчанию | Причина |', '|---|---|---|');
  for (const f of dec.flags) L.push(`| ${f.config} | ${f.enableByDefault ? 'да' : 'нет'} | ${f.reason} |`);
  return L.join('\n') + '\n';
}

function table(o){
  const reps = collect(o);
  const rows = Object.keys(CONFIGS).filter(n => reps[n]).map(n => row(n, reps[n]));
  if (!rows.length) throw new Error('нет результатов в ' + o.outDir);
  const dec = decide(rows);
  const md = markdown(rows, dec);
  console.log(md);
  const res = { format: 'tochki-s8-ablation', botVersion: E.BOT_VERSION, engineVersion: E.ENGINE_VERSION,
    weightsVersion: E.WEIGHTS_VERSION, date: new Date().toISOString(), rows, decisions: dec };
  fs.writeFileSync(path.join(o.outDir, 'table.json'), JSON.stringify(res, null, 1) + '\n');
  if (o.md) fs.writeFileSync(o.md, `# S8 — результаты абляций (бот ${E.BOT_VERSION})\n\n` + md);
  return res;
}

function main(){
  const o = parseArgs(process.argv.slice(2));
  if (o.list){ for (const n of Object.keys(CONFIGS)) console.log(`${n}\t${sideSpec(n, o.nodes)}\t${CONFIGS[n].note}`); return; }
  if (o.table) return table(o);
  if (!o.config) throw new Error('нужен --config <имя|all> или --table');
  const names = o.config === 'all' ? Object.keys(CONFIGS) : o.config.split(',');
  for (const n of names) runConfig(o, n);
}

if (require.main === module) main();
module.exports = { CONFIGS, NODES, sideSpec, decide, markdown, row, collect, table };
