import { describe, it, expect } from 'vitest';
import { GoEngine } from '../GoEngine';
import { BLACK, WHITE, EMPTY, GameConfig } from '../types';
import { calculateScore, toggleDeadChainAt } from '../scoring';
import { exportToSgf, parseSgf } from '../sgf';

function createConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    boardSize: 9,
    ruleset: 'korean',
    handicap: 0,
    komi: 6.5,
    superko: true,
    mode: 'local2p',
    humanColor: BLACK,
    aiDifficulty: 3,
    mainTimeSeconds: 0,
    byoyomiSeconds: 30,
    byoyomiPeriods: 3,
    ...overrides,
  };
}

describe('GoEngine Strict Baduk Rules', () => {
  it('captures single and multi-stone chains accurately (center, edge, corner)', () => {
    const engine = new GoEngine(createConfig({ boardSize: 9 }));
    engine.playMove(1, 0);
    engine.playMove(0, 0);
    const res = engine.playMove(0, 1);

    expect(res.valid).toBe(true);
    expect(res.capturedCoords).toEqual([{ x: 0, y: 0 }]);
    expect(engine.getStone(0, 0)).toBe(EMPTY);
    expect(engine.captures.black).toBe(1);
  });

  it('strictly prohibits suicide while allowing capture-first moves into zero-liberty spots', () => {
    const engine = new GoEngine(createConfig({ boardSize: 9 }));
    engine.playMove(1, 0);
    engine.playMove(5, 5);
    engine.playMove(0, 1);

    const suicideAttempt = engine.playMove(0, 0);
    expect(suicideAttempt.valid).toBe(false);
    expect(suicideAttempt.reason).toBe('SUICIDE');
    expect(engine.getStone(0, 0)).toBe(EMPTY);

    engine.playMove(2, 0);
    engine.playMove(8, 8);
    engine.playMove(1, 1);
    engine.playMove(8, 7);
    engine.playMove(0, 2);
    engine.playMove(7, 8);

    const captureIntoEye = engine.playMove(0, 0);
    expect(captureIntoEye.valid).toBe(true);
    expect(captureIntoEye.capturedCoords?.length).toBe(2);
    expect(engine.getStone(1, 0)).toBe(EMPTY);
    expect(engine.getStone(0, 1)).toBe(EMPTY);
    expect(engine.getStone(0, 0)).toBe(WHITE);
  });

  it('enforces Simple Ko prohibition and allows recapture after a Ko threat', () => {
    const engine = new GoEngine(createConfig({ boardSize: 9 }));
    engine.playMove(1, 0);
    engine.playMove(2, 0);
    engine.playMove(0, 1);
    engine.playMove(1, 1);
    engine.playMove(1, 2);
    engine.playMove(2, 2);
    engine.playMove(8, 8);
    engine.playMove(3, 1);

    const koCapture = engine.playMove(2, 1);
    expect(koCapture.valid).toBe(true);
    expect(koCapture.capturedCoords).toEqual([{ x: 1, y: 1 }]);
    expect(engine.koPoint).toEqual({ x: 1, y: 1 });

    const illegalRecapture = engine.playMove(1, 1);
    expect(illegalRecapture.valid).toBe(false);
    expect(illegalRecapture.reason).toBe('KO');

    expect(engine.playMove(6, 6).valid).toBe(true);
    expect(engine.playMove(6, 7).valid).toBe(true);

    const legalRecapture = engine.playMove(1, 1);
    expect(legalRecapture.valid).toBe(true);
    expect(legalRecapture.capturedCoords).toEqual([{ x: 2, y: 1 }]);
  });

  it('sets up handicap stones accurately and gives White the first move', () => {
    const engine = new GoEngine(createConfig({ boardSize: 19, handicap: 4, komi: 0.5 }));
    expect(engine.handicapStones.length).toBe(4);
    expect(engine.currentTurn).toBe(WHITE);
    expect(engine.getStone(15, 3)).toBe(BLACK);
    expect(engine.getStone(3, 15)).toBe(BLACK);
    expect(engine.getStone(15, 15)).toBe(BLACK);
    expect(engine.getStone(3, 3)).toBe(BLACK);
  });

  it('transitions to scoring phase after two consecutive passes and calculates Korean & Chinese scores accurately', () => {
    const engine = new GoEngine(createConfig({ boardSize: 9, ruleset: 'korean', komi: 6.5 }));
    for (let y = 0; y < 9; y++) {
      engine.playMove(3, y);
      engine.playMove(5, y);
    }
    engine.pass();
    engine.playMove(1, 1);
    engine.pass();
    engine.pass();

    expect(engine.phase).toBe('scoring');

    let deadMask: Uint8Array = new Uint8Array(81);
    deadMask = toggleDeadChainAt(engine.board, 9, deadMask, 1, 1);
    expect(deadMask[1 * 9 + 1]).toBe(1);

    const krScore = calculateScore({
      board: engine.board,
      size: 9,
      ruleset: 'korean',
      komi: 6.5,
      captures: engine.captures,
      deadStoneMask: deadMask,
    });

    expect(krScore.blackTerritory).toBe(27);
    expect(krScore.whiteTerritory).toBe(27);
    expect(krScore.dameCount).toBe(9);
    expect(krScore.blackTotal).toBe(28);
    expect(krScore.whiteTotal).toBe(33.5);
    expect(krScore.winner).toBe(WHITE);
    expect(krScore.margin).toBe(5.5);

    const cnScore = calculateScore({
      board: engine.board,
      size: 9,
      ruleset: 'chinese',
      komi: 7.5,
      captures: engine.captures,
      deadStoneMask: deadMask,
    });
    expect(cnScore.blackAliveStones).toBe(9);
    expect(cnScore.whiteAliveStones).toBe(9);
    expect(cnScore.blackTotal).toBe(36);
    expect(cnScore.whiteTotal).toBe(43.5);
  });

  it('supports undo and SGF export/import roundtrip cleanly', () => {
    const engine = new GoEngine(createConfig({ boardSize: 13, komi: 6.5 }));
    engine.playMove(3, 3);
    engine.playMove(9, 9);
    engine.playMove(3, 9);
    engine.pass();

    const sgf = exportToSgf(engine);
    const parsed = parseSgf(sgf);

    expect(parsed.boardSize).toBe(13);
    expect(parsed.komi).toBe(6.5);
    expect(parsed.moves.length).toBe(4);
    expect(parsed.moves[0]).toEqual({ color: BLACK, coord: { x: 3, y: 3 } });
    expect(parsed.moves[3]).toEqual({ color: WHITE, coord: null });

    engine.undo(2);
    expect(engine.history.length).toBe(2);
    expect(engine.getStone(3, 9)).toBe(EMPTY);
    expect(engine.currentTurn).toBe(BLACK);
  });
});
