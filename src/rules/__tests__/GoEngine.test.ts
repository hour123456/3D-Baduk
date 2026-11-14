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

    // Corner capture at (0,0): White stone at (0,0), Black surrounds (1,0) and (0,1)
    engine.playMove(1, 0); // B
    engine.playMove(0, 0); // W
    const res = engine.playMove(0, 1); // B captures (0,0)

    expect(res.valid).toBe(true);
    expect(res.capturedCoords).toEqual([{ x: 0, y: 0 }]);
    expect(engine.getStone(0, 0)).toBe(EMPTY);
    expect(engine.captures.black).toBe(1);
  });

  it('strictly prohibits suicide while allowing capture-first moves into zero-liberty spots', () => {
    const engine = new GoEngine(createConfig({ boardSize: 9 }));

    // Build Black eye at (0,0) surrounded by Black at (1,0) and (0,1)
    engine.playMove(1, 0); // B
    engine.playMove(5, 5); // W tenuki
    engine.playMove(0, 1); // B

    // White tries to play inside Black's eye at (0,0) when Black stones have outside liberties -> SUICIDE!
    const suicideAttempt = engine.playMove(0, 0);
    expect(suicideAttempt.valid).toBe(false);
    expect(suicideAttempt.reason).toBe('SUICIDE');
    expect(engine.getStone(0, 0)).toBe(EMPTY);

    // Now White surrounds Black's two stones at (2,0), (1,1), (0,2) leaving only (0,0) liberty!
    engine.playMove(2, 0); // W
    engine.playMove(8, 8); // B
    engine.playMove(1, 1); // W
    engine.playMove(8, 7); // B
    engine.playMove(0, 2); // W
    engine.playMove(7, 8); // B

    // Now White plays at (0,0): captures both Black stones, freeing liberties -> VALID!
    const captureIntoEye = engine.playMove(0, 0);
    expect(captureIntoEye.valid).toBe(true);
    expect(captureIntoEye.capturedCoords?.length).toBe(2);
    expect(engine.getStone(1, 0)).toBe(EMPTY);
    expect(engine.getStone(0, 1)).toBe(EMPTY);
    expect(engine.getStone(0, 0)).toBe(WHITE);
  });

  it('enforces Simple Ko prohibition and allows recapture after a Ko threat', () => {
    // Classic Ko shape:
    //   . B W .   y=0: B(1,0), W(2,0)
    //   B W . W   y=1: B(0,1), W(1,1), empty(2,1), W(3,1)
    //   . B W .   y=2: B(1,2), W(2,2)
    // When Black plays at (2,1), Black captures W(1,1). Then W cannot immediately play (1,1)!
    const engine = new GoEngine(createConfig({ boardSize: 9 }));

    engine.playMove(1, 0); // B
    engine.playMove(2, 0); // W
    engine.playMove(0, 1); // B
    engine.playMove(1, 1); // W
    engine.playMove(1, 2); // B
    engine.playMove(2, 2); // W
    engine.playMove(8, 8); // B filler
    engine.playMove(3, 1); // W

    // Black captures the Ko at (2,1), capturing W(1,1)
    const koCapture = engine.playMove(2, 1);
    expect(koCapture.valid).toBe(true);
    expect(koCapture.capturedCoords).toEqual([{ x: 1, y: 1 }]);
    expect(engine.koPoint).toEqual({ x: 1, y: 1 });

    // White tries to immediately recapture at (1,1) -> BLOCKED BY KO!
    const illegalRecapture = engine.playMove(1, 1);
    expect(illegalRecapture.valid).toBe(false);
    expect(illegalRecapture.reason).toBe('KO');

    // White plays a Ko threat elsewhere (6,6), Black answers (6,7)
    expect(engine.playMove(6, 6).valid).toBe(true);
    expect(engine.playMove(6, 7).valid).toBe(true);

    // Now White can legally recapture the Ko at (1,1)!
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
    // 9x9 divided vertically:
    // Black wall on column x=3 (y=0..8 -> 9 stones), empty territory x=0..2 (3*9 = 27 pts)
    // White wall on column x=5 (y=0..8 -> 9 stones), empty territory x=6..8 (3*9 = 27 pts)
    // Column x=4 is neutral dame (9 pts)!
    // Plus place 1 dead White stone inside Black's territory at (1,1) -> 26 empty + 1 dead White = 27 territory + 1 prisoner!
    const engine = new GoEngine(createConfig({ boardSize: 9, ruleset: 'korean', komi: 6.5 }));

    for (let y = 0; y < 9; y++) {
      engine.playMove(3, y); // B wall
      engine.playMove(5, y); // W wall
    }
    // Black plays inside own wall? No, let Black pass, White drops an invaded stone at (1,1) that dies, then two passes
    engine.pass(); // B pass (1)
    engine.playMove(1, 1); // W invades at (1,1)
    engine.pass(); // B pass (1)
    engine.pass(); // W pass (2) -> scoring!

    expect(engine.phase).toBe('scoring');

    let deadMask: Uint8Array = new Uint8Array(81);
    deadMask = toggleDeadChainAt(engine.board, 9, deadMask, 1, 1);
    expect(deadMask[1 * 9 + 1]).toBe(1);

    // Korean rules:
    // Black territory = 27 (since dead W(1,1) removed leaves all 3x9 = 27 empty points surrounded by Black)
    // Black captures = 0 during play + 1 dead White stone = 1 -> Black total = 28
    // White territory = 27, captures = 0, komi = 6.5 -> White total = 33.5
    // Neutral dame on column x=4 = 9
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

    // Chinese rules on the same board:
    // Black alive stones = 9, Black territory = 27 -> Black total = 36
    // White alive stones = 9 (since W(1,1) is dead!), White territory = 27, komi = 7.5 -> White total = 43.5
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
