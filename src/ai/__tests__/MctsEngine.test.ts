import { describe, it, expect } from 'vitest';
import { FastBoard } from '../FastBoard';
import { isCapturedInLadder } from '../GoHeuristics';
import { MctsEngine } from '../MctsEngine';
import {
  AIDifficulty,
  BLACK,
  Coord,
  EMPTY,
  PlayerColor,
  WHITE,
  opponentColor,
} from '../../rules/types';
import { GoEngine } from '../../rules/GoEngine';
import { calculateScore, estimateDeadStones } from '../../rules/scoring';

describe('MctsEngine & Tactical Heuristics', () => {
  it('immediately captures an opponent group in Atari and never fills own true eye', () => {
    const go = new GoEngine({
      boardSize: 9,
      ruleset: 'korean',
      handicap: 0,
      komi: 6.5,
      superko: true,
      mode: 'ai',
      humanColor: WHITE,
      aiDifficulty: 4,
      mainTimeSeconds: 0,
      byoyomiSeconds: 0,
      byoyomiPeriods: 0,
    });

    // Place White stone at (4,4) surrounded on 3 sides by Black at (3,4), (5,4), (4,3) -> only liberty is (4,5)!
    go.playMove(3, 4); // B
    go.playMove(4, 4); // W
    go.playMove(5, 4); // B
    go.playMove(0, 8); // W tenuki
    go.playMove(4, 3); // B puts W(4,4) in Atari!
    go.playMove(0, 7); // W blunders tenuki!

    const ai = new MctsEngine();
    const res = ai.chooseMove({
      board: go.board,
      size: 9,
      color: BLACK,
      ruleset: 'korean',
      komi: 6.5,
      koPoint: null,
      captures: go.captures,
      lastMove: { x: 0, y: 7 },
      opponentPassed: false,
      moveCount: go.history.length,
      positionHashes: Array.from(go.positionHashes).map((h) => h.toString()),
      difficulty: 4,
    });

    expect(res.coord).toEqual({ x: 4, y: 5 });
    expect(res.simulations).toBeGreaterThan(50);
  });

  it('detects classic Ladder (축) capture and Ladder Breaker (축머리) accurately', () => {
    const fb = new FastBoard(9);
    // Classic Ladder setup around White(2,2): Black at (2,1), (1,2), and (1,3)
    fb.play(1 * 9 + 2, BLACK); // (2,1)
    fb.play(2 * 9 + 2, WHITE); // (2,2)
    fb.play(2 * 9 + 1, BLACK); // (1,2)
    fb.play(3 * 9 + 1, BLACK); // (1,3)

    // 1) Clean board ahead: Black chases W(2,2) all the way to the edge and captures!
    expect(isCapturedInLadder(fb, 2 * 9 + 2, BLACK, 0, 28)).toBe(true);

    // 2) Place a White Ladder-Breaker (축머리) stone along the diagonal path at (5,5)!
    fb.play(5 * 9 + 5, WHITE);
    expect(isCapturedInLadder(fb, 2 * 9 + 2, BLACK, 0, 28)).toBe(false);
  });

  it('operates cleanly across Lv.1 to Lv.5 on 19x19 opening', () => {
    const go = new GoEngine({
      boardSize: 19,
      ruleset: 'korean',
      handicap: 0,
      komi: 6.5,
      superko: true,
      mode: 'ai',
      humanColor: BLACK,
      aiDifficulty: 1,
      mainTimeSeconds: 0,
      byoyomiSeconds: 0,
      byoyomiPeriods: 0,
    });
    go.playMove(15, 3); // Black plays 4-4 Hoshi

    const ai = new MctsEngine();
    const resLv1 = ai.chooseMove({
      board: go.board,
      size: 19,
      color: WHITE,
      ruleset: 'korean',
      komi: 6.5,
      koPoint: null,
      captures: go.captures,
      lastMove: { x: 15, y: 3 },
      opponentPassed: false,
      moveCount: 1,
      positionHashes: Array.from(go.positionHashes).map((h) => h.toString()),
      difficulty: 1,
    });

    expect(resLv1.coord).not.toBeNull();
    expect(go.validateMove(resLv1.coord!.x, resLv1.coord!.y, WHITE).valid).toBe(true);
  });

  it('returns ranked Top-3 hint suggestions with valid coordinates and bounded winrates', () => {
    const go = new GoEngine({
      boardSize: 9,
      ruleset: 'korean',
      handicap: 0,
      komi: 6.5,
      superko: true,
      mode: 'ai',
      humanColor: BLACK,
      aiDifficulty: 3,
      mainTimeSeconds: 0,
      byoyomiSeconds: 0,
      byoyomiPeriods: 0,
    });
    go.playMove(4, 4); // B
    go.playMove(2, 2); // W

    const ai = new MctsEngine();
    const res = ai.chooseMove({
      board: go.board,
      size: 9,
      color: BLACK,
      ruleset: 'korean',
      komi: 6.5,
      koPoint: null,
      captures: go.captures,
      lastMove: { x: 2, y: 2 },
      opponentPassed: false,
      moveCount: 2,
      positionHashes: Array.from(go.positionHashes).map((h) => h.toString()),
      difficulty: 3,
      gameType: 'baduk',
      includeHints: true,
    });

    expect(res.coord).not.toBeNull();
    expect(res.topSuggestions).toBeDefined();
    expect(res.topSuggestions!.length).toBeGreaterThanOrEqual(1);
    expect(res.topSuggestions!.length).toBeLessThanOrEqual(3);
    for (const s of res.topSuggestions!) {
      expect(s.winrate).toBeGreaterThanOrEqual(0);
      expect(s.winrate).toBeLessThanOrEqual(1);
      expect(go.validateMove(s.coord.x, s.coord.y, BLACK).valid).toBe(true);
    }
  });
});

function createDeterministicRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function withSeededRandom<T>(seed: number, fn: () => T): T {
  const origRandom = Math.random;
  Math.random = createDeterministicRng(seed);
  try {
    return fn();
  } finally {
    Math.random = origRandom;
  }
}

function createGo9Engine(aiDifficulty: AIDifficulty = 3): GoEngine {
  return new GoEngine({
    boardSize: 9,
    ruleset: 'korean',
    handicap: 0,
    komi: 6.5,
    superko: true,
    mode: 'ai',
    humanColor: BLACK,
    aiDifficulty,
    mainTimeSeconds: 0,
    byoyomiSeconds: 0,
    byoyomiPeriods: 0,
  });
}

/**
 * Deterministic ordinary casual-human Baduk policy on 9x9:
 * - Plays basic captures, saves own chains in Atari, avoids self-atari and own true eyes
 * - Applies basic 3rd/4th-line opening instincts, local extension, and simple shape connections
 * - Does NOT perform MCTS, Snapback, Double-Atari, Nakade, or Ladder lookahead
 */
function selectCasualBadukMove(go: GoEngine, rng: () => number): Coord | null {
  const size = go.size;
  const total = size * size;
  const color = go.currentTurn;
  const opp = opponentColor(color);
  const moveCount = go.history.length;
  const lastMove = moveCount > 0 ? go.history[moveCount - 1].coord : null;
  const oppPassed = moveCount > 0 && lastMove === null;

  const deadMask = moveCount > total * 0.35 ? estimateDeadStones(go.board, size) : new Uint8Array(total);
  const scoreInfo =
    moveCount > total * 0.35
      ? calculateScore({
          board: go.board,
          size,
          ruleset: 'korean',
          komi: go.config.komi,
          captures: go.captures,
          deadStoneMask: deadMask,
        })
      : null;

  if (oppPassed && scoreInfo && scoreInfo.dameCount === 0 && moveCount >= total * 0.35) {
    return null;
  }

  const fb = new FastBoard(size);
  fb.copyFromState(
    go.board,
    go.koPoint ? go.koPoint.y * size + go.koPoint.x : -1,
    go.captures.black,
    go.captures.white
  );
  const sim = new FastBoard(size);

  let bestCoord: Coord | null = null;
  let bestScore = -1e9;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      if (go.board[idx] !== EMPTY) continue;
      if (fb.isTrueEye(idx, color)) continue;

      if (scoreInfo && scoreInfo.territoryMap[idx] === color) {
        let nearOpp = false;
        for (let dy = -2; dy <= 2 && !nearOpp; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (Math.abs(dx) + Math.abs(dy) > 2) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (
              nx >= 0 &&
              nx < size &&
              ny >= 0 &&
              ny < size &&
              go.board[ny * size + nx] === opp &&
              !deadMask[ny * size + nx]
            ) {
              nearOpp = true;
              break;
            }
          }
        }
        if (!nearOpp) continue;
      }

      if (!go.validateMove(x, y, color).valid) continue;

      sim.copyFrom(fb);
      const captured = sim.play(idx, color);
      if (captured < 0) continue;

      const afterOwn = sim.analyzeChain(idx, 4);
      let score = 1.0 + rng() * 0.35;

      if (captured > 0) {
        score += 12.0 + captured * 6.0;
      }
      if (afterOwn.libertyCount === 1 && captured === 0) {
        score -= afterOwn.stoneCount >= 2 ? 45.0 : 25.0;
      }

      const nbrs = fb.getNeighborsOffset(idx);
      const diags = fb.getDiagonalsOffset(idx);
      let ownNbrs = 0;
      let oppNbrs = 0;
      let ownDiags = 0;

      for (let i = 0; i < 4; i++) {
        const n = nbrs[i];
        if (n < 0) break;
        if (fb.grid[n] === color) {
          ownNbrs++;
          const beforeCh = fb.analyzeChain(n, 3);
          if (beforeCh.libertyCount === 1 && afterOwn.libertyCount >= 2) {
            score += 9.5 + beforeCh.stoneCount * 4.5;
          } else if (beforeCh.libertyCount === 2 && afterOwn.libertyCount >= 3) {
            score += 2.4;
          }
        } else if (fb.grid[n] === opp) {
          oppNbrs++;
          if (sim.grid[n] === opp) {
            const oppAfter = sim.analyzeChain(n, 3);
            if (oppAfter.libertyCount === 1) {
              score += 4.0 + oppAfter.stoneCount * 2.2;
            } else if (oppAfter.libertyCount === 2) {
              score += 1.4;
            }
          }
        }
      }

      for (let i = 0; i < 4; i++) {
        const d = diags[i];
        if (d < 0) break;
        if (fb.grid[d] === color) ownDiags++;
      }

      if (ownDiags >= 1 && ownNbrs === 1 && oppNbrs >= 1) score += 2.2;
      if (ownDiags >= 2 && ownNbrs === 0) score += 1.6;
      if (ownNbrs >= 2 && afterOwn.libertyCount >= 3) score += 1.8;

      if (lastMove) {
        const dist = Math.abs(x - lastMove.x) + Math.abs(y - lastMove.y);
        if (dist === 1) score += 2.6;
        else if (dist === 2) score += 2.0;
        else if (dist <= 3) score += 1.0;
      }

      const minEdge = Math.min(Math.min(x, size - 1 - x), Math.min(y, size - 1 - y));
      if (moveCount < 12) {
        if (minEdge >= 2) score += 3.2;
        else if (minEdge === 1) score += 0.4;
        else score -= 4.0;
      } else if (minEdge === 0 && captured === 0 && oppNbrs === 0) {
        score -= 2.5;
      }

      if (score > bestScore) {
        bestScore = score;
        bestCoord = { x, y };
      }
    }
  }

  if (scoreInfo && scoreInfo.dameCount === 0 && bestScore < 4.0) {
    return null;
  }
  return bestCoord;
}

function playFullBaduk9Match(
  blackMove: (go: GoEngine) => Coord | null,
  whiteMove: (go: GoEngine) => Coord | null,
  maxPlies = 85
): PlayerColor | 'draw' {
  const go = createGo9Engine(3);
  for (let m = 0; m < maxPlies && go.phase === 'playing'; m++) {
    const coord = go.currentTurn === BLACK ? blackMove(go) : whiteMove(go);
    if (!coord) {
      go.pass();
    } else if (!go.playMove(coord.x, coord.y).valid) {
      go.pass();
    }
  }
  const dead = estimateDeadStones(go.board, 9);
  const sc = calculateScore({
    board: go.board,
    size: 9,
    ruleset: 'korean',
    komi: 6.5,
    captures: go.captures,
    deadStoneMask: dead,
  });
  return sc.winner;
}

function makeMctsPolicy(ai: MctsEngine, difficulty: AIDifficulty): (go: GoEngine) => Coord | null {
  return (go: GoEngine) => {
    const last = go.history.length > 0 ? go.history[go.history.length - 1] : null;
    return ai.chooseMove({
      board: go.board,
      size: 9,
      color: go.currentTurn,
      ruleset: 'korean',
      komi: 6.5,
      koPoint: go.koPoint,
      captures: go.captures,
      lastMove: last?.coord ?? null,
      opponentPassed: last !== null && last.coord === null,
      moveCount: go.history.length,
      positionHashes: Array.from(go.positionHashes).map((h) => h.toString()),
      difficulty,
    }).coord;
  };
}

function makeBoard9(blackPts: Array<[number, number]>, whitePts: Array<[number, number]>): Uint8Array {
  const board = new Uint8Array(81);
  for (const [x, y] of blackPts) board[y * 9 + x] = BLACK;
  for (const [x, y] of whitePts) board[y * 9 + x] = WHITE;
  return board;
}

function buildBalancedLateMidgame9(seed: number, plies = 58): GoEngine {
  const go = createGo9Engine(3);
  const rng = createDeterministicRng(seed);
  for (let i = 0; i < plies && go.phase === 'playing'; i++) {
    const mv = selectCasualBadukMove(go, rng);
    if (!mv) go.pass();
    else go.playMove(mv.x, mv.y);
  }
  return go;
}

describe('MctsEngine Difficulty Calibration & Benchmarks', () => {
  it('enforces sharp tactical Hint Contract at Lv.3 (Snapback & Double Atari)', () => {
    const ai = new MctsEngine();

    // Snapback (환격) throw-in at (2,1)
    const snapbackBoard = makeBoard9(
      [
        [1, 0],
        [4, 0],
        [4, 1],
        [3, 2],
        [2, 3],
        [1, 3],
        [0, 2],
        [0, 1],
      ],
      [
        [2, 0],
        [3, 0],
        [3, 1],
        [2, 2],
        [1, 2],
      ]
    );
    const snapHint = ai.chooseMove({
      board: snapbackBoard,
      size: 9,
      color: BLACK,
      ruleset: 'korean',
      komi: 6.5,
      koPoint: null,
      captures: { black: 0, white: 0 },
      lastMove: { x: 1, y: 2 },
      opponentPassed: false,
      moveCount: 13,
      positionHashes: [],
      difficulty: 3,
      gameType: 'baduk',
      includeHints: true,
    });
    expect(snapHint.coord).toEqual({ x: 2, y: 1 });
    expect(snapHint.topSuggestions?.[0].coord).toEqual({ x: 2, y: 1 });

    // Double Atari (양단수) at (4,4)
    const doubleAtariBoard = makeBoard9(
      [
        [2, 4],
        [3, 5],
        [5, 3],
        [4, 2],
        [3, 3],
      ],
      [
        [3, 4],
        [4, 3],
        [2, 3],
      ]
    );
    const doubleHint = ai.chooseMove({
      board: doubleAtariBoard,
      size: 9,
      color: BLACK,
      ruleset: 'korean',
      komi: 6.5,
      koPoint: null,
      captures: { black: 0, white: 0 },
      lastMove: { x: 2, y: 3 },
      opponentPassed: false,
      moveCount: 8,
      positionHashes: [],
      difficulty: 3,
      gameType: 'baduk',
      includeHints: true,
    });
    expect(doubleHint.coord).toEqual({ x: 4, y: 4 });
    expect(doubleHint.topSuggestions?.[0].coord).toEqual({ x: 4, y: 4 });
  });

  it(
    'maintains monotonic strength progression (Lv.1 < Lv.2 < Lv.3 < Lv.4 <= Lv.5)',
    () => {
      withSeededRandom(20261114, () => {
        const ai = new MctsEngine();

        const runHeadToHead9 = (high: AIDifficulty, low: AIDifficulty, games: number): number => {
          let highWins = 0;
          for (let g = 0; g < games; g++) {
            const highIsBlack = g % 2 === 0;
            const highPolicy = makeMctsPolicy(ai, high);
            const lowPolicy = makeMctsPolicy(ai, low);
            const winner = highIsBlack
              ? playFullBaduk9Match(highPolicy, lowPolicy)
              : playFullBaduk9Match(lowPolicy, highPolicy);
            if (winner === (highIsBlack ? BLACK : WHITE)) highWins++;
          }
          return highWins / games;
        };

        const lv2VsLv1 = runHeadToHead9(2, 1, 4);
        const lv3VsLv2 = runHeadToHead9(3, 2, 4);
        expect(lv2VsLv1).toBeGreaterThan(0.5);
        expect(lv3VsLv2).toBeGreaterThan(0.5);

        // Curated 9x9 Tactical Suite verifying Lv.1..3 < Lv.4 <= Lv.5
        const snapbackBoard = makeBoard9(
          [
            [1, 0],
            [4, 0],
            [4, 1],
            [3, 2],
            [2, 3],
            [1, 3],
            [0, 2],
            [0, 1],
          ],
          [
            [2, 0],
            [3, 0],
            [3, 1],
            [2, 2],
            [1, 2],
          ]
        );
        const doubleAtariBoard = makeBoard9(
          [
            [2, 4],
            [3, 5],
            [5, 3],
            [4, 2],
            [3, 3],
          ],
          [
            [3, 4],
            [4, 3],
            [2, 3],
          ]
        );

        const tacticalHits: Record<AIDifficulty, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        for (const diff of [1, 2, 3, 4, 5] as AIDifficulty[]) {
          const r1 = ai.chooseMove({
            board: snapbackBoard,
            size: 9,
            color: BLACK,
            ruleset: 'korean',
            komi: 6.5,
            koPoint: null,
            captures: { black: 0, white: 0 },
            lastMove: { x: 1, y: 2 },
            opponentPassed: false,
            moveCount: 13,
            positionHashes: [],
            difficulty: diff,
          });
          if (r1.coord?.x === 2 && r1.coord?.y === 1) tacticalHits[diff]++;

          const r2 = ai.chooseMove({
            board: doubleAtariBoard,
            size: 9,
            color: BLACK,
            ruleset: 'korean',
            komi: 6.5,
            koPoint: null,
            captures: { black: 0, white: 0 },
            lastMove: { x: 2, y: 3 },
            opponentPassed: false,
            moveCount: 8,
            positionHashes: [],
            difficulty: diff,
          });
          if (r2.coord?.x === 4 && r2.coord?.y === 4) tacticalHits[diff]++;
        }

        expect(tacticalHits[4]).toBe(2);
        expect(tacticalHits[5]).toBe(2);
        expect(tacticalHits[3]).toBeLessThan(tacticalHits[4]);
        expect(tacticalHits[5]).toBeGreaterThanOrEqual(tacticalHits[4]);
        console.info(
          `[Baduk Monotonic] Lv2vs1=${(lv2VsLv1 * 100).toFixed(1)}%, Lv3vs2=${(lv3VsLv2 * 100).toFixed(1)}%, tacticalHits=${JSON.stringify(tacticalHits)}`
        );
      });
    },
    90_000
  );

  it(
    'allows casual-human baseline >= 50% winrate vs Lv.1..3 while Lv.4 and Lv.5 beat casual baseline',
    () => {
      withSeededRandom(3030, () => {
        const ai = new MctsEngine();

        const runCasualVsAiFull = (diff: AIDifficulty, games: number): number => {
          let casualWins = 0;
          const rng = createDeterministicRng(500 + diff);
          for (let g = 0; g < games; g++) {
            const casualAsBlack = g % 2 === 0;
            const casualPolicy = (go: GoEngine) => selectCasualBadukMove(go, rng);
            const aiPolicy = makeMctsPolicy(ai, diff);
            const winner = casualAsBlack
              ? playFullBaduk9Match(casualPolicy, aiPolicy)
              : playFullBaduk9Match(aiPolicy, casualPolicy);
            if (winner === (casualAsBlack ? BLACK : WHITE)) casualWins++;
          }
          return casualWins / games;
        };

        const casualVsLv1 = runCasualVsAiFull(1, 4);
        const casualVsLv2 = runCasualVsAiFull(2, 4);
        const casualVsLv3 = runCasualVsAiFull(3, 6);

        expect(casualVsLv1).toBeGreaterThanOrEqual(0.5);
        expect(casualVsLv2).toBeGreaterThanOrEqual(0.5);
        expect(casualVsLv3).toBeGreaterThanOrEqual(0.5);

        // Balanced 9x9 late-midgame finishes from 58-move contested positions (seeds verified within +/- 2.5 pts)
        const balancedSeeds58 = [1038, 2249];
        const runCasualVsCompetitive = (diff: AIDifficulty): number => {
          let casualWins = 0;
          const rng = createDeterministicRng(900 + diff);
          const aiPolicy = makeMctsPolicy(ai, diff);
          for (let g = 0; g < balancedSeeds58.length; g++) {
            const go = buildBalancedLateMidgame9(balancedSeeds58[g], 58);
            const aiAsBlack = g % 2 === 1;
            for (let m = 0; m < 16 && go.phase === 'playing'; m++) {
              const isAiTurn = (go.currentTurn === BLACK) === aiAsBlack;
              const mv = isAiTurn ? aiPolicy(go) : selectCasualBadukMove(go, rng);
              if (!mv) go.pass();
              else if (!go.playMove(mv.x, mv.y).valid) go.pass();
            }
            const sc = calculateScore({
              board: go.board,
              size: 9,
              ruleset: 'korean',
              komi: 6.5,
              captures: go.captures,
              deadStoneMask: estimateDeadStones(go.board, 9),
            });
            const casualColor = aiAsBlack ? WHITE : BLACK;
            if (sc.winner === casualColor) casualWins++;
          }
          return casualWins / balancedSeeds58.length;
        };

        const casualVsLv4 = runCasualVsCompetitive(4);
        const casualVsLv5 = runCasualVsCompetitive(5);

        expect(casualVsLv4).toBeLessThan(0.5);
        expect(casualVsLv5).toBeLessThan(0.5);
        console.info(
          `[Baduk Casual Winrates] vsLv1=${(casualVsLv1 * 100).toFixed(1)}%, vsLv2=${(casualVsLv2 * 100).toFixed(1)}%, vsLv3=${(casualVsLv3 * 100).toFixed(1)}%, vsLv4=${(casualVsLv4 * 100).toFixed(1)}%, vsLv5=${(casualVsLv5 * 100).toFixed(1)}%`
        );
      });
    },
    120_000
  );
});
