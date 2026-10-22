// gameEngine.js
//
// Чистые правила игры «Точки» — без canvas, без DOM, без localStorage.
// Тот же модуль подключается и в браузере (через <script>, кладёт себя
// в window.TochkiEngine), и в Node.js на сервере (через require/import) —
// поэтому сервер и клиент физически не могут разойтись в трактовке правил:
// это один и тот же код, а не две параллельные реализации.
//
// Публичный API:
//   TochkiEngine.SIZES / DIFFICULTY / BOT_WEIGHTS / BOT_PLAYER
//   TochkiEngine.getOpeningZone(rows, cols)
//   TochkiEngine.createMatch(options) -> объект партии с методами
//     applyMove(player, x, y), botMove(difficultyKey, weights),
//     endNow(), getSnapshot(), getMoveLog()
//
// createMatch — это как раз то, чего не хватало в однопользовательской
// версии: там правила жили в module-level переменных (let rows, cols, stone...),
// что нормально для одной партии в одной вкладке, но не подходит для сервера,
// которому нужно параллельно вести много независимых комнат. Здесь состояние
// партии — обычный объект в замыкании фабрики, поэтому createMatch можно
// вызывать сколько угодно раз с независимым состоянием на каждую комнату.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TochkiEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Кросс-окруженческий высокоточный таймер: в браузере — performance.now(),
  // в Node (>=16) он тоже есть глобально, но на всякий случай подстрахуемся.
  const now = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now();

  const SIZES = {
    small:  { cols: 12, rows: 10  },
    medium: { cols: 16, rows: 12 },
    large:  { cols: 22, rows: 16 }
  };

  const DIFFICULTY = {
    normal: { radius:2, candidateCap:10, timeLimit:220, maxDepth:3, branchWide:5, branchMid:4, branchNarrow:3, quiescenceExt:2 },
    strong: { radius:4, candidateCap:20, timeLimit:2000, maxDepth:6, branchWide:8, branchMid:6, branchNarrow:5, quiescenceExt:3 }
  };
  const TRAIN_DIFF = { radius:3, candidateCap:16, timeLimit:700, maxDepth:4, branchWide:6, branchMid:6, branchNarrow:4, quiescenceExt:3 };

  const BOT_PLAYER = 2;
  // liberty — вес нового термина «безопасность групп» (см. computeGroupLiberties
  // / libertyRisk ниже). Без него бот видел опасность окружения только когда
  // захват уже случился внутри горизонта поиска; с ним — на любой глубине,
  // потому что риск считается прямо в статической оценке листа.
  // Значения по умолчанию подобраны вручную и являются стартовой точкой для
  // tools/train-bot.js — самообучение self-play подбирает их точнее.
  const BOT_WEIGHTS = { potential: 6, cohesion: 1.2, stones: 0.15, liberty: 5 };
  const CAPTURED_WEIGHT = 100;
  const DIRS4 = [[1,0],[-1,0],[0,1],[0,-1]];

  // ---------- Дебютная зона ----------
  const OPENING_ZONE_SIDE = 4;
  function getOpeningZone(rows, cols){
    const cx = Math.floor(cols/2), cy = Math.floor(rows/2);
    const half = Math.floor(OPENING_ZONE_SIDE/2);
    let minX = cx - half, minY = cy - half;
    let maxX = minX + OPENING_ZONE_SIDE - 1, maxY = minY + OPENING_ZONE_SIDE - 1;
    minX = Math.max(0, minX); minY = Math.max(0, minY);
    maxX = Math.min(cols-1, maxX); maxY = Math.min(rows-1, maxY);
    return {minX, minY, maxX, maxY};
  }
  function inZone(x, y, zone){
    return x>=zone.minX && x<=zone.maxX && y>=zone.minY && y<=zone.maxY;
  }

  function createEmptyState(rows, cols){
    return {
      stone: Array.from({length:rows}, () => new Array(cols).fill(0)),
      dead: Array.from({length:rows}, () => new Array(cols).fill(0)),
      territory: Array.from({length:rows}, () => new Array(cols).fill(0))
    };
  }

  function cloneState(state){
    return {
      stone: state.stone.map(r => r.slice()),
      dead: state.dead.map(r => r.slice()),
      territory: state.territory.map(r => r.slice())
    };
  }

  function cellOwner(state, x, y){
    const { stone, dead, territory } = state;
    if (dead[y][x] !== 0) return dead[y][x];
    if (territory[y][x] !== 0) return territory[y][x];
    if (stone[y][x] !== 0) return stone[y][x];
    return 0;
  }

  // Клетка — «стена» игрока player, только если это его живая точка либо
  // клетка уже под его контролем (прежде захваченная точка / территория).
  function isWall(state, x, y, player){
    const { stone, dead, territory } = state;
    if (dead[y][x] === player) return true;
    if (territory[y][x] === player) return true;
    if (stone[y][x] === player && dead[y][x] === 0) return true;
    return false;
  }

  // Захват: заливкой ищем связные области, не являющиеся стеной player,
  // не касающиеся края поля и содержащие хотя бы одну живую точку соперника.
  // Мутирует state.dead/state.territory. Возвращает список изменённых клеток.
  function runCaptures(state, player, rows, cols){
    const { stone, dead, territory } = state;
    const opponent = player === 1 ? 2 : 1;
    const visited = Array.from({length: rows}, () => new Array(cols).fill(false));
    const gained = [];

    for (let y=0; y<rows; y++){
      for (let x=0; x<cols; x++){
        if (visited[y][x]) continue;
        if (isWall(state, x, y, player)){
          visited[y][x] = true;
          continue;
        }
        const stack = [[x,y]];
        const region = [];
        let touchesBorder = false;
        let containsLiveOpponent = false;
        visited[y][x] = true;
        while (stack.length){
          const [cx,cy] = stack.pop();
          region.push([cx,cy]);
          if (cx===0 || cy===0 || cx===cols-1 || cy===rows-1) touchesBorder = true;
          if (stone[cy][cx] === opponent && dead[cy][cx] === 0) containsLiveOpponent = true;
          for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
            const nx=cx+dx, ny=cy+dy;
            if (nx<0||ny<0||nx>=cols||ny>=rows) continue;
            if (visited[ny][nx]) continue;
            visited[ny][nx] = true;
            if (isWall(state, nx, ny, player)) continue;
            stack.push([nx,ny]);
          }
        }
        if (!touchesBorder && containsLiveOpponent){
          for (const [cx,cy] of region){
            if (stone[cy][cx] === player){
              // Классическое освобождение: своя ранее пленённая точка внутри
              // нового контура снова живая (dead = 0); очков за неё никто
              // не получает, противник теряет очко (см. computeScores).
              if (dead[cy][cx] !== 0){
                gained.push({x:cx, y:cy, prevOwner: dead[cy][cx], kind:'freed'});
                dead[cy][cx] = 0;
              }
            } else if (stone[cy][cx] !== 0){
              // Точка противника (живая или его ранее «отбитая») — пленена.
              if (dead[cy][cx] !== player){
                gained.push({x:cx, y:cy, prevOwner: dead[cy][cx], kind:'captured'});
                dead[cy][cx] = player;
              }
            } else if (territory[cy][cx] !== player){
              // Пустая клетка внутри контура: отмечается владельцем окружения,
              // но очков НЕ даёт (классические правила).
              gained.push({x:cx, y:cy, prevOwner: territory[cy][cx], kind:'territory'});
              territory[cy][cx] = player;
            }
          }
        }
      }
    }
    return gained;
  }

  // Классический счёт: очко даёт только пленённая точка противника
  // (stone = цвет противника, dead = владелец окружения). Пустые клетки и
  // свои точки внутри контура очков не дают. Счёт всегда выводится из
  // состояния доски, поэтому освобождение/перезахват корректны автоматически.
  function computeScores(state, rows, cols){
    const scores = {1:0, 2:0};
    for (let y=0; y<rows; y++)
      for (let x=0; x<cols; x++){
        const s = state.stone[y][x], d = state.dead[y][x];
        if (s !== 0 && d !== 0 && d !== s) scores[d] += 1;
      }
    return scores;
  }

  function countCaptured(gained){
    let n = 0;
    for (const g of gained) if (g.kind === 'captured') n++;
    return n;
  }

  // ---------- Бот ----------

  function generateCandidates(state, rows, cols, radius){
    const { stone, territory } = state;
    const cand = new Set();
    const has = (x,y) => stone[y][x] !== 0;
    let anyStone = false;
    let stoneCount = 0;
    for (let y=0; y<rows; y++){
      for (let x=0; x<cols; x++){
        if (!has(x,y)) continue;
        anyStone = true;
        stoneCount++;
        for (let dy=-radius; dy<=radius; dy++){
          for (let dx=-radius; dx<=radius; dx++){
            const nx=x+dx, ny=y+dy;
            if (nx<0||ny<0||nx>=cols||ny>=rows) continue;
            if (stone[ny][nx]!==0 || territory[ny][nx]!==0) continue;
            cand.add(ny*cols+nx);
          }
        }
      }
    }
    if (!anyStone){
      cand.add(Math.floor(rows/2)*cols + Math.floor(cols/2));
    }
    let result = Array.from(cand).map(v => ({x: v % cols, y: Math.floor(v/cols)}));

    if (stoneCount < 2){
      const zone = getOpeningZone(rows, cols);
      let restricted = result.filter(c => inZone(c.x, c.y, zone));
      if (!restricted.length){
        for (let y=zone.minY; y<=zone.maxY; y++){
          for (let x=zone.minX; x<=zone.maxX; x++){
            if (stone[y][x]===0 && territory[y][x]===0) restricted.push({x,y});
          }
        }
      }
      result = restricted;
    }
    return result;
  }

  function quickScore(state, rows, cols, x, y, player, urgentMap){
    const { stone } = state;
    const opponent = player === 1 ? 2 : 1;
    let s = 0;
    for (let dy=-2; dy<=2; dy++){
      for (let dx=-2; dx<=2; dx++){
        const nx=x+dx, ny=y+dy;
        if (nx<0||ny<0||nx>=cols||ny>=rows) continue;
        const dist = Math.max(Math.abs(dx),Math.abs(dy));
        if (stone[ny][nx]===opponent) s += 3/dist;
        else if (stone[ny][nx]===player) s += 2/dist;
      }
    }
    const cx = cols/2, cy = rows/2;
    s += 0.4 / (1 + Math.hypot(x-cx, y-cy));
    // Бонус за срочность — см. computeUrgentCells. Без него кандидат-ордеринг
    // и обрезка по candidateCap/branchFactor могли отбросить единственный
    // ход, спасающий группу от захвата, ещё до того, как поиск успевал его
    // увидеть — именно это и выглядело как «бот защищает обречённые точки».
    if (urgentMap){
      const bonus = urgentMap.get(y*cols+x);
      if (bonus) s += bonus;
    }
    return s;
  }

  function computeTerritoryPotential(state, rows, cols){
    const { stone, territory } = state;
    const visited = Array.from({length: rows}, () => new Array(cols).fill(false));
    const potential = {1:0, 2:0};
    for (let y=0; y<rows; y++){
      for (let x=0; x<cols; x++){
        if (visited[y][x]) continue;
        if (stone[y][x] !== 0 || territory[y][x] !== 0){ visited[y][x] = true; continue; }
        const stack = [[x,y]];
        visited[y][x] = true;
        let regionSize = 0;
        let touchesBorder = false;
        const owners = new Set();
        while (stack.length){
          const [cx,cy] = stack.pop();
          regionSize++;
          if (cx===0 || cy===0 || cx===cols-1 || cy===rows-1) touchesBorder = true;
          for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
            const nx=cx+dx, ny=cy+dy;
            if (nx<0||ny<0||nx>=cols||ny>=rows) continue;
            const neutral = stone[ny][nx]===0 && territory[ny][nx]===0;
            if (neutral){
              if (!visited[ny][nx]){ visited[ny][nx] = true; stack.push([nx,ny]); }
            } else {
              const owner = cellOwner(state, nx, ny);
              if (owner !== 0) owners.add(owner);
            }
          }
        }
        if (!touchesBorder && owners.size === 1){
          potential[[...owners][0]] += regionSize;
        }
      }
    }
    return potential;
  }

  // ---------- Свободы групп («атари») ----------
  //
  // computeTerritoryPotential выше отвечает на вопрос «какая пустая область
  // уже полностью замкнута одним игроком» — это факт, наступающий постфактум,
  // ровно в момент захвата. Он ничего не говорит о том, что группа живых
  // камней постепенно ЛИШАЕТСЯ путей наружу за несколько ходов до захвата —
  // а именно это нужно боту, чтобы вовремя защищаться и вовремя окружать
  // самому. Здесь используется тот же принцип, что «свободы» (liberties) в
  // го: для связной группы живых камней игрока считаются соседние клетки,
  // через которые группа ещё может «дышать» (пустые, не занятые соперником).
  // Если свобод становится мало (1-2), группа в шаге от захвата — даже если
  // формально до этого момента runCaptures её ещё не тронул.
  function computeGroupLiberties(state, rows, cols, player){
    const { stone, dead, territory } = state;
    const visited = Array.from({length: rows}, () => new Array(cols).fill(false));
    const groups = [];
    for (let y=0; y<rows; y++){
      for (let x=0; x<cols; x++){
        if (visited[y][x]) continue;
        if (!(stone[y][x] === player && dead[y][x] === 0)){ visited[y][x] = true; continue; }
        const stack = [[x,y]];
        visited[y][x] = true;
        const cells = [];
        const libs = new Set();
        while (stack.length){
          const [cx,cy] = stack.pop();
          cells.push([cx,cy]);
          for (const [dx,dy] of DIRS4){
            const nx=cx+dx, ny=cy+dy;
            if (nx<0||ny<0||nx>=cols||ny>=rows) continue;
            if (stone[ny][nx] === player && dead[ny][nx] === 0){
              if (!visited[ny][nx]){ visited[ny][nx] = true; stack.push([nx,ny]); }
            } else if (stone[ny][nx] === 0 && dead[ny][nx] === 0 && territory[ny][nx] === 0){
              libs.add(ny*cols+nx);
            }
          }
        }
        groups.push({ cells, size: cells.length, liberties: libs.size, libCells: libs });
      }
    }
    return groups;
  }

  // Риск группы растёт резко нелинейно по мере приближения к «атари»
  // (1 свобода — следующий ход соперника захватывает группу целиком).
  // Множитель на size означает, что потеря большой сцепленной группы —
  // катастрофа, а не мелкая потеря одного камня.
  function libertyRisk(groups){
    let risk = 0;
    for (const g of groups){
      if (g.liberties <= 1) risk += g.size * 6;
      else if (g.liberties === 2) risk += g.size * 2.5;
      else if (g.liberties === 3) risk += g.size * 0.8;
    }
    return risk;
  }

  function hasUrgentAtari(state, rows, cols, player){
    const opponent = player === 1 ? 2 : 1;
    const mine = computeGroupLiberties(state, rows, cols, player);
    if (mine.some(g => g.liberties <= 1)) return true;
    const theirs = computeGroupLiberties(state, rows, cols, opponent);
    if (theirs.some(g => g.liberties <= 1)) return true;
    return false;
  }

  // Клетки-«свободы» групп в атари (liberties<=2) для обеих сторон,
  // с бонусом для quickScore/сортировки кандидатов — чтобы срочный ход
  // (спасти свою группу или добить чужую) не вылетел из top-N кандидатов
  // при обрезке по candidateCap/branchFactor до того, как поиск вообще
  // успеет его увидеть.
  function computeUrgentCells(state, rows, cols, mover){
    const opponent = mover === 1 ? 2 : 1;
    const urgent = new Map();
    const mark = (groups, bonus) => {
      for (const g of groups){
        if (g.liberties > 2) continue;
        const w = g.liberties <= 1 ? bonus * 2.2 : bonus * 1.1;
        for (const key of g.libCells){
          if ((urgent.get(key) || 0) < w) urgent.set(key, w);
        }
      }
    };
    mark(computeGroupLiberties(state, rows, cols, mover), 5);      // спасти свою группу
    mark(computeGroupLiberties(state, rows, cols, opponent), 4.2); // добить чужую
    return urgent;
  }

  function evaluateStatic(state, rows, cols, forPlayer, weights){
    const { stone, dead, territory } = state;
    const opponent = forPlayer === 1 ? 2 : 1;
    const captured = {1:0, 2:0};
    const liveStones = {1:0, 2:0};
    const cohesion = {1:0, 2:0};
    for (let y=0; y<rows; y++){
      for (let x=0; x<cols; x++){
        if (dead[y][x] !== 0){ captured[dead[y][x]]++; continue; }
        if (territory[y][x] !== 0){ captured[territory[y][x]]++; continue; }
        const p = stone[y][x];
        if (p !== 0){
          liveStones[p]++;
          if (x+1<cols && stone[y][x+1]===p && dead[y][x+1]===0) cohesion[p]++;
          if (y+1<rows && stone[y+1][x]===p && dead[y+1][x]===0) cohesion[p]++;
        }
      }
    }
    const potential = computeTerritoryPotential(state, rows, cols);
    const capturedDiff  = captured[forPlayer] - captured[opponent];
    const potentialDiff = potential[forPlayer] - potential[opponent];
    const cohesionDiff  = cohesion[forPlayer] - cohesion[opponent];
    const stoneDiff     = liveStones[forPlayer] - liveStones[opponent];

    // libertyDiff > 0, когда СОПЕРНИК ближе к потере группы, чем forPlayer —
    // то есть положительно и за собственную оборону, и за давление на чужие
    // группы. weights.liberty может отсутствовать у старых сохранённых
    // весов (из БД/прежних версий) — тогда просто не влияет на оценку.
    const ownGroups = computeGroupLiberties(state, rows, cols, forPlayer);
    const oppGroups = computeGroupLiberties(state, rows, cols, opponent);
    const libertyDiff = libertyRisk(oppGroups) - libertyRisk(ownGroups);

    return capturedDiff*CAPTURED_WEIGHT + potentialDiff*weights.potential + cohesionDiff*weights.cohesion
      + stoneDiff*weights.stones + libertyDiff*(weights.liberty || 0);
  }

  function branchFactorForDepth(diff, depth){
    if (depth >= 3) return diff.branchWide;
    if (depth === 2) return diff.branchMid;
    return diff.branchNarrow;
  }

  function orderedCandidates(state, rows, cols, player, diff, depth){
    const cand = generateCandidates(state, rows, cols, diff.radius);
    const urgent = computeUrgentCells(state, rows, cols, player);
    cand.forEach(c => { c.q = quickScore(state, rows, cols, c.x, c.y, player, urgent); });
    cand.sort((a,b) => b.q - a.q);
    return cand.slice(0, branchFactorForDepth(diff, depth));
  }

  function hasForcingCapture(state, rows, cols, player, diff){
    const cand = generateCandidates(state, rows, cols, diff.radius)
      .map(c => ({...c, q: quickScore(state, rows, cols, c.x, c.y, player)}))
      .sort((a,b) => b.q - a.q)
      .slice(0, 10);
    for (const c of cand){
      const s = cloneState(state);
      s.stone[c.y][c.x] = player;
      if (runCaptures(s, player, rows, cols).length) return true;
    }
    return false;
  }

    // ---------- Единый лёгкий переход: матч, поиск, self-play ----------
  //
  // Узел — минимальное состояние, достаточное для ПОЛНЫХ правил: три слоя
  // доски, счёт, очередь хода, счётчик поставленных точек, конец/победитель
  // и нормализованные правила (порог очков, порог заполнения, доп. ход).
  // Никакой истории/лога/событий — узел дёшево клонировать на каждом шаге
  // поиска. createRawMatch.applyMove выполняет ход через тот же
  // applyTransitionInPlace, поэтому реальная партия и поиск бота не могут
  // разойтись в трактовке правил.

  function normalizeRules(r){
    r = r || {};
    const targetScore = Math.max(0, Math.min(9999, Math.floor(r.targetScore) || 0));
    let targetFillPercent = r.targetFillPercent;
    if (typeof targetFillPercent !== 'number' || isNaN(targetFillPercent)) targetFillPercent = 100;
    targetFillPercent = Math.max(0, Math.min(100, Math.floor(targetFillPercent)));
    return {
      targetScore, targetFillPercent,
      scoreRuleActive: targetScore > 0,
      fillRuleActive: targetFillPercent > 0 && targetFillPercent < 100,
      extraTurnOnCapture: r.extraTurnOnCapture === true
    };
  }

  function winnerFromScores(scores){
    return scores[1] > scores[2] ? 1 : (scores[2] > scores[1] ? 2 : 0);
  }

  // src — снимок матча (getSnapshot()) или объект с полями
  // stone/dead/territory/rows/cols/current и, по возможности,
  // stonesPlacedTotal/gameOver/rules. Слои доски копируются. Счёт выводится
  // из доски (как и в матче). Без stonesPlacedTotal берётся число точек на
  // доске (захваченные точки остаются на ней, так что это то же число).
  function createSearchNode(src){
    const rows = src.rows, cols = src.cols;
    const state = cloneState({ stone: src.stone, dead: src.dead, territory: src.territory });
    const scores = computeScores(state, rows, cols);
    let placed = src.stonesPlacedTotal;
    if (!Number.isInteger(placed)){
      placed = 0;
      for (let y=0; y<rows; y++)
        for (let x=0; x<cols; x++)
          if (state.stone[y][x] !== 0) placed++;
    }
    const gameOver = src.gameOver === true;
    return {
      state, rows, cols, scores,
      current: src.current === 2 ? 2 : 1,
      stonesPlacedTotal: placed,
      gameOver,
      winner: gameOver ? winnerFromScores(scores) : null,
      rules: normalizeRules(src.rules)
    };
  }

  function cloneSearchNode(node){
    return {
      state: cloneState(node.state), rows: node.rows, cols: node.cols,
      scores: { 1: node.scores[1], 2: node.scores[2] },
      current: node.current, stonesPlacedTotal: node.stonesPlacedTotal,
      gameOver: node.gameOver, winner: node.winner, rules: node.rules
    };
  }

  // Самоубийство: если точка player-а оказалась в области, уже окружённой
  // противником (замкнута стеной противника и не касается края), эта
  // область сразу отходит противнику. Мутирует state.
  function captureSuicideRegion(state, rows, cols, player, x, y){
    const opp = player === 1 ? 2 : 1;
    const visited = Array.from({length: rows}, () => new Array(cols).fill(false));
    const stack = [[x,y]];
    const region = [];
    visited[y][x] = true;
    while (stack.length){
      const [cx,cy] = stack.pop();
      region.push([cx,cy]);
      if (cx===0 || cy===0 || cx===cols-1 || cy===rows-1) return [];
      for (const [dx,dy] of DIRS4){
        const nx=cx+dx, ny=cy+dy;
        if (nx<0||ny<0||nx>=cols||ny>=rows) continue;
        if (visited[ny][nx]) continue;
        visited[ny][nx] = true;
        if (isWall(state, nx, ny, opp)) continue;
        stack.push([nx,ny]);
      }
    }
    const out = [];
    for (const [cx,cy] of region){
      if (state.stone[cy][cx] === opp){
        if (state.dead[cy][cx] !== 0){ out.push({x:cx, y:cy, prevOwner: state.dead[cy][cx], kind:'freed'}); state.dead[cy][cx] = 0; }
      } else if (state.stone[cy][cx] !== 0){
        if (state.dead[cy][cx] !== opp){ out.push({x:cx, y:cy, prevOwner: state.dead[cy][cx], kind:'captured'}); state.dead[cy][cx] = opp; }
      } else if (state.territory[cy][cx] !== opp){
        out.push({x:cx, y:cy, prevOwner: state.territory[cy][cx], kind:'territory'});
        state.territory[cy][cx] = opp;
      }
    }
    return out;
  }

  // null — ход допустим, иначе причина отказа (те же коды, что у applyMove).
  function transitionRejectReason(node, player, x, y){
    if (node.gameOver) return 'game-over';
    if (player !== node.current) return 'not-your-turn';
    const { state, rows, cols } = node;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return 'illegal-cell';
    if (x<0 || y<0 || x>=cols || y>=rows) return 'illegal-cell';
    if (state.stone[y][x] !== 0) return 'illegal-cell';
    if (state.territory[y][x] !== 0 && state.territory[y][x] === node.current) return 'illegal-cell';
    if (node.stonesPlacedTotal < 2 && !inZone(x, y, getOpeningZone(rows, cols))) return 'illegal-cell';
    return null;
  }

  function isTransitionLegal(node, x, y){
    return transitionRejectReason(node, node.current, x, y) === null;
  }

  // Мутирующий переход (используется матчем). Нелегальный ход не трогает узел.
  function applyTransitionInPlace(node, player, x, y){
    const reason = transitionRejectReason(node, player, x, y);
    if (reason) return { ok:false, reason };
    const { state, rows, cols, rules } = node;
    state.stone[y][x] = player;
    if (state.territory[y][x] !== 0) state.territory[y][x] = 0;
    node.stonesPlacedTotal++;

    // Сначала собственные окружения ходившего (замыкание контура имеет
    // приоритет), затем — проверка самоубийства в окружении противника.
    const gained = runCaptures(state, player, rows, cols);
    let suicide = [];
    if (state.dead[y][x] === 0) suicide = captureSuicideRegion(state, rows, cols, player, x, y);
    node.scores = computeScores(state, rows, cols);

    let winner = null;
    let extraTurn = false;
    const ended = checkEndConditions({
      state, rows, cols, scores: node.scores,
      scoreRuleActive: rules.scoreRuleActive, targetScore: rules.targetScore,
      fillRuleActive: rules.fillRuleActive, targetFillPercent: rules.targetFillPercent,
      totalCells: rows*cols
    });
    if (ended){
      node.gameOver = true;
      winner = winnerFromScores(node.scores);
      node.winner = winner;
    } else if (rules.extraTurnOnCapture && countCaptured(gained) > 0){
      extraTurn = true; // ход остаётся за окружившим
    } else {
      node.current = player === 1 ? 2 : 1;
    }

    return {
      ok: true, player, x, y,
      gained, suicide, scores: { ...node.scores }, current: node.current, gameOver: node.gameOver, winner,
      extraTurn, stonesPlacedTotal: node.stonesPlacedTotal
    };
  }

  // Чистый переход для поиска/self-play: вход не мутируется никогда.
  function applyTransition(node, player, x, y){
    const reason = transitionRejectReason(node, player, x, y);
    if (reason) return { ok:false, reason };
    const child = cloneSearchNode(node);
    const result = applyTransitionInPlace(child, player, x, y);
    return { ok:true, node: child, result };
  }

  // Терминальная оценка: победа/поражение всегда весомее любой эвристики,
  // ближняя победа лучше дальней. Ничья — 0.
  const WIN_SCORE = 1e9;
  function terminalValue(node, forPlayer, ply){
    if (node.winner === forPlayer) return WIN_SCORE - ply;
    if (node.winner === 1 || node.winner === 2) return -(WIN_SCORE - ply);
    return 0;
  }

  // Кандидаты поиска — только легальные ходы узла, упорядоченные quickScore.
  function legalCandidates(node, diff){
    const { state, rows, cols } = node;
    const player = node.current;
    let cand = generateCandidates(state, rows, cols, diff.radius);
    // A08: стратегические кандидаты (разрывы контуров/выходы, дальние зоны);
    // diff.strategic === false — отключить (ablation).
    if (diff.strategic !== false && node.stonesPlacedTotal >= 2){
      const seen = new Set(cand.map(c => c.y*cols + c.x));
      for (const s of strategicCandidates(node)){
        const k = s.y*cols + s.x;
        if (!seen.has(k)){ seen.add(k); cand.push({ x: s.x, y: s.y }); }
      }
    }
    cand = cand.filter(c => isTransitionLegal(node, c.x, c.y));
    const urgent = computeUrgentCells(state, rows, cols, player);
    cand.forEach(c => { c.q = quickScore(state, rows, cols, c.x, c.y, player, urgent); });
    // Детерминированный порядок: quickScore по убыванию, равенства — по y, затем по x.
    cand.sort((a,b) => (b.q - a.q) || (a.y - b.y) || (a.x - b.x));
    return cand;
  }

    // A08 (issue #13): обязательные тактические кандидаты по ПОЛНЫМ правилам —
  // находятся полным перебором легальных ходов узла ДО эвристической обрезки
  // (generateCandidates/quickScore/candidateCap/branchFactor), поэтому не
  // зависят от радиуса соседства и локальных liberties.
  //   'win'     — ход сразу завершает партию победой ходящего (порог очков/заполнения);
  //   'capture' — ход реально пленит точки соперника (runCaptures);
  //   'block'   — клетка, которой соперник (если бы ходил сейчас) пленил бы
  //               точки или выиграл: занять её — прямая защита от потери.
  // Возвращает массив {x,y,kinds} в детерминированном порядке (y, затем x).
  // Отсечение клеток без соседей (8-окрестность без точек/территории) корректно:
  // такая точка — внутреннее препятствие одной и той же области, она не может
  // замкнуть контур (ни для ходящего, ни для соперника). Исключение — партия
  // кончается следующим ходом по заполнению: тогда «выигрывает» любой ход, и
  // перебираются все клетки. diff.tacticalFullScan=true — всегда полный перебор
  // (используется тестом сравнения с полным перебором).
  function nearOccupied(state, rows, cols, x, y){
    for (let dy=-1; dy<=1; dy++){
      for (let dx=-1; dx<=1; dx++){
        if (!dx && !dy) continue;
        const nx=x+dx, ny=y+dy;
        if (nx<0||ny<0||nx>=cols||ny>=rows) continue;
        if (state.stone[ny][nx] !== 0 || state.territory[ny][nx] !== 0) return true;
      }
    }
    return false;
  }
  function fillEndsNext(node){
    const r = node.rules;
    const total = node.rows*node.cols;
    const target = r.fillRuleActive ? Math.ceil(total*r.targetFillPercent/100) : total;
    return countFilledCells(node.state, node.rows, node.cols) + 1 >= target;
  }

  const TACTICAL_RANK = { win: 0, capture: 1, block: 2 };
  function tacticalRank(c){
    let r = 9;
    for (const k of c.kinds) if (TACTICAL_RANK[k] < r) r = TACTICAL_RANK[k];
    return r;
  }

  // A08: стратегические кандидаты вне радиуса соседства —
  //  * разрывы контуров и пути выхода: свободы групп обеих сторон с <=3 свободами;
  //  * разные области поля: центр каждой из 3×3 зон доски, в которой ещё нет
  //    ни одной точки/территории (чтобы поиск видел ходы на дальних флангах).
  // Возвращает только легальные ходы, порядок детерминирован (y, затем x).
  function strategicCandidates(node){
    const { state, rows, cols } = node;
    const out = new Map();
    if (node.gameOver) return [];
    const add = (x, y) => { if (isTransitionLegal(node, x, y)) out.set(y*cols+x, { x, y }); };
    for (const p of [1, 2]){
      for (const g of computeGroupLiberties(state, rows, cols, p)){
        if (g.liberties > 3) continue;
        for (const k of g.libCells) add(k % cols, Math.floor(k / cols));
      }
    }
    for (let zy=0; zy<3; zy++){
      for (let zx=0; zx<3; zx++){
        const x0 = Math.floor(zx*cols/3), x1 = Math.floor((zx+1)*cols/3) - 1;
        const y0 = Math.floor(zy*rows/3), y1 = Math.floor((zy+1)*rows/3) - 1;
        let empty = true;
        for (let y=y0; y<=y1 && empty; y++)
          for (let x=x0; x<=x1 && empty; x++)
            if (state.stone[y][x] !== 0 || state.territory[y][x] !== 0) empty = false;
        if (empty && x1 >= x0 && y1 >= y0) add(Math.floor((x0+x1)/2), Math.floor((y0+y1)/2));
      }
    }
    return Array.from(out.values()).sort((a,b) => (a.y - b.y) || (a.x - b.x));
  }

  // A08: итоговый набор кандидатов узла с обрезкой до cap.
  // Обязательные тактические ходы (win > capture > block, затем quickScore)
  // идут первыми и НЕ вытесняются эвристикой. Если их больше cap, сохраняется
  // до tacticalCap (по умолчанию 2×cap) обязательных ходов, обычные ходы при
  // этом не добавляются; переполнение учитывается в sc.tacticalOverflow.
  // Стоимость генерации считается в sc.tacticalScans (поиск проверяет бюджет
  // сразу после генерации). diff.tactical === false — прежнее поведение (ablation).
  function searchCandidates(node, diff, cap, sc, tac){
    const base = legalCandidates(node, diff);
    if (diff.tactical === false) return base.slice(0, cap);
    if (!tac) tac = tacticalCandidates(node, diff);
    if (sc) sc.tacticalScans = (sc.tacticalScans || 0) + 1;
    if (!tac.length) return base.slice(0, cap);
    const { state, rows, cols } = node;
    const byKey = new Map(base.map(c => [c.y*cols + c.x, c]));
    const forced = tac.map(t => {
      const b = byKey.get(t.y*cols + t.x);
      return { x: t.x, y: t.y, kinds: t.kinds.slice(), tactical: true,
        q: b ? b.q : quickScore(state, rows, cols, t.x, t.y, node.current, null) };
    });
    forced.sort((a,b) => (tacticalRank(a) - tacticalRank(b)) || (b.q - a.q) || (a.y - b.y) || (a.x - b.x));
    const tcap = Math.max(cap, Number.isInteger(diff.tacticalCap) && diff.tacticalCap > 0 ? diff.tacticalCap : cap*2);
    if (forced.length > tcap && sc) sc.tacticalOverflow = (sc.tacticalOverflow || 0) + 1;
    const kept = forced.slice(0, tcap);
    const keys = new Set(kept.map(c => c.y*cols + c.x));
    const rest = base.filter(c => !keys.has(c.y*cols + c.x)).slice(0, Math.max(0, cap - kept.length));
    return kept.concat(rest);
  }

  function tacticalCandidates(node, diff){
    const { rows, cols, state } = node;
    const out = new Map();
    if (node.gameOver) return [];
    const fullScan = (diff && diff.tacticalFullScan === true) || fillEndsNext(node);
    const player = node.current;
    const opp = player === 1 ? 2 : 1;
    const add = (x, y, kind) => {
      const k = y*cols + x;
      const e = out.get(k);
      if (e){ if (!e.kinds.includes(kind)) e.kinds.push(kind); }
      else out.set(k, { x, y, kinds: [kind] });
    };
    const oppNode = cloneSearchNode(node);
    oppNode.current = opp;
    for (let y=0; y<rows; y++){
      for (let x=0; x<cols; x++){
        if (!fullScan && !nearOccupied(state, rows, cols, x, y)) continue;
        if (isTransitionLegal(node, x, y)){
          const t = applyTransition(node, player, x, y);
          if (t.ok){
            if (t.node.gameOver && t.node.winner === player) add(x, y, 'win');
            if (countCaptured(t.result.gained) > 0) add(x, y, 'capture');
          }
        }
        if (isTransitionLegal(oppNode, x, y) && isTransitionLegal(node, x, y)){
          const t = applyTransition(oppNode, opp, x, y);
          if (t.ok && ((t.node.gameOver && t.node.winner === opp) || countCaptured(t.result.gained) > 0)){
            add(x, y, 'block');
          }
        }
      }
    }
    return Array.from(out.values()).sort((a,b) => (a.y - b.y) || (a.x - b.x));
  }

    // A08: обязательная тактика во ВНУТРЕННИХ узлах и продлениях. Полный скан
  // слишком дорог для каждого узла, поэтому проверяются (тем же полным
  // переходом applyTransition, по полным правилам) только клетки, где набор
  // мог измениться или уже был непуст:
  //   * обязательные клетки родителя (hint.cells — захват/защита родителя
  //     здесь остаются захватом/защитой, пока ход их не отменил);
  //   * окрестность радиуса 2 последнего хода (hint.move);
  //   * свободы групп обеих сторон с <=2 свободами.
  // Без hint (дети корня) и когда партия кончается следующим ходом по
  // заполнению — полный скан tacticalCandidates. diff.tacticalInternal === false
  // — прежнее поведение (ablation).
  function tacticalCandidatesLocal(node, diff, hint){
    const { rows, cols, state } = node;
    if (node.gameOver) return [];
    if (!hint || fillEndsNext(node)) return tacticalCandidates(node, diff);
    const cells = new Set();
    const addCell = (x, y) => { if (x>=0 && y>=0 && x<cols && y<rows) cells.add(y*cols + x); };
    if (hint.move){
      for (let dy=-2; dy<=2; dy++) for (let dx=-2; dx<=2; dx++) addCell(hint.move.x+dx, hint.move.y+dy);
    }
    if (hint.cells) for (const c of hint.cells) addCell(c.x, c.y);
    for (const p of [1, 2]){
      for (const g of computeGroupLiberties(state, rows, cols, p)){
        if (g.liberties > 2) continue;
        for (const k of g.libCells) cells.add(k);
      }
    }
    const player = node.current;
    const opp = player === 1 ? 2 : 1;
    const out = new Map();
    const add = (x, y, kind) => {
      const k = y*cols + x;
      const e = out.get(k);
      if (e){ if (!e.kinds.includes(kind)) e.kinds.push(kind); }
      else out.set(k, { x, y, kinds: [kind] });
    };
    const oppNode = cloneSearchNode(node);
    oppNode.current = opp;
    for (const k of cells){
      const x = k % cols, y = Math.floor(k / cols);
      if (!isTransitionLegal(node, x, y)) continue;
      const t = applyTransition(node, player, x, y);
      if (t.ok){
        if (t.node.gameOver && t.node.winner === player) add(x, y, 'win');
        if (countCaptured(t.result.gained) > 0) add(x, y, 'capture');
      }
      if (isTransitionLegal(oppNode, x, y)){
        const o = applyTransition(oppNode, opp, x, y);
        if (o.ok && ((o.node.gameOver && o.node.winner === opp) || countCaptured(o.result.gained) > 0)) add(x, y, 'block');
      }
    }
    return Array.from(out.values()).sort((a,b) => (a.y - b.y) || (a.x - b.x));
  }

  function firstLegalMove(node){
    for (let y=0; y<node.rows; y++)
      for (let x=0; x<node.cols; x++)
        if (isTransitionLegal(node, x, y)) return {x, y};
    return null;
  }

  // Игрок узла — всегда фактический node.current: после захвата с
  // доп. ходом поиск продолжает за того же игрока, а не за соперника.
  // Терминальный узел не порождает продолжений и оценивается терминально.
  // (Прежний alphaBeta с ±Infinity и без распространения abort заменён
  // alphaBetaSearch ниже — см. A04, issue #9.)

  // ctx (необязательный) — полные правила позиции: { stonesPlacedTotal,
  // gameOver, rules } (подходит прямо getSnapshot() матча). Без ctx —
  // прежние правила по умолчанию: без порогов и доп. хода, конец только при
  // полном поле, stonesPlacedTotal = число точек на доске.
  // ---------- Поиск с явным бюджетом (A04, issue #9) ----------
  // Бюджет поиска: детерминированный лимит узлов (тесты/benchmark) и/или
  // таймер (реальная игра). clock можно подменить управляемыми часами.
  function createSearchBudget(opts){
    const clock = typeof opts.clock === 'function' ? opts.clock : now;
    const start = clock();
    const tl = Number(opts.timeLimit);
    const deadline = (opts.timeLimit !== undefined && opts.timeLimit !== null && Number.isFinite(tl) && tl >= 0)
      ? start + tl : Infinity;
    const nl = Math.floor(Number(opts.nodeLimit));
    return { clock, start, deadline, nodeLimit: Number.isFinite(nl) && nl > 0 ? nl : 0,
      nodes: 0, aborted: false, stopReason: null };
  }

  // Проверка бюджета; при исчерпании поиск помечается прерванным (abort
  // распространяется вверх через sc.aborted — значения прерванных узлов
  // не используются никем).
  // where — метка точки проверки (для trace.stopAt и тестов): 'root',
  // 'node', 'extension-before'/'extension-after' (вокруг проверки продления),
  // 'extension-node' (внутри узла продления), 'static-eval'.
  function budgetExceeded(sc, where){
    if (sc.aborted) return true;
    if (sc.nodeLimit > 0 && sc.nodes >= sc.nodeLimit){ sc.aborted = true; sc.stopReason = 'node-limit'; }
    else if (sc.clock() > sc.deadline){ sc.aborted = true; sc.stopReason = 'time'; }
    if (sc.aborted) sc.stopAt = where || 'root';
    return sc.aborted;
  }

  function finiteScore(v, fallback){ return Number.isFinite(v) ? v : fallback; }

  // Возвращает конечную оценку. Если после вызова sc.aborted === true —
  // результат недействителен и должен быть отброшен вызывающим.
    // hint (A08, необязательный): { move, cells } — последний ход родителя и его
  // обязательные клетки, для инкрементального тактического скана.
  function alphaBetaSearch(node, depth, alpha, beta, diff, sc, forPlayer, weights, extensionsLeft, ply, hint){
    if (node.gameOver) return terminalValue(node, forPlayer, ply);
    // Узел продления: depth<=0, но поиск продолжается из-за форсированных ходов.
    const inExt = depth <= 0;
    if (budgetExceeded(sc, inExt ? 'extension-node' : 'node')) return 0;
    sc.nodes++;
    const { state, rows, cols } = node;
    const player = node.current;
    // Статическая оценка — дорогая операция: бюджет проверяется перед ней
    // (при исчерпании узел прерывается, значение отбрасывается вызывающим).
    const staticVal = () => budgetExceeded(sc, 'static-eval') ? 0
      : finiteScore(evaluateStatic(state, rows, cols, forPlayer, weights), 0);
    let forcedTac = null; // A08: тактический набор, уже посчитанный для продления
    // A08: полный тактический скан стоит O(rows*cols) переходов, поэтому во
    // внутренних узлах он выполняется только до ply <= diff.tacticalPly
    // (по умолчанию 0 — корень считается в searchMove) и в узлах продления.
    // diff.tacticalExtScan === true — полный скан как условие продления в
    // каждом листе (дорого; по умолчанию условие — прежняя дешёвая проверка,
    // а набор ходов продления берётся из полного тактического скана).
    const tacOn = diff.tactical !== false;
    const tacPly = Number.isInteger(diff.tacticalPly) ? diff.tacticalPly : 0;
    const tacInternal = diff.tacticalInternal !== false;
    if (depth <= 0){
      if (extensionsLeft <= 0) return staticVal();
      // Продление — дорогая операция: бюджет проверяется до и после неё.
      if (budgetExceeded(sc, 'extension-before')) return 0;
      let forced;
      if (tacOn && diff.tacticalExtScan === true){
        forcedTac = tacticalCandidates(node, diff);
        forced = forcedTac.length > 0 || hasUrgentAtari(state, rows, cols, player);
      } else if (tacOn && tacInternal){
        // A08: продление решается по обязательной тактике полных правил
        // (инкрементальный скан), а не только по локальным liberties.
        forcedTac = tacticalCandidatesLocal(node, diff, hint);
        forced = forcedTac.length > 0 || hasForcingCapture(state, rows, cols, player, diff)
          || hasUrgentAtari(state, rows, cols, player);
      } else {
        forced = hasForcingCapture(state, rows, cols, player, diff) || hasUrgentAtari(state, rows, cols, player);
      }
      if (budgetExceeded(sc, 'extension-after')) return 0;
      if (!forced) return staticVal();
    }
    const searchDepth = depth > 0 ? depth : 1;
    const bf = branchFactorForDepth(diff, searchDepth);
    // A08: во внутренних узлах обязательная тактика по умолчанию тоже
    // сохраняется до обрезки branchFactor (инкрементальный скан от родителя).
    if (tacOn && tacInternal && !forcedTac && ply > tacPly){
      if (budgetExceeded(sc, inExt ? 'extension-node' : 'node')) return 0;
      forcedTac = tacticalCandidatesLocal(node, diff, hint);
    }
    const useTac = tacOn && (ply <= tacPly || forcedTac);
    const candidates = useTac ? searchCandidates(node, diff, bf, sc, forcedTac)
      : legalCandidates(node, diff).slice(0, bf);
    if (budgetExceeded(sc, inExt ? 'extension-node' : 'node')) return 0;
    if (!candidates.length) return staticVal();

    const maximizing = player === forPlayer;
    let value = null;
    const nextDepth = depth > 0 ? depth - 1 : 0;
    const nextExt = depth > 0 ? extensionsLeft : extensionsLeft - 1;

    for (const c of candidates){
      if (budgetExceeded(sc, inExt ? 'extension-node' : 'node')) return 0;
      const t = applyTransition(node, player, c.x, c.y);
      if (!t.ok) continue;
            const childVal = alphaBetaSearch(t.node, nextDepth, alpha, beta, diff, sc, forPlayer, weights, nextExt, ply + 1,
        { move: { x: c.x, y: c.y }, cells: forcedTac || null });
      if (sc.aborted) return 0;
      if (value === null || (maximizing ? childVal > value : childVal < value)) value = childVal;
      if (maximizing) alpha = Math.max(alpha, value);
      else beta = Math.min(beta, value);
      if (beta <= alpha) break;
    }
    // Значение детей уже конечно; статическая оценка (с проверкой бюджета)
    // считается только если ни одного ребёнка не было или значение не конечно.
    if (value !== null && Number.isFinite(value)) return value;
    return staticVal();
  }

  // Полный поиск с диагностикой. opts: { stonesPlacedTotal, gameOver, rules,
  // nodeLimit, timeLimit, emergencyTimeLimit, clock }.
  // С nodeLimit поиск детерминирован: таймер только аварийный
  // (emergencyTimeLimit/timeLimit, по умолчанию выключен). Без nodeLimit —
  // прежний таймер diff.timeLimit (мягкий, не жёсткий real-time).
  // Возвращает { move, trace }; принимается только полностью завершённая
  // итерация, иначе — ход предыдущей завершённой или первый по порядку
  // кандидатов (сортировка quickScore, равенства — по y, затем x).
  function searchMove(state, rows, cols, mover, diff, weights, opts){
    opts = opts || {};
    diff = diff || DIFFICULTY.normal;
    weights = weights || BOT_WEIGHTS;
    const nodeLimit = opts.nodeLimit;
    const timeLimit = opts.timeLimit !== undefined ? opts.timeLimit
      : (nodeLimit > 0 ? opts.emergencyTimeLimit : diff.timeLimit);
    const sc = createSearchBudget({ clock: opts.clock, timeLimit, nodeLimit });
    const trace = {
      move: null, candidates: [], nodes: 0, completedDepth: 0, stopReason: null, elapsedMs: 0,
      params: {
        maxDepth: diff.maxDepth, candidateCap: diff.candidateCap, quiescenceExt: diff.quiescenceExt ?? 2,
        timeLimit: Number.isFinite(sc.deadline) ? sc.deadline - sc.start : null,
        nodeLimit: sc.nodeLimit || null
      }
    };
    const finish = (move, reason) => {
      trace.move = move ? { x: move.x, y: move.y } : null;
      trace.nodes = sc.nodes;
            trace.stopReason = reason;
      // Точка проверки бюджета, на которой произошёл обрыв (или null).
      trace.stopAt = sc.aborted ? (sc.stopAt || 'root') : null;
      trace.elapsedMs = sc.clock() - sc.start;
      return { move: move || null, trace };
    };

    const root = createSearchNode({
      stone: state.stone, dead: state.dead, territory: state.territory, rows, cols,
      current: mover, stonesPlacedTotal: opts.stonesPlacedTotal, gameOver: opts.gameOver, rules: opts.rules
    });
    if (root.gameOver) return finish(null, 'game-over');
    const extInit = diff.quiescenceExt ?? 2;

    // Бюджет проверяется и до дорогой генерации корневых кандидатов: при
    // исчерпании — дешёвый легальный резервный ход (первый по y, затем x).
    if (budgetExceeded(sc)){
      trace.fallback = 'first-legal';
      const f = firstLegalMove(root);
      return finish(f, f ? sc.stopReason : 'no-legal-moves');
    }

        // A08: обязательные тактические ходы сохраняются до обрезки; стоимость
    // генерации — в trace (genMs по реальным часам, не трогая управляемые).
    const genStart = now();
    const ordered = searchCandidates(root, diff, diff.candidateCap, sc);
        // genMs — по реальным часам и потому недетерминирован: делаем поле
    // неперечислимым, чтобы не ломать сравнение trace (детерминизм, worker).
    Object.defineProperty(trace, 'genMs', { value: now() - genStart, enumerable: false, writable: true, configurable: true });
    trace.tactical = ordered.filter(c => c.tactical).length;
    trace.tacticalOverflow = sc.tacticalOverflow || 0;
    if (!ordered.length){
      trace.fallback = 'first-legal';
      const f = firstLegalMove(root);
      return finish(f, f ? 'no-candidates' : 'no-legal-moves');
    }

    // Перебор немедленных побед тоже под бюджетом: при исчерпании —
    // первый кандидат по детерминированному порядку.
    for (const c of ordered){
      if (budgetExceeded(sc)){
        trace.fallback = 'first-candidate';
        return finish(ordered[0], sc.stopReason);
      }
      const t = applyTransition(root, mover, c.x, c.y);
      if (t.ok && t.node.gameOver && t.node.winner === mover) return finish(c, 'immediate-win');
    }

    let bestMove = null;
    for (let targetDepth = 2; targetDepth <= diff.maxDepth; targetDepth++){
      if (budgetExceeded(sc)) break;
      let localBest = null, localBestScore = -Infinity, alpha = -Infinity;
      const scores = [];
      for (const c of ordered){
        if (budgetExceeded(sc)) break;
        const t = applyTransition(root, mover, c.x, c.y);
        if (!t.ok) continue;
        const val = alphaBetaSearch(t.node, targetDepth-1, alpha, Infinity, diff, sc, mover, weights, extInit, 1);
        if (sc.aborted) break;
        // При отсечении score — граница, а не точная оценка.
        scores.push({ x: c.x, y: c.y, score: val });
        if (localBest === null || val > localBestScore){ localBestScore = val; localBest = c; }
        alpha = Math.max(alpha, localBestScore);
      }
      if (sc.aborted || !localBest) break; // неполная итерация не принимается
      bestMove = localBest;
      trace.completedDepth = targetDepth;
      trace.candidates = scores;
      const idx = ordered.indexOf(bestMove);
      if (idx > 0){ ordered.splice(idx, 1); ordered.unshift(bestMove); }
    }
    return finish(bestMove || ordered[0], sc.aborted ? sc.stopReason : 'max-depth');
  }

  // Совместимый интерфейс: возвращает только ход (или null).
  function chooseMove(state, rows, cols, mover, diff, weights, ctx){
    return searchMove(state, rows, cols, mover, diff, weights, ctx).move;
  }


  function isBoardFull(state, rows, cols){
    for (let y=0;y<rows;y++)
      for (let x=0;x<cols;x++)
        if (state.stone[y][x]===0 && state.territory[y][x]===0) return false;
    return true;
  }

  function countFilledCells(state, rows, cols){
    let n = 0;
    for (let y=0;y<rows;y++)
      for (let x=0;x<cols;x++)
        if (state.stone[y][x]!==0 || state.territory[y][x]!==0) n++;
    return n;
  }

  function checkEndConditions(ctx){
    const { state, rows, cols, scores, scoreRuleActive, targetScore, fillRuleActive, targetFillPercent, totalCells } = ctx;
    if (isBoardFull(state, rows, cols)) return true;
    if (scoreRuleActive && (scores[1] >= targetScore || scores[2] >= targetScore)) return true;
    if (fillRuleActive){
      const targetCells = Math.ceil(totalCells * targetFillPercent / 100);
      if (countFilledCells(state, rows, cols) >= targetCells) return true;
    }
    return false;
  }

  // ---------- Партия целиком: инкапсулированное состояние одной игры ----------
  // Это то, что нужно серверу: можно создать много независимых createMatch()
  // (по одной на комнату), и они не будут делить между собой никакие
  // module-level переменные — в отличие от однопользовательской версии.
  function createRawMatch(options){
    options = options || {};
    const sizeKey = options.sizeKey && SIZES[options.sizeKey] ? options.sizeKey : 'medium';
    const size = SIZES[sizeKey];
    const rows = size.rows, cols = size.cols;
    const state = createEmptyState(rows, cols);

    // firstPlayer — кто ставит первую точку партии. По умолчанию 1 (в
    // серверной модели это всегда создатель комнаты — см. server.js,
    // где seat 1 закрепляется за создателем), но при создании комнаты
    // это можно явно передать 2, чтобы первым ходил соперник/бот.
    const firstPlayer = options.firstPlayer === 2 ? 2 : 1;
    let current = firstPlayer;
    // extraTurnOnCapture — доп. ход за окружение: если true, игрок,
    // чей ход только что привёл к захвату (окружению) точки/точек
    // соперника, ходит ещё раз вместо передачи хода сопернику.
    const extraTurnOnCapture = options.extraTurnOnCapture === true;
    // undoAllowed — разрешена ли в этой партии отмена хода вообще; решает
    // создатель комнаты при её создании (по умолчанию true — как и было
    // раньше, отмена доступна всем). Если false, canUndoLastMove() всегда
    // возвращает false независимо от истории ходов, т.е. кнопка отмены и
    // весь протокол request-undo/undo-approve/undo-decline для этой партии
    // просто не активируются — ни для людей, ни (см. server.js) для бота.
    const undoAllowed = options.undoAllowed !== false;
    const scores = {1:0, 2:0};
    // Последний ход каждого игрока — отдельно от общего moveLog, чтобы не
    // пересчитывать его на каждый снимок: нужен именно "последняя точка
    // игрока 1" и "последняя точка игрока 2" одновременно (а не только
    // самый последний ход партии в целом), чтобы клиент мог подсветить
    // обе точки — свою и соперника.
    const lastMoveByPlayer = { 1: null, 2: null };
    let gameOver = false;
    let stonesPlacedTotal = 0;
    const moveLog = [];
    const totalCells = rows*cols;

    // Стек снимков "состояние прямо перед ходом N" — по одному на каждый
    // применённый ход, в порядке ходов. Понадобился для отмены хода
    // (шаг 14): захват мутирует сразу три слоя (stone/dead/territory) плюс
    // очки, аналитически "развернуть" runCaptures надёжно не получится —
    // проще и надёжнее просто вернуть весь снимок целиком. Память не
    // проблема: даже на большом поле (19×15) один снимок — это три
    // массива по 285 чисел, а ходов за партию не больше totalCells.
    // Сейчас используется только последний элемент (отмена одного, самого
    // последнего хода — так решили сознательно, см. обсуждение в чате);
    // остальной стек хранится на будущее, если позже понадобится отмена
    // на несколько ходов назад.
    const history = [];

    const targetScore = Math.max(0, Math.min(9999, Math.floor(options.targetScore) || 0));
    let targetFillPercent = options.targetFillPercent;
    if (typeof targetFillPercent !== 'number' || isNaN(targetFillPercent)) targetFillPercent = 100;
    targetFillPercent = Math.max(0, Math.min(100, Math.floor(targetFillPercent)));
    const scoreRuleActive = targetScore > 0;
    const fillRuleActive = targetFillPercent > 0 && targetFillPercent < 100;

    function snapshotForHistory(){
      return {
        state: cloneState(state),
        scores: {...scores},
        current,
        stonesPlacedTotal,
        lastMoveByPlayer: {
          1: lastMoveByPlayer[1] ? {...lastMoveByPlayer[1]} : null,
          2: lastMoveByPlayer[2] ? {...lastMoveByPlayer[2]} : null
        }
      };
    }

    const matchRules = { targetScore, targetFillPercent, scoreRuleActive, fillRuleActive, extraTurnOnCapture };

    // Лёгкий узел перехода поверх ЖИВОГО состояния матча (без копирования
    // доски): applyMove выполняет ход тем же applyTransitionInPlace, что и
    // поиск бота/self-play, и затем забирает обратно очередь, счёт и т.д.
    function liveNode(){
      return { state, rows, cols, scores: { 1: scores[1], 2: scores[2] }, current,
        stonesPlacedTotal, gameOver, winner: null, rules: matchRules };
    }

    function isLegal(x, y){
      return transitionRejectReason(liveNode(), current, x, y) === null;
    }

    // Самоубийство обрабатывается общим captureSuicideRegion внутри
    // applyTransitionInPlace (см. выше, «Единый лёгкий переход»).

    // Выполняет ход player-а. Возвращает {ok:true, ...} при успехе или
    // {ok:false, reason} при недопустимом ходе — второе не мутирует состояние.
    function applyMove(player, x, y){
      if (gameOver) return { ok:false, reason:'game-over' };
      if (player !== current) return { ok:false, reason:'not-your-turn' };
      if (!isLegal(x, y)) return { ok:false, reason:'illegal-cell' };

      history.push(snapshotForHistory());

      // Тот же переход, что у поиска бота и self-play (см. applyTransitionInPlace).
      const node = liveNode();
      const res = applyTransitionInPlace(node, player, x, y);
      if (!res.ok){ history.pop(); return res; } // защитно: isLegal уже проверен
      stonesPlacedTotal = node.stonesPlacedTotal;
      current = node.current;
      scores[1] = node.scores[1];
      scores[2] = node.scores[2];
      gameOver = node.gameOver;
      const logEntry = {x, y, p: player, gained: res.gained.length};
      if (res.suicide.length) logEntry.suicide = true;
      moveLog.push(logEntry);
      lastMoveByPlayer[player] = {x, y};
      return res;
    }

    // Досрочное завершение (аналог кнопки «Закончить игру»).
    function endNow(){
      if (gameOver) return { ok:false, reason:'game-over' };
      gameOver = true;
      const winner = scores[1] > scores[2] ? 1 : (scores[2] > scores[1] ? 2 : 0);
      return { ok:true, gameOver, winner, scores: {...scores} };
    }

    // Кто сделал самый последний ход партии (тот, чей ход в принципе можно
    // отменить прямо сейчас) — null, если ходов ещё не было.
    function lastMoverSeat(){
      return moveLog.length ? moveLog[moveLog.length - 1].p : null;
    }

    // Можно ли сейчас отменить последний ход: партия не окончена и хотя бы
    // один ход уже сделан. Сама проверка "тот ли игрок просит" и получение
    // согласия соперника — забота вызывающего кода (см. server.js), движок
    // отвечает только за то, ЧТО значит "отменить" применительно к доске.
    function canUndoLastMove(){
      return undoAllowed && !gameOver && history.length > 0;
    }

    // Отменяет ровно последний применённый ход, откатывая доску, счёт,
    // очередь хода и счётчик точек к снимку, снятому непосредственно перед
    // этим ходом (см. history/snapshotForHistory выше). Полный откат, а не
    // точечная отмена одной точки — единственный надёжный способ учитывая,
    // что ход мог вызвать захват (сразу три слоя состояния + очки).
    function undoLastMove(){
      if (!undoAllowed) return { ok:false, reason:'undo-disabled' };
      if (!canUndoLastMove()) return { ok:false, reason: gameOver ? 'game-over' : 'nothing-to-undo' };
      const prev = history.pop();
      state.stone = prev.state.stone;
      state.dead = prev.state.dead;
      state.territory = prev.state.territory;
      scores[1] = prev.scores[1];
      scores[2] = prev.scores[2];
      current = prev.current;
      stonesPlacedTotal = prev.stonesPlacedTotal;
      lastMoveByPlayer[1] = prev.lastMoveByPlayer[1];
      lastMoveByPlayer[2] = prev.lastMoveByPlayer[2];
      moveLog.pop();
      return { ok:true, current, scores: {...scores}, stonesPlacedTotal };
    }

    // Поиск с диагностикой: { move, trace }. searchOpts — { nodeLimit,
    // timeLimit, emergencyTimeLimit, clock } (см. searchMove).
    function botSearch(difficultyKey, weights, searchOpts){
      const diff = DIFFICULTY[difficultyKey] || DIFFICULTY.normal;
      // Полные правила матча: пороги очков/заполнения, доп. ход, дебютная
      // зона по stonesPlacedTotal, конец партии.
      return searchMove(state, rows, cols, current, diff, weights || BOT_WEIGHTS,
        Object.assign({}, searchOpts || {}, { stonesPlacedTotal, gameOver, rules: matchRules }));
    }

    // Совместимый интерфейс: только ход {x,y} или null. Необязательный
    // searchOpts.onTrace(trace) получает диагностику без смены возврата.
    function botMove(difficultyKey, weights, searchOpts){
      const r = botSearch(difficultyKey, weights, searchOpts);
      if (searchOpts && typeof searchOpts.onTrace === 'function') searchOpts.onTrace(r.trace);
      return r.move;
    }

    // Полный снимок состояния — то, что уходит клиенту по WebSocket.
    function getSnapshot(){
      return {
        sizeKey, rows, cols,
        stone: state.stone.map(r => r.slice()),
        dead: state.dead.map(r => r.slice()),
        territory: state.territory.map(r => r.slice()),
        current, scores: {...scores}, gameOver, stonesPlacedTotal,
        openingZone: getOpeningZone(rows, cols),
        lastMoveByPlayer: {
          1: lastMoveByPlayer[1] ? {...lastMoveByPlayer[1]} : null,
          2: lastMoveByPlayer[2] ? {...lastMoveByPlayer[2]} : null
        },
        lastMoverSeat: lastMoverSeat(),
        canUndo: canUndoLastMove(),
        rules: { targetScore, targetFillPercent, scoreRuleActive, fillRuleActive, totalCells, extraTurnOnCapture, firstPlayer, undoAllowed }
      };
    }

    function getMoveLog(){ return moveLog.slice(); }

    return { rows, cols, sizeKey, applyMove, endNow, botMove, botSearch, getSnapshot, getMoveLog, undoLastMove, canUndoLastMove, lastMoverSeat };
  }

  // Replay identity describes rule semantics, not the npm package version.
  const ENGINE_VERSION = 'tochki-rules-1';
  const BOT_VERSION = 'tochki-ab-1';
  const WEIGHTS_VERSION = 'tochki-weights-1';

  // Record successful transitions at the shared engine boundary so server,
  // CLI and offline callers cannot silently lose undo/end events.
  function createMatch(options){
    const match = createRawMatch(options);
    const initial = match.getSnapshot();
    const events = [];
    const copy = value => JSON.parse(JSON.stringify(value));
    const metadata = copy((options && options.replayMetadata) || {
      botVersion: BOT_VERSION, weightsVersion: WEIGHTS_VERSION,
      seed: null, budgets: null, weights: null
    });
    const apply = match.applyMove;
    const undo = match.undoLastMove;
    const end = match.endNow;
    const terminal = reason => {
      const s = match.getSnapshot();
      events.push({ type: 'end', reason, winner: s.scores[1] > s.scores[2] ? 1 : s.scores[2] > s.scores[1] ? 2 : 0,
        scores: s.scores });
    };
    match.applyMove = (player, x, y, decision) => {
      // Clone before mutation: even invalid metadata must not partially apply.
      const recordedDecision = decision === undefined ? undefined : copy(decision);
      const result = apply(player, x, y);
      if (result.ok){
        const event = { type: 'move', player, x, y };
        if (recordedDecision !== undefined) event.decision = recordedDecision;
        events.push(event);
        if (result.gameOver) terminal('rule');
      }
      return result;
    };
    match.undoLastMove = () => {
      const result = undo();
      if (result.ok) events.push({ type: 'undo' });
      return result;
    };
    match.endNow = (reason = 'manual') => {
      if (reason !== 'manual' && reason !== 'abandoned') return { ok: false, reason: 'invalid-end-reason' };
      const result = end();
      if (result.ok) terminal(reason);
      return result;
    };
    match.getReplay = () => copy({
      format: 'tochki-replay', version: 1, engineVersion: ENGINE_VERSION,
      board: { sizeKey: initial.sizeKey, rows: initial.rows, cols: initial.cols },
      rules: initial.rules, metadata, events
    });
    return match;
  }

  return {
    ENGINE_VERSION, BOT_VERSION, WEIGHTS_VERSION,
    SIZES, DIFFICULTY, TRAIN_DIFF, BOT_PLAYER, BOT_WEIGHTS,
    OPENING_ZONE_SIDE, getOpeningZone, inZone,
    createEmptyState, cloneState, cellOwner, isWall, runCaptures,
    generateCandidates, tacticalCandidates, strategicCandidates, searchCandidates, legalCandidates, quickScore, computeTerritoryPotential, evaluateStatic,
    computeGroupLiberties, libertyRisk, computeUrgentCells, hasUrgentAtari,
    chooseMove, searchMove, createSearchBudget, isBoardFull, countFilledCells, checkEndConditions,
    normalizeRules, createSearchNode, cloneSearchNode, applyTransition, applyTransitionInPlace,
    isTransitionLegal, terminalValue, WIN_SCORE,
    createMatch
  };
});
