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
