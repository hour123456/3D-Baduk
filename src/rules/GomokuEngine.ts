import {
  BLACK,
  BoardSize,
  Coord,
  EMPTY,
  GameConfig,
  GamePhase,
  GameResult,
  IllegalMoveReason,
  MoveRecord,
  MoveValidation,
  OmokRulesetType,
  opponentColor,
  PlayerColor,
  StoneColor,
  WHITE,
} from './types';
import { computeBoardHash, stoneZobristKey } from './zobrist';

const AXES: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

export interface LineCheckResult {
  won: boolean;
  exactFive: boolean;
  overline: boolean;
  winningLine: Coord[];
}

function inBounds(size: number, x: number, y: number): boolean {
  return x >= 0 && x < size && y >= 0 && y < size;
}

/**
 * Counts contiguous stones of `color` along one axis (dx, dy) passing through (x, y).
 * Assumes board[y * size + x] is already `color` (or treated as `color`).
 */
export function collectContiguousLine(
  board: Uint8Array,
  size: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: PlayerColor
): Coord[] {
  const before: Coord[] = [];
  let cx = x - dx;
  let cy = y - dy;
  while (inBounds(size, cx, cy) && board[cy * size + cx] === color) {
    before.push({ x: cx, y: cy });
    cx -= dx;
    cy -= dy;
  }
  before.reverse();

  const after: Coord[] = [];
  cx = x + dx;
  cy = y + dy;
  while (inBounds(size, cx, cy) && board[cy * size + cx] === color) {
    after.push({ x: cx, y: cy });
    cx += dx;
    cy += dy;
  }

  return [...before, { x, y }, ...after];
}

export function checkWinAt(
  board: Uint8Array,
  size: number,
  x: number,
  y: number,
  color: PlayerColor,
  ruleset: OmokRulesetType
): LineCheckResult {
  const idx = y * size + x;
  const prev = board[idx];
  board[idx] = color;

  let winningLine: Coord[] = [];
  let exactFive = false;
  let overline = false;

  try {
    for (const [dx, dy] of AXES) {
      const line = collectContiguousLine(board, size, x, y, dx, dy, color);
      if (line.length === 5) {
        exactFive = true;
        winningLine = line;
        break;
      }
      if (line.length >= 6) {
        overline = true;
        if (color === WHITE || ruleset === 'freestyle') {
          winningLine = line.slice(0, 5);
          break;
        }
      }
    }
  } finally {
    board[idx] = prev;
  }

  const won =
    exactFive || (overline && (color === WHITE || ruleset === 'freestyle'));

  return { won, exactFive, overline, winningLine };
}

/**
 * Returns offsets k in [-4..+4] (excluding 0) along (dx, dy) from (x, y)
 * where the cell is EMPTY and placing BLACK there makes an exact 5-in-a-row on axis (dx, dy).
 */
function findExactFiveOffsetsOnAxis(
  board: Uint8Array,
  size: number,
  x: number,
  y: number,
  dx: number,
  dy: number
): number[] {
  const offsets: number[] = [];
  for (let k = -4; k <= 4; k++) {
    if (k === 0) continue;
    const tx = x + dx * k;
    const ty = y + dy * k;
    if (!inBounds(size, tx, ty)) continue;
    const tIdx = ty * size + tx;
    if (board[tIdx] !== EMPTY) continue;

    board[tIdx] = BLACK;
    const line = collectContiguousLine(board, size, tx, ty, dx, dy, BLACK);
    board[tIdx] = EMPTY;

    if (line.length === 5) {
      offsets.push(k);
    }
  }
  return offsets;
}

/**
 * Counts how many distinct Four threats exist on axis (dx, dy) assuming board[y*size+x] === BLACK.
 * Also reports whether this axis holds a Straight Open Four (two exact-5 extensions flanking a contiguous 4).
 */
function inspectFoursOnAxis(
  board: Uint8Array,
  size: number,
  x: number,
  y: number,
  dx: number,
  dy: number
): { fourCount: number; isStraightOpenFour: boolean } {
  const offsets = findExactFiveOffsetsOnAxis(board, size, x, y, dx, dy);
  if (offsets.length === 0) {
    return { fourCount: 0, isStraightOpenFour: false };
  }
  if (offsets.length === 1) {
    return { fourCount: 1, isStraightOpenFour: false };
  }

  // Two exact-5 completions on the same axis:
  // If they cap a contiguous 4-stone run (e2 - e1 === 5 and all 4 cells between are BLACK),
  // they form a single Open Four (활사). Otherwise it is Double Four on one axis.
  if (offsets.length === 2 && offsets[1] - offsets[0] === 5) {
    let allBlackBetween = true;
    for (let k = offsets[0] + 1; k < offsets[1]; k++) {
      const cx = x + dx * k;
      const cy = y + dy * k;
      if (!inBounds(size, cx, cy) || board[cy * size + cx] !== BLACK) {
        allBlackBetween = false;
        break;
      }
    }
    if (allBlackBetween) {
      return { fourCount: 1, isStraightOpenFour: true };
    }
  }

  return { fourCount: 2, isStraightOpenFour: false };
}

/**
 * Evaluates whether empty cell (x, y) is a Renju forbidden move for BLACK.
 * Exact 5 overrides all forbidden conditions per RIF Renju rules.
 */
export function checkRenjuForbidden(
  board: Uint8Array,
  size: number,
  x: number,
  y: number,
  depth = 0
): { forbidden: boolean; reason?: Extract<IllegalMoveReason, 'OVERLINE' | 'DOUBLE_FOUR' | 'DOUBLE_THREE'> } {
  if (depth > 8) return { forbidden: false };
  const idx = y * size + x;
  if (board[idx] !== EMPTY) return { forbidden: false };

  board[idx] = BLACK;
  try {
    let hasExactFive = false;
    let hasOverline = false;

    for (const [dx, dy] of AXES) {
      const len = collectContiguousLine(board, size, x, y, dx, dy, BLACK).length;
      if (len === 5) {
        hasExactFive = true;
        break;
      }
      if (len >= 6) {
        hasOverline = true;
      }
    }

    if (hasExactFive) {
      return { forbidden: false };
    }
    if (hasOverline) {
      return { forbidden: true, reason: 'OVERLINE' };
    }

    // Count Fours across all 4 axes
    let totalFours = 0;
    for (const [dx, dy] of AXES) {
      const { fourCount } = inspectFoursOnAxis(board, size, x, y, dx, dy);
      totalFours += fourCount;
      if (totalFours >= 2) {
        return { forbidden: true, reason: 'DOUBLE_FOUR' };
      }
    }

    // Count true Open Threes (활삼) across all 4 axes (with recursive legality check)
    let openThrees = 0;
    for (const [dx, dy] of AXES) {
      let axisHasOpenThree = false;
      for (let k = -3; k <= 3; k++) {
        if (k === 0) continue;
        const tx = x + dx * k;
        const ty = y + dy * k;
        if (!inBounds(size, tx, ty)) continue;
        const tIdx = ty * size + tx;
        if (board[tIdx] !== EMPTY) continue;

        // First confirm placing BLACK at (tx, ty) makes a Straight Open Four on this axis
        board[tIdx] = BLACK;
        const { isStraightOpenFour } = inspectFoursOnAxis(board, size, tx, ty, dx, dy);
        board[tIdx] = EMPTY;

        if (!isStraightOpenFour) continue;

        // Then verify (tx, ty) is NOT itself forbidden for Black (False-Three exception)
        const rec = checkRenjuForbidden(board, size, tx, ty, depth + 1);
        if (!rec.forbidden) {
          axisHasOpenThree = true;
          break;
        }
      }

      if (axisHasOpenThree) {
        openThrees += 1;
        if (openThrees >= 2) {
          return { forbidden: true, reason: 'DOUBLE_THREE' };
        }
      }
    }

    return { forbidden: false };
  } finally {
    board[idx] = EMPTY;
  }
}

export class GomokuEngine {
  public config: GameConfig;
  public size: BoardSize;
  public board: Uint8Array;
  public currentTurn: PlayerColor = BLACK;
  public phase: GamePhase = 'playing';
  public koPoint: Coord | null = null;
  public captures = { black: 0, white: 0 };
  public consecutivePasses = 0;
  public history: MoveRecord[] = [];
  public initialBoard: Uint8Array;
  public initialHash: bigint = 0n;
  public currentHash: bigint = 0n;
  public result: GameResult | null = null;
  private forbiddenPointsCache: Coord[] = [];

  constructor(config: GameConfig) {
    this.config = {
      ...config,
      gameType: 'omok',
      omokRuleset: config.omokRuleset ?? 'renju',
    };
    this.size = this.normalizeSize(config.boardSize);
    this.board = new Uint8Array(this.size * this.size);
    this.initialBoard = new Uint8Array(this.size * this.size);
    this.reset(this.config);
  }

  private normalizeSize(size: BoardSize): BoardSize {
    return size === 19 || size === 15 ? size : 15;
  }

  public getOmokRuleset(): OmokRulesetType {
    return this.config.omokRuleset ?? 'renju';
  }

  public reset(newConfig?: Partial<GameConfig>): void {
    if (newConfig) {
      this.config = {
        ...this.config,
        ...newConfig,
        gameType: 'omok',
        omokRuleset: newConfig.omokRuleset ?? this.config.omokRuleset ?? 'renju',
      };
    }
    this.size = this.normalizeSize(this.config.boardSize);
    this.board = new Uint8Array(this.size * this.size);
    this.initialBoard = new Uint8Array(this.size * this.size);
    this.currentTurn = BLACK;
    this.phase = 'playing';
    this.koPoint = null;
    this.captures = { black: 0, white: 0 };
    this.consecutivePasses = 0;
    this.history = [];
    this.result = null;
    this.initialHash = computeBoardHash(this.board, this.size);
    this.currentHash = this.initialHash;
    this.recomputeForbiddenPoints();
  }

  public getStone(x: number, y: number): StoneColor {
    if (x < 0 || x >= this.size || y < 0 || y >= this.size) return EMPTY;
    return this.board[y * this.size + x] as StoneColor;
  }

  public getForbiddenPoints(): Coord[] {
    if (this.phase !== 'playing' || this.getOmokRuleset() !== 'renju') {
      return [];
    }
    return this.forbiddenPointsCache;
  }

  private recomputeForbiddenPoints(): void {
    if (this.phase !== 'playing' || this.getOmokRuleset() !== 'renju') {
      this.forbiddenPointsCache = [];
      return;
    }
    const scratch = new Uint8Array(this.board);
    const list: Coord[] = [];
    const n = this.size;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (scratch[y * n + x] !== EMPTY) continue;
        // Quick pruning: a forbidden point (3-3, 4-4, overline) requires at least 2 adjacent/near-2 Black stones
        let nearBlack = 0;
        for (const [dx, dy] of AXES) {
          for (const sign of [-1, 1]) {
            for (let step = 1; step <= 2; step++) {
              const nx = x + dx * sign * step;
              const ny = y + dy * sign * step;
              if (inBounds(n, nx, ny) && scratch[ny * n + nx] === BLACK) {
                nearBlack++;
                break;
              }
            }
          }
        }
        if (nearBlack < 2) continue;

        if (checkRenjuForbidden(scratch, n, x, y).forbidden) {
          list.push({ x, y });
        }
      }
    }
    this.forbiddenPointsCache = list;
  }

  public validateMove(x: number, y: number, color: PlayerColor = this.currentTurn): MoveValidation {
    if (this.phase !== 'playing') {
      return { valid: false, reason: 'GAME_NOT_ACTIVE' };
    }
    if (x < 0 || x >= this.size || y < 0 || y >= this.size) {
      return { valid: false, reason: 'OUT_OF_BOUNDS' };
    }

    const idx = y * this.size + x;
    if (this.board[idx] !== EMPTY) {
      return { valid: false, reason: 'OCCUPIED' };
    }

    if (color === BLACK && this.getOmokRuleset() === 'renju') {
      const check = checkRenjuForbidden(new Uint8Array(this.board), this.size, x, y);
      if (check.forbidden && check.reason) {
        return { valid: false, reason: check.reason };
      }
    }

    let adjacentOpponentCount = 0;
    let adjacentTotalCount = 0;
    const opp = opponentColor(color);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(this.size, nx, ny)) continue;
        const c = this.board[ny * this.size + nx];
        if (c !== EMPTY) {
          adjacentTotalCount++;
          if (c === opp) adjacentOpponentCount++;
        }
      }
    }

    const nextBoard = new Uint8Array(this.board);
    nextBoard[idx] = color;
    const nextHash = this.currentHash ^ stoneZobristKey(idx, color);

    return {
      valid: true,
      capturedCoords: [],
      resultingBoard: nextBoard,
      resultingHash: nextHash,
      nextKoPoint: null,
      adjacentOpponentCount,
      adjacentTotalCount,
    };
  }

  public playMove(x: number, y: number): MoveValidation & { record?: MoveRecord } {
    const check = this.validateMove(x, y, this.currentTurn);
    if (!check.valid || !check.resultingBoard || check.resultingHash === undefined) {
      return check;
    }

    const color = this.currentTurn;
    const boardBefore = new Uint8Array(this.board);
    this.board = check.resultingBoard;
    this.currentHash = check.resultingHash;
    this.consecutivePasses = 0;

    const record: MoveRecord = {
      moveNumber: this.history.length + 1,
      color,
      coord: { x, y },
      captured: [],
      koPointAfter: null,
      boardBefore,
      boardAfter: new Uint8Array(this.board),
      capturesAfter: { ...this.captures },
      hashAfter: this.currentHash,
      consecutivePasses: 0,
      timestamp: Date.now(),
    };

    this.history.push(record);

    const winInfo = checkWinAt(this.board, this.size, x, y, color, this.getOmokRuleset());
    if (winInfo.won) {
      this.phase = 'finished';
      const winnerLabel = color === BLACK ? '흑' : '백';
      this.result = {
        winner: color,
        reason: 'five_in_row',
        winningLine: winInfo.winningLine,
        summaryText: `${winnerLabel} 오목 승 (${winInfo.winningLine.length}목 완성)`,
      };
      this.forbiddenPointsCache = [];
    } else if (this.isBoardFull()) {
      this.phase = 'finished';
      this.result = {
        winner: 'draw',
        reason: 'draw',
        summaryText: '무승부 (만판)',
      };
      this.forbiddenPointsCache = [];
    } else {
      this.currentTurn = opponentColor(color);
      this.recomputeForbiddenPoints();
    }

    return { ...check, record };
  }

  private isBoardFull(): boolean {
    const total = this.size * this.size;
    for (let i = 0; i < total; i++) {
      if (this.board[i] === EMPTY) return false;
    }
    return true;
  }

  public pass(): MoveRecord | null {
    if (this.phase !== 'playing') return null;
    const color = this.currentTurn;
    const boardBefore = new Uint8Array(this.board);
    this.consecutivePasses += 1;

    const record: MoveRecord = {
      moveNumber: this.history.length + 1,
      color,
      coord: null,
      captured: [],
      koPointAfter: null,
      boardBefore,
      boardAfter: new Uint8Array(this.board),
      capturesAfter: { ...this.captures },
      hashAfter: this.currentHash,
      consecutivePasses: this.consecutivePasses,
      timestamp: Date.now(),
    };

    this.history.push(record);
    this.currentTurn = opponentColor(color);
    if (this.consecutivePasses >= 2) {
      this.phase = 'finished';
      this.result = {
        winner: 'draw',
        reason: 'draw',
        summaryText: '합의 무승부',
      };
      this.forbiddenPointsCache = [];
    }
    return record;
  }

  public resign(resigningColor: PlayerColor): GameResult {
    const winner = opponentColor(resigningColor);
    const winnerLabel = winner === BLACK ? '흑' : '백';
    this.phase = 'finished';
    this.result = {
      winner,
      reason: 'resign',
      summaryText: `${winnerLabel} 기권승`,
    };
    this.forbiddenPointsCache = [];
    return this.result;
  }

  public timeout(timedOutColor: PlayerColor): GameResult {
    const winner = opponentColor(timedOutColor);
    const winnerLabel = winner === BLACK ? '흑' : '백';
    this.phase = 'finished';
    this.result = {
      winner,
      reason: 'timeout',
      summaryText: `${winnerLabel} 시간승`,
    };
    this.forbiddenPointsCache = [];
    return this.result;
  }

  public undo(steps = 1): boolean {
    if (this.history.length === 0 || steps <= 0) return false;
    const actualSteps = Math.min(steps, this.history.length);
    const targetLen = this.history.length - actualSteps;
    this.history = this.history.slice(0, targetLen);
    this.result = null;
    this.phase = 'playing';

    if (this.history.length === 0) {
      this.board = new Uint8Array(this.initialBoard);
      this.currentHash = this.initialHash;
      this.consecutivePasses = 0;
      this.currentTurn = BLACK;
    } else {
      const last = this.history[this.history.length - 1];
      this.board = new Uint8Array(last.boardAfter);
      this.currentHash = last.hashAfter;
      this.consecutivePasses = last.consecutivePasses;
      this.currentTurn = opponentColor(last.color);
    }
    this.recomputeForbiddenPoints();
    return true;
  }

  public getSnapshotAtMove(moveNumber: number): {
    board: Uint8Array;
    captures: { black: number; white: number };
    lastMove: MoveRecord | null;
    nextTurn: PlayerColor;
  } {
    if (moveNumber <= 0 || this.history.length === 0) {
      return {
        board: new Uint8Array(this.initialBoard),
        captures: { black: 0, white: 0 },
        lastMove: null,
        nextTurn: BLACK,
      };
    }
    const clamped = Math.min(moveNumber, this.history.length);
    const rec = this.history[clamped - 1];
    return {
      board: new Uint8Array(rec.boardAfter),
      captures: { ...rec.capturesAfter },
      lastMove: rec,
      nextTurn: opponentColor(rec.color),
    };
  }

  public getIllegalReasonKorean(reason?: string): string {
    switch (reason) {
      case 'OCCUPIED':
        return '이미 돌이 놓여 있는 자리입니다.';
      case 'DOUBLE_THREE':
        return '렌주룰 흑 금수(삼삼 · 3·3) 자리에는 착수할 수 없습니다.';
      case 'DOUBLE_FOUR':
        return '렌주룰 흑 금수(사사 · 4·4) 자리에는 착수할 수 없습니다.';
      case 'OVERLINE':
        return '렌주룰 흑 금수(장목 · 6목 이상) 자리에는 착수할 수 없습니다.';
      default:
        return '착수할 수 없는 자리입니다.';
    }
  }
}
