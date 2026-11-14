import {
  BLACK,
  WHITE,
  EMPTY,
  BoardSize,
  Coord,
  GameConfig,
  GamePhase,
  GameResult,
  MoveRecord,
  MoveValidation,
  PlayerColor,
  StoneColor,
  opponentColor,
} from './types';
import { computeBoardHash, stoneZobristKey } from './zobrist';

const GO_LETTERS = 'ABCDEFGHJKLMNOPQRST';

export function coordToLabel(x: number, y: number, size: BoardSize): string {
  const col = GO_LETTERS[x] ?? '?';
  const row = size - y;
  return `${col}${row}`;
}

export function getStarPoints(size: BoardSize): Coord[] {
  if (size === 19) {
    const pts = [3, 9, 15];
    const res: Coord[] = [];
    for (const y of pts) for (const x of pts) res.push({ x, y });
    return res;
  }
  if (size === 15) {
    return [
      { x: 3, y: 3 },
      { x: 11, y: 3 },
      { x: 7, y: 7 },
      { x: 3, y: 11 },
      { x: 11, y: 11 },
    ];
  }
  if (size === 13) {
    const pts = [3, 6, 9];
    const res: Coord[] = [];
    for (const y of pts) for (const x of pts) res.push({ x, y });
    return res;
  }
  // 9x9
  return [
    { x: 2, y: 2 },
    { x: 6, y: 2 },
    { x: 4, y: 4 },
    { x: 2, y: 6 },
    { x: 6, y: 6 },
  ];
}

export function getHandicapCoordinates(size: BoardSize, handicap: number): Coord[] {
  if (handicap < 2) return [];
  const clamped = Math.min(9, Math.max(2, Math.floor(handicap)));

  const low = size === 9 ? 2 : 3;
  const mid = Math.floor(size / 2);
  const high = size - 1 - low;

  const upperRight: Coord = { x: high, y: low };
  const lowerLeft: Coord = { x: low, y: high };
  const lowerRight: Coord = { x: high, y: high };
  const upperLeft: Coord = { x: low, y: low };
  const center: Coord = { x: mid, y: mid };
  const leftSide: Coord = { x: low, y: mid };
  const rightSide: Coord = { x: high, y: mid };
  const topSide: Coord = { x: mid, y: low };
  const bottomSide: Coord = { x: mid, y: high };

  switch (clamped) {
    case 2:
      return [upperRight, lowerLeft];
    case 3:
      return [upperRight, lowerLeft, lowerRight];
    case 4:
      return [upperRight, lowerLeft, lowerRight, upperLeft];
    case 5:
      return [upperRight, lowerLeft, lowerRight, upperLeft, center];
    case 6:
      return [upperRight, lowerLeft, lowerRight, upperLeft, leftSide, rightSide];
    case 7:
      return [upperRight, lowerLeft, lowerRight, upperLeft, leftSide, rightSide, center];
    case 8:
      return [upperRight, lowerLeft, lowerRight, upperLeft, leftSide, rightSide, topSide, bottomSide];
    case 9:
    default:
      return [
        upperRight,
        lowerLeft,
        lowerRight,
        upperLeft,
        leftSide,
        rightSide,
        topSide,
        bottomSide,
        center,
      ];
  }
}

export interface ChainInfo {
  stones: number[]; // flat indices
  liberties: Set<number>; // flat indices of empty neighbors
}

export function inspectChain(board: Uint8Array, size: BoardSize, startIdx: number): ChainInfo {
  const targetColor = board[startIdx];
  const stones: number[] = [];
  const liberties = new Set<number>();
  if (targetColor === EMPTY) {
    return { stones, liberties };
  }

  const visited = new Uint8Array(size * size);
  const stack: number[] = [startIdx];
  visited[startIdx] = 1;

  while (stack.length > 0) {
    const idx = stack.pop()!;
    stones.push(idx);
    const x = idx % size;
    const y = (idx - x) / size;

    // 4 orthogonal neighbors
    if (x > 0) {
      const n = idx - 1;
      const c = board[n];
      if (c === EMPTY) liberties.add(n);
      else if (c === targetColor && !visited[n]) {
        visited[n] = 1;
        stack.push(n);
      }
    }
    if (x < size - 1) {
      const n = idx + 1;
      const c = board[n];
      if (c === EMPTY) liberties.add(n);
      else if (c === targetColor && !visited[n]) {
        visited[n] = 1;
        stack.push(n);
      }
    }
    if (y > 0) {
      const n = idx - size;
      const c = board[n];
      if (c === EMPTY) liberties.add(n);
      else if (c === targetColor && !visited[n]) {
        visited[n] = 1;
        stack.push(n);
      }
    }
    if (y < size - 1) {
      const n = idx + size;
      const c = board[n];
      if (c === EMPTY) liberties.add(n);
      else if (c === targetColor && !visited[n]) {
        visited[n] = 1;
        stack.push(n);
      }
    }
  }

  return { stones, liberties };
}

export class GoEngine {
  public config: GameConfig;
  public size: BoardSize;
  public board: Uint8Array;
  public currentTurn: PlayerColor;
  public phase: GamePhase;
  public koPoint: Coord | null = null;
  public captures = { black: 0, white: 0 }; // stones captured BY black / BY white
  public consecutivePasses = 0;
  public history: MoveRecord[] = [];
  public initialBoard: Uint8Array;
  public initialHash: bigint;
  public currentHash: bigint;
  public positionHashes: Set<bigint>;
  public handicapStones: Coord[] = [];
  public result: GameResult | null = null;

  constructor(config: GameConfig) {
    this.config = { ...config };
    this.size = config.boardSize;
    this.board = new Uint8Array(this.size * this.size);
    this.initialBoard = new Uint8Array(this.size * this.size);
    this.currentTurn = BLACK;
    this.phase = 'playing';
    this.positionHashes = new Set<bigint>();
    this.initialHash = 0n;
    this.currentHash = 0n;

    this.reset(config);
  }

  public reset(newConfig?: Partial<GameConfig>): void {
    if (newConfig) {
      this.config = { ...this.config, ...newConfig };
    }
    this.size = this.config.boardSize;
    this.board = new Uint8Array(this.size * this.size);
    this.koPoint = null;
    this.captures = { black: 0, white: 0 };
    this.consecutivePasses = 0;
    this.history = [];
    this.result = null;
    this.phase = 'playing';

    // Place handicap stones if >= 2
    this.handicapStones = [];
    if (this.config.handicap >= 2) {
      const coords = getHandicapCoordinates(this.size, this.config.handicap);
      for (const pt of coords) {
        this.board[pt.y * this.size + pt.x] = BLACK;
        this.handicapStones.push(pt);
      }
      this.currentTurn = WHITE; // White plays first in handicap Baduk
    } else {
      this.currentTurn = BLACK;
    }

    this.initialBoard = new Uint8Array(this.board);
    this.initialHash = computeBoardHash(this.board, this.size);
    this.currentHash = this.initialHash;
    this.positionHashes = new Set<bigint>([this.initialHash]);
  }

  public getStone(x: number, y: number): StoneColor {
    if (x < 0 || x >= this.size || y < 0 || y >= this.size) return EMPTY;
    return this.board[y * this.size + x] as StoneColor;
  }

  public setCustomSetupStone(x: number, y: number, color: StoneColor): void {
    if (x < 0 || x >= this.size || y < 0 || y >= this.size) return;
    this.board[y * this.size + x] = color;
    this.initialBoard = new Uint8Array(this.board);
    this.initialHash = computeBoardHash(this.board, this.size);
    this.currentHash = this.initialHash;
    this.positionHashes = new Set<bigint>([this.initialHash]);
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

    // Immediate Simple Ko check
    if (this.koPoint && this.koPoint.x === x && this.koPoint.y === y) {
      return { valid: false, reason: 'KO' };
    }

    const opp = opponentColor(color);
    const nextBoard = new Uint8Array(this.board);
    nextBoard[idx] = color;
    let nextHash = this.currentHash ^ stoneZobristKey(idx, color);

    // Count adjacent stones for acoustic feedback & collect zero-liberty opponent chains
    const neighbors: number[] = [];
    if (x > 0) neighbors.push(idx - 1);
    if (x < this.size - 1) neighbors.push(idx + 1);
    if (y > 0) neighbors.push(idx - this.size);
    if (y < this.size - 1) neighbors.push(idx + this.size);

    let adjacentOpponentCount = 0;
    let adjacentTotalCount = 0;
    const capturedIndices = new Set<number>();

    for (const nIdx of neighbors) {
      const nColor = this.board[nIdx];
      if (nColor !== EMPTY) {
        adjacentTotalCount++;
        if (nColor === opp) adjacentOpponentCount++;
      }

      if (nextBoard[nIdx] === opp) {
        const oppChain = inspectChain(nextBoard, this.size, nIdx);
        if (oppChain.liberties.size === 0) {
          for (const capIdx of oppChain.stones) {
            nextBoard[capIdx] = EMPTY;
            nextHash ^= stoneZobristKey(capIdx, opp);
            capturedIndices.add(capIdx);
          }
        }
      }
    }

    // Step 2: Check suicide AFTER removing captured opponent stones
    const ownChain = inspectChain(nextBoard, this.size, idx);
    if (ownChain.liberties.size === 0) {
      return { valid: false, reason: 'SUICIDE' };
    }

    // Step 3: Check Simple Ko via previous position hash (1-move recapture)
    const prevHash =
      this.history.length >= 1
        ? this.history.length >= 2
          ? this.history[this.history.length - 2].hashAfter
          : this.initialHash
        : null;

    if (prevHash !== null && nextHash === prevHash) {
      return { valid: false, reason: 'KO' };
    }

    // Step 4: Check Positional Superko (mandatory in Chinese rules, optional/enabled in Korean rules to prevent infinite cycles)
    const enforceSuperko = this.config.ruleset === 'chinese' || this.config.superko;
    if (enforceSuperko && this.positionHashes.has(nextHash)) {
      return { valid: false, reason: 'SUPERKO' };
    }

    // Determine next Simple Ko point:
    // Occurs strictly when a single stone was placed (ownChain.stones.length === 1),
    // ownChain now has exactly 1 liberty, and exactly 1 opponent stone was captured.
    let nextKoPoint: Coord | null = null;
    if (capturedIndices.size === 1 && ownChain.stones.length === 1 && ownChain.liberties.size === 1) {
      const [capIdx] = Array.from(capturedIndices);
      nextKoPoint = {
        x: capIdx % this.size,
        y: Math.floor(capIdx / this.size),
      };
    }

    const capturedCoords: Coord[] = Array.from(capturedIndices).map((cIdx) => ({
      x: cIdx % this.size,
      y: Math.floor(cIdx / this.size),
    }));

    return {
      valid: true,
      capturedCoords,
      resultingBoard: nextBoard,
      resultingHash: nextHash,
      nextKoPoint,
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
    this.positionHashes.add(this.currentHash);
    this.koPoint = check.nextKoPoint ?? null;
    this.consecutivePasses = 0;

    const captured = check.capturedCoords ?? [];
    if (color === BLACK) {
      this.captures.black += captured.length;
    } else {
      this.captures.white += captured.length;
    }

    const record: MoveRecord = {
      moveNumber: this.history.length + 1,
      color,
      coord: { x, y },
      captured,
      koPointAfter: this.koPoint ? { ...this.koPoint } : null,
      boardBefore,
      boardAfter: new Uint8Array(this.board),
      capturesAfter: { ...this.captures },
      hashAfter: this.currentHash,
      consecutivePasses: 0,
      timestamp: Date.now(),
    };

    this.history.push(record);
    this.currentTurn = opponentColor(color);

    return { ...check, record };
  }

  public pass(): MoveRecord | null {
    if (this.phase !== 'playing') return null;

    const color = this.currentTurn;
    const boardBefore = new Uint8Array(this.board);
    this.koPoint = null; // Passing clears immediate Ko threat restriction
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
      this.phase = 'scoring';
    }

    return record;
  }

  public resumePlayingFromScoring(): void {
    if (this.phase === 'scoring') {
      this.phase = 'playing';
      this.consecutivePasses = 0;
    }
  }

  public resign(resigningColor: PlayerColor): GameResult {
    const winner = opponentColor(resigningColor);
    const winnerLabel = winner === BLACK ? '흑' : '백';
    this.phase = 'finished';
    this.result = {
      winner,
      reason: 'resign',
      summaryText: `${winnerLabel} 불계승`,
    };
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
    return this.result;
  }

  public finalizeScoreResult(result: GameResult): void {
    this.phase = 'finished';
    this.result = result;
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
      this.koPoint = null;
      this.captures = { black: 0, white: 0 };
      this.consecutivePasses = 0;
      this.currentTurn = this.config.handicap >= 2 ? WHITE : BLACK;
      this.positionHashes = new Set<bigint>([this.initialHash]);
    } else {
      const last = this.history[this.history.length - 1];
      this.board = new Uint8Array(last.boardAfter);
      this.currentHash = last.hashAfter;
      this.koPoint = last.koPointAfter ? { ...last.koPointAfter } : null;
      this.captures = { ...last.capturesAfter };
      this.consecutivePasses = last.consecutivePasses;
      this.currentTurn = opponentColor(last.color);

      this.positionHashes = new Set<bigint>([this.initialHash]);
      for (const rec of this.history) {
        this.positionHashes.add(rec.hashAfter);
      }
    }

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
        nextTurn: this.config.handicap >= 2 ? WHITE : BLACK,
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
      case 'KO':
        return '패(Ko) 자리입니다. 딴 곳에 패감을 쓴 뒤 따낼 수 있습니다.';
      case 'SUPERKO':
        return '동형반복(초패) 금지 자리입니다.';
      case 'SUICIDE':
        return '활로가 없는 자살수 자리에는 착수할 수 없습니다.';
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
