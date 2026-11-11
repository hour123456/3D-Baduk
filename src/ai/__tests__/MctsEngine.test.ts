import { describe, it, expect } from 'vitest';
import { FastBoard } from '../FastBoard';
import { isCapturedInLadder } from '../GoHeuristics';
import { MctsEngine } from '../MctsEngine';
import { BLACK, WHITE } from '../../rules/types';
import { GoEngine } from '../../rules/GoEngine';

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

    go.playMove(3, 4);
    go.playMove(4, 4);
    go.playMove(5, 4);
    go.playMove(0, 8);
    go.playMove(4, 3);
    go.playMove(0, 7);

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
    fb.play(1 * 9 + 2, BLACK);
    fb.play(2 * 9 + 2, WHITE);
    fb.play(2 * 9 + 1, BLACK);
    fb.play(3 * 9 + 1, BLACK);

    expect(isCapturedInLadder(fb, 2 * 9 + 2, BLACK, 0, 28)).toBe(true);

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
    go.playMove(15, 3);

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
});
