import { describe, it, expect } from 'vitest';
import { GomokuAI } from '../GomokuAI';
import { GomokuEngine, checkRenjuForbidden } from '../../rules/GomokuEngine';
import { AIDifficulty, BLACK, EMPTY, WHITE } from '../../rules/types';

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
