import { describe, it, expect } from 'vitest';
import { GomokuEngine } from '../GomokuEngine';
import { BLACK, WHITE, EMPTY, GameConfig } from '../types';
import { exportToSgf, parseSgf } from '../sgf';

function makeOmokConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    boardSize: 15,
    ruleset: 'korean',
    gameType: 'omok',
    omokRuleset: 'renju',
    handicap: 0,
    komi: 0,
    superko: false,
    mode: 'local2p',
    humanColor: BLACK,
    aiDifficulty: 3,
    mainTimeSeconds: 0,
    byoyomiSeconds: 0,
    byoyomiPeriods: 0,
    blackName: '흑테스트',
    whiteName: '백테스트',
    ...overrides,
  };
}

describe('GomokuEngine & Renju Rules', () => {
  it('detects horizontal, vertical, and diagonal 5-in-a-row wins cleanly', () => {
    // 1) Horizontal
    const hGame = new GomokuEngine(makeOmokConfig());
    for (let i = 0; i < 4; i++) {
      expect(hGame.playMove(3 + i, 7).valid).toBe(true); // B
      expect(hGame.playMove(3 + i, 9).valid).toBe(true); // W
    }
    const hWin = hGame.playMove(7, 7); // B 5th stone in row 7
    expect(hWin.valid).toBe(true);
    expect(hGame.phase).toBe('finished');
    expect(hGame.result?.winner).toBe(BLACK);
    expect(hGame.result?.reason).toBe('five_in_row');
    expect(hGame.result?.winningLine?.length).toBe(5);

    // 2) Diagonal (bottom-left to top-right / down-right)
    const dGame = new GomokuEngine(makeOmokConfig({ omokRuleset: 'freestyle' }));
    for (let i = 0; i < 4; i++) {
      expect(dGame.playMove(2 + i, 2 + i).valid).toBe(true); // B
      expect(dGame.playMove(10, 2 + i).valid).toBe(true); // W
    }
    dGame.playMove(6, 6); // B completes diagonal 5
    expect(dGame.phase).toBe('finished');
    expect(dGame.result?.winner).toBe(BLACK);
    expect(dGame.result?.winningLine?.length).toBe(5);
  });

  it('enforces Renju OVERLINE (6+) restriction for Black while allowing White & Freestyle 6+', () => {
    const renju = new GomokuEngine(makeOmokConfig({ omokRuleset: 'renju' }));
    const blackStones = [
      [3, 7],
      [4, 7],
      [5, 7],
      [7, 7],
      [8, 7],
    ];
    blackStones.forEach(([bx, by], idx) => {
      expect(renju.playMove(bx, by).valid).toBe(true);
      expect(renju.playMove((idx * 2) % 14, 14).valid).toBe(true); // Spaced White filler (never connects 5)
    });

    // Black playing (6, 7) forms 6 in a row -> OVERLINE forbidden
    const overlineAttempt = renju.playMove(6, 7);
    expect(overlineAttempt.valid).toBe(false);
    expect(overlineAttempt.reason).toBe('OVERLINE');
    expect(renju.getStone(6, 7)).toBe(EMPTY);
    expect(renju.phase).toBe('playing');

    // White forming 6 in a row under Renju rules IS legal and wins
    const whiteWin = new GomokuEngine(makeOmokConfig({ omokRuleset: 'renju' }));
    const wCoords = [
      [3, 5],
      [4, 5],
      [5, 5],
      [7, 5],
      [8, 5],
    ];
    wCoords.forEach(([wx, wy], idx) => {
      expect(whiteWin.playMove((idx * 2) % 14, 13).valid).toBe(true); // Spaced B filler
      expect(whiteWin.playMove(wx, wy).valid).toBe(true); // W
    });
    expect(whiteWin.playMove(14, 14).valid).toBe(true); // B
    const wOverlineWin = whiteWin.playMove(6, 5); // W plays 6 in a row -> WIN
    expect(wOverlineWin.valid).toBe(true);
    expect(whiteWin.phase).toBe('finished');
    expect(whiteWin.result?.winner).toBe(WHITE);

    // Freestyle Black 6+ wins cleanly
    const freestyle = new GomokuEngine(makeOmokConfig({ omokRuleset: 'freestyle' }));
    blackStones.forEach(([bx, by], idx) => {
      expect(freestyle.playMove(bx, by).valid).toBe(true);
      expect(freestyle.playMove((idx * 2) % 14, 14).valid).toBe(true);
    });
    expect(freestyle.playMove(6, 7).valid).toBe(true);
    expect(freestyle.phase).toBe('finished');
    expect(freestyle.result?.winner).toBe(BLACK);
  });

  it('prohibits Black DOUBLE_FOUR (both cross-axis and single-axis split 4-4) under Renju', () => {
    // 1) Cross-axis 4-4 at (7, 7)
    const cross44 = new GomokuEngine(makeOmokConfig({ omokRuleset: 'renju' }));
    const setupCross = [
      [4, 7],
      [5, 7],
      [6, 7],
      [7, 4],
      [7, 5],
      [7, 6],
    ];
    setupCross.forEach(([x, y], idx) => {
      expect(cross44.playMove(x, y).valid).toBe(true);
      expect(cross44.playMove((idx * 2) % 14, 0).valid).toBe(true);
    });
    const resCross = cross44.playMove(7, 7);
    expect(resCross.valid).toBe(false);
    expect(resCross.reason).toBe('DOUBLE_FOUR');

    // 2) Single-axis split 4-4 on row y=7: B at (3,4,5) and (9,10,11) -> (7,7) creates two separate 4s
    const split44 = new GomokuEngine(makeOmokConfig({ omokRuleset: 'renju' }));
    [3, 4, 5, 9, 10, 11].forEach((bx, idx) => {
      expect(split44.playMove(bx, 7).valid).toBe(true);
      expect(split44.playMove((idx * 2) % 14, 0).valid).toBe(true);
    });
    const resSplit = split44.playMove(7, 7);
    expect(resSplit.valid).toBe(false);
    expect(resSplit.reason).toBe('DOUBLE_FOUR');
  });

  it('prohibits Black DOUBLE_THREE (3-3) under Renju and exposes persistent forbidden coords', () => {
    const engine = new GomokuEngine(makeOmokConfig({ omokRuleset: 'renju' }));
    const moves = [
      [5, 7],
      [6, 7],
      [7, 5],
      [7, 6],
    ];
    moves.forEach(([x, y], idx) => {
      expect(engine.playMove(x, y).valid).toBe(true);
      expect(engine.playMove(idx, 0).valid).toBe(true);
    });

    const forbidden = engine.getForbiddenPoints();
    expect(forbidden.some((pt) => pt.x === 7 && pt.y === 7)).toBe(true);

    const attempt = engine.playMove(7, 7);
    expect(attempt.valid).toBe(false);
    expect(attempt.reason).toBe('DOUBLE_THREE');

    // Freestyle allows the same 3-3 point
    const free = new GomokuEngine(makeOmokConfig({ omokRuleset: 'freestyle' }));
    moves.forEach(([x, y], idx) => {
      free.playMove(x, y);
      free.playMove(idx, 0);
    });
    expect(free.getForbiddenPoints().length).toBe(0);
    expect(free.playMove(7, 7).valid).toBe(true);
  });

  it('prioritizes Exact-5 win over simultaneous 4-4 / 3-3 conditions under Renju', () => {
    const engine = new GomokuEngine(makeOmokConfig({ omokRuleset: 'renju' }));
    // Row 7 already has 4 stones with gap at (7,7): (4,7),(5,7),(6,7),(8,7)
    // Col 7 has (7,4),(7,5),(7,6) and Diag(1,1) has (8,8),(9,9),(10,10) -> (7,7) would be 4-4 without row Exact-5!
    const blackCoords = [
      [4, 7],
      [5, 7],
      [6, 7],
      [8, 7],
      [7, 4],
      [7, 5],
      [7, 6],
      [8, 8],
      [9, 9],
      [10, 10],
    ];
    blackCoords.forEach(([bx, by], idx) => {
      expect(engine.playMove(bx, by).valid).toBe(true);
      const fy = idx >= 7 ? 13 : 14;
      expect(engine.playMove((idx * 2) % 14, fy).valid).toBe(true);
    });

    const exactFiveWin = engine.playMove(7, 7);
    expect(exactFiveWin.valid).toBe(true);
    expect(engine.phase).toBe('finished');
    expect(engine.result?.winner).toBe(BLACK);
    expect(engine.result?.reason).toBe('five_in_row');
  });

  it('supports undo (including undoing winning move) and SGF round-trip for Omok', () => {
    const engine = new GomokuEngine(makeOmokConfig({ boardSize: 15, omokRuleset: 'renju' }));
    for (let i = 0; i < 4; i++) {
      engine.playMove(4 + i, 7);
      engine.playMove(4 + i, 8);
    }
    engine.playMove(8, 7); // Winning 5th move
    expect(engine.phase).toBe('finished');

    // Undo winning move restores playing phase cleanly
    expect(engine.undo(1)).toBe(true);
    expect(engine.phase).toBe('playing');
    expect(engine.result).toBeNull();
    expect(engine.getStone(8, 7)).toBe(EMPTY);
    expect(engine.currentTurn).toBe(BLACK);

    // Replay winning move and round-trip SGF
    engine.playMove(8, 7);
    const sgf = exportToSgf(engine);
    expect(sgf).toContain('GM[4]');
    expect(sgf).toContain('SZ[15]');
    expect(sgf).toContain('RU[Renju]');

    const parsed = parseSgf(sgf);
    expect(parsed.gameType).toBe('omok');
    expect(parsed.boardSize).toBe(15);
    expect(parsed.omokRuleset).toBe('renju');
    expect(parsed.moves.length).toBe(9);
  });
});
