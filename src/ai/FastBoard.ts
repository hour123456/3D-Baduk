import { BLACK, WHITE, EMPTY, BoardSize, PlayerColor, RulesetType, opponentColor } from '../rules/types';
import { stoneZobristKey, computeBoardHash } from '../rules/zobrist';

export class FastBoard {
  public readonly size: BoardSize;
  public readonly total: number;
  public grid: Uint8Array;
  public koIdx: number;
  public capturesBlack: number;
  public capturesWhite: number;
  public hash: bigint;

  private readonly visited: Uint32Array;
  private visitToken = 1;
  private readonly stack: Int16Array;
  private readonly neighborsTable: Int16Array;
  private readonly diagonalsTable: Int16Array;

  constructor(size: BoardSize) {
    this.size = size;
    this.total = size * size;
    this.grid = new Uint8Array(this.total);
    this.koIdx = -1;
    this.capturesBlack = 0;
    this.capturesWhite = 0;
    this.hash = 0n;

    this.visited = new Uint32Array(this.total);
    this.stack = new Int16Array(this.total);
    this.neighborsTable = new Int16Array(this.total * 4).fill(-1);
    this.diagonalsTable = new Int16Array(this.total * 4).fill(-1);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        let k = 0;
        if (x > 0) this.neighborsTable[idx * 4 + k++] = idx - 1;
        if (x < size - 1) this.neighborsTable[idx * 4 + k++] = idx + 1;
        if (y > 0) this.neighborsTable[idx * 4 + k++] = idx - size;
        if (y < size - 1) this.neighborsTable[idx * 4 + k++] = idx + size;

        let d = 0;
        if (x > 0 && y > 0) this.diagonalsTable[idx * 4 + d++] = (y - 1) * size + (x - 1);
        if (x < size - 1 && y > 0) this.diagonalsTable[idx * 4 + d++] = (y - 1) * size + (x + 1);
        if (x > 0 && y < size - 1) this.diagonalsTable[idx * 4 + d++] = (y + 1) * size + (x - 1);
        if (x < size - 1 && y < size - 1) this.diagonalsTable[idx * 4 + d++] = (y + 1) * size + (x + 1);
      }
    }
  }

  public copyFromState(
    board: Uint8Array,
    koIdx: number,
    capturesBlack: number,
    capturesWhite: number,
    hash?: bigint
  ): void {
    this.grid.set(board);
    this.koIdx = koIdx;
    this.capturesBlack = capturesBlack;
    this.capturesWhite = capturesWhite;
    this.hash = hash !== undefined ? hash : computeBoardHash(board, this.size);
  }

  public copyFrom(other: FastBoard): void {
    this.grid.set(other.grid);
    this.koIdx = other.koIdx;
    this.capturesBlack = other.capturesBlack;
    this.capturesWhite = other.capturesWhite;
    this.hash = other.hash;
  }

  public clone(): FastBoard {
    const c = new FastBoard(this.size);
    c.copyFrom(this);
    return c;
  }

  private bumpToken(): number {
    this.visitToken = (this.visitToken + 1) >>> 0;
    if (this.visitToken === 0) {
      this.visited.fill(0);
      this.visitToken = 1;
    }
    return this.visitToken;
  }

  public getNeighborsOffset(idx: number): Int16Array {
    return this.neighborsTable.subarray(idx * 4, idx * 4 + 4);
  }

  public getDiagonalsOffset(idx: number): Int16Array {
    return this.diagonalsTable.subarray(idx * 4, idx * 4 + 4);
  }

  public analyzeChain(
    startIdx: number,
    maxLimit = 4
  ): { stoneCount: number; libertyCount: number; lib0: number; lib1: number } {
    const color = this.grid[startIdx];
    if (color === EMPTY) return { stoneCount: 0, libertyCount: 0, lib0: -1, lib1: -1 };

    const tok = this.bumpToken();
    const libTok = this.bumpToken();
    let sp = 0;
    this.stack[sp++] = startIdx;
    this.visited[startIdx] = tok;

    let stoneCount = 0;
    let libertyCount = 0;
    let lib0 = -1;
    let lib1 = -1;

    while (sp > 0) {
      const curr = this.stack[--sp];
      stoneCount++;
      const base = curr * 4;
      for (let i = 0; i < 4; i++) {
        const n = this.neighborsTable[base + i];
        if (n < 0) break;
        const nc = this.grid[n];
        if (nc === EMPTY) {
          if (this.visited[n] !== libTok) {
            this.visited[n] = libTok;
            if (libertyCount === 0) lib0 = n;
            else if (libertyCount === 1) lib1 = n;
            libertyCount++;
            if (libertyCount >= maxLimit) {
              // continue stone traversal
            }
          }
        } else if (nc === color && this.visited[n] !== tok) {
          this.visited[n] = tok;
          this.stack[sp++] = n;
        }
      }
    }

    return { stoneCount, libertyCount, lib0, lib1 };
  }

  private hasAnyLiberty(startIdx: number): boolean {
    const color = this.grid[startIdx];
    const tok = this.bumpToken();
    let sp = 0;
    this.stack[sp++] = startIdx;
    this.visited[startIdx] = tok;

    while (sp > 0) {
      const curr = this.stack[--sp];
      const base = curr * 4;
      for (let i = 0; i < 4; i++) {
        const n = this.neighborsTable[base + i];
        if (n < 0) break;
        const nc = this.grid[n];
        if (nc === EMPTY) return true;
        if (nc === color && this.visited[n] !== tok) {
          this.visited[n] = tok;
          this.stack[sp++] = n;
        }
      }
    }
    return false;
  }

  private removeChain(startIdx: number, color: PlayerColor): { removedCount: number; singleIdx: number } {
    let sp = 0;
    this.stack[sp++] = startIdx;
    this.grid[startIdx] = EMPTY;
    this.hash ^= stoneZobristKey(startIdx, color);
    let count = 0;
    const singleIdx = startIdx;

    while (sp > 0) {
      const curr = this.stack[--sp];
      count++;
      const base = curr * 4;
      for (let i = 0; i < 4; i++) {
        const n = this.neighborsTable[base + i];
        if (n < 0) break;
        if (this.grid[n] === color) {
          this.grid[n] = EMPTY;
          this.hash ^= stoneZobristKey(n, color);
          this.stack[sp++] = n;
        }
      }
    }

    return { removedCount: count, singleIdx };
  }

  public play(idx: number, color: PlayerColor, forbiddenHashes?: Set<bigint>): number {
    if (idx < 0 || idx >= this.total) return -1;
    if (this.grid[idx] !== EMPTY || idx === this.koIdx) return -1;

    const opp = opponentColor(color);
    const prevHash = this.hash;
    const prevKo = this.koIdx;

    this.grid[idx] = color;
    this.hash ^= stoneZobristKey(idx, color);

    let totalCaptured = 0;
    let lastSingleCap = -1;
    const base = idx * 4;

    for (let i = 0; i < 4; i++) {
      const n = this.neighborsTable[base + i];
      if (n < 0) break;
      if (this.grid[n] === opp && !this.hasAnyLiberty(n)) {
        const { removedCount, singleIdx } = this.removeChain(n, opp);
        totalCaptured += removedCount;
        lastSingleCap = singleIdx;
      }
    }

    if (totalCaptured === 0 && !this.hasAnyLiberty(idx)) {
      this.grid[idx] = EMPTY;
      this.hash = prevHash;
      this.koIdx = prevKo;
      return -1;
    }

    if (forbiddenHashes && forbiddenHashes.has(this.hash)) {
      return -1;
    }

    if (color === BLACK) this.capturesBlack += totalCaptured;
    else this.capturesWhite += totalCaptured;

    if (totalCaptured === 1) {
      const ownInfo = this.analyzeChain(idx, 2);
      if (ownInfo.stoneCount === 1 && ownInfo.libertyCount === 1) {
        this.koIdx = lastSingleCap;
      } else {
        this.koIdx = -1;
      }
    } else {
      this.koIdx = -1;
    }

    return totalCaptured;
  }

  public isLegal(idx: number, color: PlayerColor, forbiddenHashes?: Set<bigint>): boolean {
    if (idx < 0 || idx >= this.total) return false;
    if (this.grid[idx] !== EMPTY || idx === this.koIdx) return false;

    const base = idx * 4;
    let hasEmptyNbr = false;
    for (let i = 0; i < 4; i++) {
      const n = this.neighborsTable[base + i];
      if (n < 0) break;
      if (this.grid[n] === EMPTY) {
        hasEmptyNbr = true;
        break;
      }
    }

    if (hasEmptyNbr && !forbiddenHashes) {
      return true;
    }

    const test = this.clone();
    return test.play(idx, color, forbiddenHashes) >= 0;
  }

  public isTrueEye(idx: number, color: PlayerColor): boolean {
    if (this.grid[idx] !== EMPTY) return false;
    const base = idx * 4;
    for (let i = 0; i < 4; i++) {
      const n = this.neighborsTable[base + i];
      if (n < 0) break;
      if (this.grid[n] !== color) return false;
    }

    const opp = opponentColor(color);
    let diagTotal = 0;
    let oppDiag = 0;
    for (let i = 0; i < 4; i++) {
      const d = this.diagonalsTable[base + i];
      if (d < 0) break;
      diagTotal++;
      if (this.grid[d] === opp) oppDiag++;
    }

    if (diagTotal === 4) return oppDiag <= 1;
    return oppDiag === 0;
  }

  public evaluateRolloutScore(ruleset: RulesetType, komi: number): number {
    let blackPoints = 0;
    let whitePoints = 0;

    if (ruleset === 'chinese') {
      for (let i = 0; i < this.total; i++) {
        const c = this.grid[i];
        if (c === BLACK) blackPoints++;
        else if (c === WHITE) whitePoints++;
        else {
          const base = i * 4;
          let seenB = false;
          let seenW = false;
          for (let k = 0; k < 4; k++) {
            const n = this.neighborsTable[base + k];
            if (n < 0) break;
            const nc = this.grid[n];
            if (nc === BLACK) seenB = true;
            else if (nc === WHITE) seenW = true;
          }
          if (seenB && !seenW) blackPoints++;
          else if (seenW && !seenB) whitePoints++;
        }
      }
      return blackPoints - (whitePoints + komi);
    } else {
      blackPoints = this.capturesBlack;
      whitePoints = this.capturesWhite;
      for (let i = 0; i < this.total; i++) {
        if (this.grid[i] !== EMPTY) continue;
        const base = i * 4;
        let seenB = false;
        let seenW = false;
        for (let k = 0; k < 4; k++) {
          const n = this.neighborsTable[base + k];
          if (n < 0) break;
          const nc = this.grid[n];
          if (nc === BLACK) seenB = true;
          else if (nc === WHITE) seenW = true;
        }
        if (seenB && !seenW) blackPoints++;
        else if (seenW && !seenB) whitePoints++;
      }
      return blackPoints - (whitePoints + komi);
    }
  }
}
