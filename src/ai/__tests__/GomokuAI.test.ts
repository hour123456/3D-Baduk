import { describe, it, expect } from 'vitest';
import { GomokuAI } from '../GomokuAI';
import { GomokuEngine, checkRenjuForbidden, checkWinAt } from '../../rules/GomokuEngine';
import {
  AIDifficulty,
  BLACK,
  Coord,
  EMPTY,
  PlayerColor,
  WHITE,
  opponentColor,
} from '../../rules/types';

describe('GomokuAI (Omok 5-Level Engine)', () => {
  it('immediately plays an open winning 5-in-a-row move when available', () => {
    const board = new Uint8Array(15 * 15);
    // White has 4 in a row at (5,7)..(8,7), blocked at (4,7) by Black, open at (9,7)
    board[7 * 15 + 4] = BLACK;
    board[7 * 15 + 5] = WHITE;
    board[7 * 15 + 6] = WHITE;
    board[7 * 15 + 7] = WHITE;
    board[7 * 15 + 8] = WHITE;

    const ai = new GomokuAI();
    const res = ai.chooseMove({
      board,
      size: 15,
      color: WHITE,
      ruleset: 'korean',
      komi: 0,
      koPoint: null,
      captures: { black: 0, white: 0 },
      lastMove: { x: 4, y: 7 },
      opponentPassed: false,
      moveCount: 5,
      positionHashes: [],
      difficulty: 3,
      gameType: 'omok',
      omokRuleset: 'renju',
    });

    expect(res.coord).toEqual({ x: 9, y: 7 });
    expect(res.engineBackend).toBe('katago-omok-puct');
  });

  it('immediately blocks opponent straight four threat across competitive levels', () => {
    const board = new Uint8Array(15 * 15);
    // White threatens winning 5 at (7,7) because (2,7) is capped by Black
    board[7 * 15 + 2] = BLACK;
    board[7 * 15 + 3] = WHITE;
    board[7 * 15 + 4] = WHITE;
    board[7 * 15 + 5] = WHITE;
    board[7 * 15 + 6] = WHITE;
    board[0 * 15 + 0] = BLACK;
    board[0 * 15 + 1] = BLACK;

    const ai = new GomokuAI();
    for (const diff of [2, 3, 4, 5] as AIDifficulty[]) {
      const res = ai.chooseMove({
        board,
        size: 15,
        color: BLACK,
        ruleset: 'korean',
        komi: 0,
        koPoint: null,
        captures: { black: 0, white: 0 },
        lastMove: { x: 6, y: 7 },
        opponentPassed: false,
        moveCount: 7,
        positionHashes: [],
        difficulty: diff,
        gameType: 'omok',
        omokRuleset: 'renju',
      });
      expect(res.coord).toEqual({ x: 7, y: 7 });
    }
  });

  it('never chooses a Renju forbidden intersection when playing Black across Lv.1 to Lv.5', () => {
    const engine = new GomokuEngine({
      boardSize: 15,
      ruleset: 'korean',
      gameType: 'omok',
      omokRuleset: 'renju',
      handicap: 0,
      komi: 0,
      superko: false,
      mode: 'ai',
      humanColor: WHITE,
      aiDifficulty: 4,
      mainTimeSeconds: 0,
      byoyomiSeconds: 0,
      byoyomiPeriods: 0,
    });

    // Construct an open 3-3 trap at (7,7) surrounded by strong shapes
    engine.playMove(5, 7); // B
    engine.playMove(1, 1); // W
    engine.playMove(6, 7); // B
    engine.playMove(1, 2); // W
    engine.playMove(7, 5); // B
    engine.playMove(2, 1); // W
    engine.playMove(7, 6); // B
    engine.playMove(2, 2); // W

    expect(checkRenjuForbidden(new Uint8Array(engine.board), 15, 7, 7).forbidden).toBe(true);

    const ai = new GomokuAI();
    for (const difficulty of [1, 2, 3, 4, 5] as AIDifficulty[]) {
      const res = ai.chooseMove({
        board: engine.board,
        size: 15,
        color: BLACK,
        ruleset: 'korean',
        komi: 0,
        koPoint: null,
        captures: engine.captures,
        lastMove: { x: 2, y: 2 },
        opponentPassed: false,
        moveCount: engine.history.length,
        positionHashes: [],
        difficulty,
        gameType: 'omok',
        omokRuleset: 'renju',
        includeHints: true,
      });

      expect(res.coord).not.toBeNull();
      const chosen = res.coord!;
      expect(chosen).not.toEqual({ x: 7, y: 7 });
      expect(engine.board[chosen.y * 15 + chosen.x]).toBe(EMPTY);
      expect(checkRenjuForbidden(new Uint8Array(engine.board), 15, chosen.x, chosen.y).forbidden).toBe(
        false
      );
      expect(res.topSuggestions?.length).toBeGreaterThanOrEqual(1);
      expect(res.topSuggestions?.length).toBeLessThanOrEqual(3);
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

const OMOK_AXES: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

function countContiguousLine(
  board: Uint8Array,
  size: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: PlayerColor
): { count: number; openEnds: number } {
  let count = 1;
  let openEnds = 0;
  for (const sign of [-1, 1]) {
    let cx = x + dx * sign;
    let cy = y + dy * sign;
    while (cx >= 0 && cx < size && cy >= 0 && cy < size && board[cy * size + cx] === color) {
      count++;
      cx += dx * sign;
      cy += dy * sign;
    }
    if (cx >= 0 && cx < size && cy >= 0 && cy < size && board[cy * size + cx] === EMPTY) {
      openEnds++;
    }
  }
  return { count, openEnds };
}

function createOmok15Engine(aiDifficulty: AIDifficulty = 3): GomokuEngine {
  return new GomokuEngine({
    boardSize: 15,
    ruleset: 'korean',
    gameType: 'omok',
    omokRuleset: 'renju',
    handicap: 0,
    komi: 0,
    superko: false,
    mode: 'ai',
    humanColor: BLACK,
    aiDifficulty,
    mainTimeSeconds: 0,
    byoyomiSeconds: 0,
    byoyomiPeriods: 0,
  });
}

/**
 * Deterministic ordinary casual-human Omok policy on 15x15 (Renju):
 * - Takes immediate 5-in-a-row wins and blocks urgent 4-in-a-row threats
 * - Plays basic local shape, open-3 attack/defense, and open-2 building
 * - Does NOT search deep lookahead, multi-move VCF sequences, split-gap patterns, or fork solvers
 */
function selectCasualOmokMove(engine: GomokuEngine, rng: () => number): Coord | null {
  const size = engine.size;
  const board = engine.board;
  const color = engine.currentTurn;
  const opp = opponentColor(color);
  const center = Math.floor(size / 2);

  if (engine.history.length === 0) return { x: center, y: center };

  const legalMoves: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (board[y * size + x] !== EMPTY) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < size && ny >= 0 && ny < size && board[ny * size + nx] !== EMPTY) {
            near = true;
            break;
          }
        }
      }
      if (!near) continue;
      if (color === BLACK && checkRenjuForbidden(board, size, x, y).forbidden) continue;
      legalMoves.push({ x, y });
    }
  }

  if (legalMoves.length === 0) return null;

  for (const m of legalMoves) {
    if (checkWinAt(board, size, m.x, m.y, color, 'renju').won) return m;
  }
  for (const m of legalMoves) {
    if (checkWinAt(board, size, m.x, m.y, opp, 'renju').won) return m;
  }

  let best = legalMoves[0];
  let bestScore = -1e9;
  for (const m of legalMoves) {
    let score = 30 - (Math.abs(m.x - center) + Math.abs(m.y - center)) * 1.5 + rng() * 350;
    for (const [dx, dy] of OMOK_AXES) {
      const atk = countContiguousLine(board, size, m.x, m.y, dx, dy, color);
      if (atk.count === 4 && atk.openEnds === 2) score += 75_000;
      else if (atk.count === 4 && atk.openEnds === 1) score += 1_400;
      else if (atk.count === 3 && atk.openEnds === 2) score += 5_500;
      else if (atk.count === 3 && atk.openEnds === 1) score += 450;
      else if (atk.count === 2 && atk.openEnds === 2) score += 320;
      else if (atk.count === 2 && atk.openEnds === 1) score += 55;

      const def = countContiguousLine(board, size, m.x, m.y, dx, dy, opp);
      if (def.count === 4 && def.openEnds === 2) score += 45_000;
      else if (def.count === 4 && def.openEnds === 1) score += 1_600;
      else if (def.count === 3 && def.openEnds === 2) score += 6_800;
      else if (def.count === 3 && def.openEnds === 1) score += 380;
      else if (def.count === 2 && def.openEnds === 2) score += 200;
    }
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

function makeOmokAiPolicy(ai: GomokuAI, difficulty: AIDifficulty): (e: GomokuEngine) => Coord | null {
  return (e: GomokuEngine) => {
    const last = e.history.length > 0 ? e.history[e.history.length - 1] : null;
    return ai.chooseMove({
      board: e.board,
      size: 15,
      color: e.currentTurn,
      ruleset: 'korean',
      komi: 0,
      koPoint: null,
      captures: e.captures,
      lastMove: last?.coord ?? null,
      opponentPassed: false,
      moveCount: e.history.length,
      positionHashes: [],
      difficulty,
      gameType: 'omok',
      omokRuleset: 'renju',
    }).coord;
  };
}

function playOmok15Match(
  blackPolicy: (e: GomokuEngine) => Coord | null,
  whitePolicy: (e: GomokuEngine) => Coord | null,
  openingMoves: Array<[number, number]>,
  maxPlies = 60
): PlayerColor | 'draw' {
  const engine = createOmok15Engine(3);
  for (const [ox, oy] of openingMoves) {
    engine.playMove(ox, oy);
  }
  for (let m = 0; m < maxPlies && engine.phase === 'playing'; m++) {
    const mv = engine.currentTurn === BLACK ? blackPolicy(engine) : whitePolicy(engine);
    if (!mv || !engine.playMove(mv.x, mv.y).valid) break;
  }
  return engine.result?.winner ?? 'draw';
}

const NEUTRAL_OPENINGS: Array<Array<[number, number]>> = [
  [[7, 7], [7, 8], [8, 8]],
  [[7, 7], [6, 6], [8, 6]],
  [[7, 7], [8, 7], [6, 8]],
  [[7, 7], [6, 7], [8, 9]],
  [[7, 7], [8, 6], [6, 6]],
  [[7, 7], [7, 6], [9, 7]],
  [[7, 7], [8, 8], [6, 7]],
  [[7, 7], [6, 8], [8, 6]],
];

describe('GomokuAI Difficulty Calibration, Hint Contract & Renju Safety', () => {
  it('excludes Renju 4-4 and overline forbidden moves for Black across Lv.1..5 (with and without hints)', () => {
    const ai = new GomokuAI();

    // 4-4 trap for Black at (7,7): horizontal B at (5,7),(6,7),(8,7); vertical B at (7,5),(7,6),(7,8)
    const doubleFourEngine = createOmok15Engine(4);
    const setup44: Array<[number, number]> = [
      [5, 7],
      [0, 0],
      [6, 7],
      [0, 1],
      [8, 7],
      [2, 0],
      [7, 5],
      [2, 1],
      [7, 6],
      [4, 0],
      [7, 8],
      [1, 0],
    ];
    for (const [x, y] of setup44) doubleFourEngine.playMove(x, y);
    expect(checkRenjuForbidden(new Uint8Array(doubleFourEngine.board), 15, 7, 7).reason).toBe('DOUBLE_FOUR');

    // Overline trap for Black at (7,7): B at (4,7),(5,7),(6,7),(8,7),(9,7)
    const overlineEngine = createOmok15Engine(4);
    const setupOverline: Array<[number, number]> = [
      [4, 7],
      [0, 0],
      [5, 7],
      [0, 1],
      [6, 7],
      [2, 0],
      [8, 7],
      [2, 1],
      [9, 7],
      [1, 0],
    ];
    for (const [x, y] of setupOverline) overlineEngine.playMove(x, y);
    expect(checkRenjuForbidden(new Uint8Array(overlineEngine.board), 15, 7, 7).reason).toBe('OVERLINE');

    withSeededRandom(9191, () => {
      for (const eng of [doubleFourEngine, overlineEngine]) {
        for (const includeHints of [false, true]) {
          for (const difficulty of [1, 2, 3, 4, 5] as AIDifficulty[]) {
            const res = ai.chooseMove({
              board: eng.board,
              size: 15,
              color: BLACK,
              ruleset: 'korean',
              komi: 0,
              koPoint: null,
              captures: eng.captures,
              lastMove: { x: 1, y: 0 },
              opponentPassed: false,
              moveCount: eng.history.length,
              positionHashes: [],
              difficulty,
              gameType: 'omok',
              omokRuleset: 'renju',
              includeHints,
            });
            expect(res.coord).not.toBeNull();
            const c = res.coord!;
            expect(c).not.toEqual({ x: 7, y: 7 });
            expect(eng.board[c.y * 15 + c.x]).toBe(EMPTY);
            expect(checkRenjuForbidden(new Uint8Array(eng.board), 15, c.x, c.y).forbidden).toBe(false);
          }
        }
      }
    });
  });

  it('provides clean sharp Top-3 tactical hints when includeHints: true at Lv.3', () => {
    const ai = new GomokuAI();
    const board = new Uint8Array(15 * 15);
    // White has open-3 at (6,7),(7,7),(8,7); playing (5,7) or (9,7) creates Straight Open-4!
    board[7 * 15 + 6] = WHITE;
    board[7 * 15 + 7] = WHITE;
    board[7 * 15 + 8] = WHITE;
    board[6 * 15 + 6] = BLACK;
    board[8 * 15 + 8] = BLACK;
    board[5 * 15 + 9] = BLACK;

    const res = ai.chooseMove({
      board,
      size: 15,
      color: WHITE,
      ruleset: 'korean',
      komi: 0,
      koPoint: null,
      captures: { black: 0, white: 0 },
      lastMove: { x: 9, y: 5 },
      opponentPassed: false,
      moveCount: 6,
      positionHashes: [],
      difficulty: 3,
      gameType: 'omok',
      omokRuleset: 'renju',
      includeHints: true,
    });

    expect(res.coord).not.toBeNull();
    expect(
      (res.coord!.x === 5 && res.coord!.y === 7) || (res.coord!.x === 9 && res.coord!.y === 7)
    ).toBe(true);
    expect(res.topSuggestions).toBeDefined();
    expect(res.topSuggestions!.length).toBeGreaterThanOrEqual(1);
    expect(res.topSuggestions!.length).toBeLessThanOrEqual(3);
    expect(res.topSuggestions![0].coord).toEqual(res.coord);
    for (const s of res.topSuggestions!) {
      expect(s.winrate).toBeGreaterThanOrEqual(0);
      expect(s.winrate).toBeLessThanOrEqual(1);
      expect(board[s.coord.y * 15 + s.coord.x]).toBe(EMPTY);
    }
  });

  it(
    'maintains monotonic strength ordering (Lv.1 < Lv.2 < Lv.3 < Lv.4 <= Lv.5)',
    () => {
      withSeededRandom(20261114, () => {
        const ai = new GomokuAI();

        const runSeries = (
          high: AIDifficulty,
          low: AIDifficulty,
          openings: Array<Array<[number, number]>>,
          maxPlies = 70
        ): { highWins: number; lowWins: number; draws: number; scoreRate: number } => {
          let highWins = 0;
          let lowWins = 0;
          let draws = 0;
          for (let g = 0; g < openings.length; g++) {
            const highAsBlack = g % 2 === 0;
            const pHigh = makeOmokAiPolicy(ai, high);
            const pLow = makeOmokAiPolicy(ai, low);
            const winner = highAsBlack
              ? playOmok15Match(pHigh, pLow, openings[g], maxPlies)
              : playOmok15Match(pLow, pHigh, openings[g], maxPlies);
            const highCol = highAsBlack ? BLACK : WHITE;
            if (winner === 'draw') draws++;
            else if (winner === highCol) highWins++;
            else lowWins++;
          }
          const scoreRate = (highWins + draws * 0.5) / openings.length;
          return { highWins, lowWins, draws, scoreRate };
        };

        const lv2VsLv1 = runSeries(2, 1, NEUTRAL_OPENINGS);
        const lv3VsLv2 = runSeries(3, 2, NEUTRAL_OPENINGS);
        const lv4VsLv3 = runSeries(4, 3, NEUTRAL_OPENINGS.slice(0, 4));

        expect(lv2VsLv1.scoreRate).toBeGreaterThan(0.5);
        expect(lv3VsLv2.scoreRate).toBeGreaterThan(0.5);
        expect(lv4VsLv3.scoreRate).toBeGreaterThan(0.5);

        // Lv.5 vs Lv.4 on balanced tactical fighting positions (Black & White)
        const midgameFighting: Array<{ opening: Array<[number, number]>; lv5AsBlack: boolean }> = [
          {
            opening: [
              [7, 7],
              [8, 7],
              [7, 8],
              [8, 8],
              [6, 6],
              [6, 8],
              [9, 6],
              [5, 9],
              [8, 6],
              [7, 6],
            ],
            lv5AsBlack: true,
          },
          {
            opening: [
              [7, 7],
              [8, 7],
              [7, 8],
              [8, 8],
              [6, 6],
              [6, 8],
              [9, 6],
              [5, 9],
              [8, 6],
              [7, 6],
            ],
            lv5AsBlack: false,
          },
        ];

        let lv5Pts = 0;
        for (const item of midgameFighting) {
          const p5 = makeOmokAiPolicy(ai, 5);
          const p4 = makeOmokAiPolicy(ai, 4);
          const winner = item.lv5AsBlack
            ? playOmok15Match(p5, p4, item.opening, 32)
            : playOmok15Match(p4, p5, item.opening, 32);
          const lv5Col = item.lv5AsBlack ? BLACK : WHITE;
          if (winner === lv5Col) lv5Pts += 1;
          else if (winner === 'draw') lv5Pts += 0.5;
        }
        expect(lv5Pts / midgameFighting.length).toBeGreaterThanOrEqual(0.5);
        console.info(
          `[Omok Monotonic] Lv2vs1=${(lv2VsLv1.scoreRate * 100).toFixed(1)}% (${lv2VsLv1.highWins}W-${lv2VsLv1.lowWins}L-${lv2VsLv1.draws}D), Lv3vs2=${(lv3VsLv2.scoreRate * 100).toFixed(1)}% (${lv3VsLv2.highWins}W-${lv3VsLv2.lowWins}L-${lv3VsLv2.draws}D), Lv4vs3=${(lv4VsLv3.scoreRate * 100).toFixed(1)}% (${lv4VsLv3.highWins}W-${lv4VsLv3.lowWins}L-${lv4VsLv3.draws}D), Lv5vs4=${((lv5Pts / midgameFighting.length) * 100).toFixed(1)}%`
        );
      });
    },
    90_000
  );

  it(
    'allows casual-human baseline >= 50% winrate vs Lv.1..3 while Lv.4 and Lv.5 defeat casual baseline',
    () => {
      withSeededRandom(101, () => {
        const ai = new GomokuAI();

        const runCasualVsAi = (diff: AIDifficulty, games: number): number => {
          let casualWins = 0;
          const rng = createDeterministicRng(700 + diff);
          const aiPolicy = makeOmokAiPolicy(ai, diff);
          for (let g = 0; g < games; g++) {
            const casualAsBlack = g % 2 === 0;
            const casualPolicy = (e: GomokuEngine) => selectCasualOmokMove(e, rng);
            const winner = casualAsBlack
              ? playOmok15Match(casualPolicy, aiPolicy, NEUTRAL_OPENINGS[g % NEUTRAL_OPENINGS.length], 70)
              : playOmok15Match(aiPolicy, casualPolicy, NEUTRAL_OPENINGS[g % NEUTRAL_OPENINGS.length], 70);
            if (winner === (casualAsBlack ? BLACK : WHITE)) casualWins++;
          }
          return casualWins / games;
        };

        const casualVsLv1 = runCasualVsAi(1, 8);
        const casualVsLv2 = runCasualVsAi(2, 8);
        const casualVsLv3 = runCasualVsAi(3, 12);

        expect(casualVsLv1).toBeGreaterThanOrEqual(0.5);
        expect(casualVsLv2).toBeGreaterThanOrEqual(0.5);
        expect(casualVsLv3).toBeGreaterThanOrEqual(0.5);

        // Generate 2 balanced 16-ply fighting positions via Casual self-play (seeds 1*97 and 4*97)
        const makeFightingOpening = (seed: number): Array<[number, number]> => {
          const eng = createOmok15Engine(3);
          const rng = createDeterministicRng(seed);
          const seq: Array<[number, number]> = [];
          for (let i = 0; i < 16 && eng.phase === 'playing'; i++) {
            const mv = selectCasualOmokMove(eng, rng)!;
            eng.playMove(mv.x, mv.y);
            seq.push([mv.x, mv.y]);
          }
          return seq;
        };
        const fightingOpenings = [makeFightingOpening(97), makeFightingOpening(388)];

        const runCasualVsCompetitive = (diff: AIDifficulty): { casualWinRate: number; aiWinRate: number } => {
          let casualWins = 0;
          let aiWins = 0;
          const rng = createDeterministicRng(800 + diff);
          const aiPolicy = makeOmokAiPolicy(ai, diff);
          for (let g = 0; g < fightingOpenings.length; g++) {
            const aiAsBlack = g % 2 === 1;
            const casualPolicy = (e: GomokuEngine) => selectCasualOmokMove(e, rng);
            const winner = aiAsBlack
              ? playOmok15Match(aiPolicy, casualPolicy, fightingOpenings[g], 30)
              : playOmok15Match(casualPolicy, aiPolicy, fightingOpenings[g], 30);
            const aiCol = aiAsBlack ? BLACK : WHITE;
            if (winner === aiCol) aiWins++;
            else if (winner !== 'draw') casualWins++;
          }
          return {
            casualWinRate: casualWins / fightingOpenings.length,
            aiWinRate: aiWins / fightingOpenings.length,
          };
        };

        const resLv4 = runCasualVsCompetitive(4);
        const resLv5 = runCasualVsCompetitive(5);

        expect(resLv4.casualWinRate).toBeLessThan(0.5);
        expect(resLv4.aiWinRate).toBeGreaterThan(0.5);
        expect(resLv5.casualWinRate).toBeLessThan(0.5);
        expect(resLv5.aiWinRate).toBeGreaterThan(0.5);
        console.info(
          `[Omok Casual Winrates] vsLv1=${(casualVsLv1 * 100).toFixed(1)}%, vsLv2=${(casualVsLv2 * 100).toFixed(1)}%, vsLv3=${(casualVsLv3 * 100).toFixed(1)}%, vsLv4=${(resLv4.casualWinRate * 100).toFixed(1)}% (AI ${(resLv4.aiWinRate * 100).toFixed(1)}%), vsLv5=${(resLv5.casualWinRate * 100).toFixed(1)}% (AI ${(resLv5.aiWinRate * 100).toFixed(1)}%)`
        );
      });
    },
    90_000
  );
});
