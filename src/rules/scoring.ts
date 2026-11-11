import {
  BLACK,
  WHITE,
  EMPTY,
  BoardSize,
  GameResult,
  PlayerColor,
  RulesetType,
  ScoreBreakdown,
  opponentColor,
} from './types';
import { inspectChain } from './GoEngine';

export function estimateDeadStones(board: Uint8Array, size: BoardSize): Uint8Array {
  const total = size * size;
  const deadMask = new Uint8Array(total);

  let field = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    if (board[i] === BLACK) field[i] = 16;
    else if (board[i] === WHITE) field[i] = -16;
  }

  for (let step = 0; step < 5; step++) {
    const next = new Float32Array(field);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        if (board[idx] !== EMPTY) continue;
        let sum = field[idx] * 2;
        let weight = 2;
        if (x > 0) { sum += field[idx - 1]; weight++; }
        if (x < size - 1) { sum += field[idx + 1]; weight++; }
        if (y > 0) { sum += field[idx - size]; weight++; }
        if (y < size - 1) { sum += field[idx + size]; weight++; }
        next[idx] = sum / weight;
      }
    }
    field = next;
  }

  const visited = new Uint8Array(total);
  for (let idx = 0; idx < total; idx++) {
    const color = board[idx] as PlayerColor | 0;
    if (color === EMPTY || visited[idx]) continue;

    const chain = inspectChain(board, size, idx);
    for (const s of chain.stones) visited[s] = 1;

    if (chain.stones.length >= 8 || chain.liberties.size >= 5) {
      continue;
    }

    let friendlyInfluenceSum = 0;
    const libertyCount = chain.liberties.size;
    const sign = color === BLACK ? 1 : -1;
    const opp = opponentColor(color);

    let oppNeighborStones = 0;
    let friendlyExtendedSpace = 0;
    const seenSpace = new Uint8Array(total);

    const queue: Array<{ cell: number; dist: number }> = [];
    for (const lib of chain.liberties) {
      seenSpace[lib] = 1;
      queue.push({ cell: lib, dist: 1 });
      friendlyInfluenceSum += field[lib] * sign;
    }

    while (queue.length > 0) {
      const { cell, dist } = queue.shift()!;
      friendlyExtendedSpace++;
      if (dist >= 3) continue;
      const cx = cell % size;
      const cy = (cell - cx) / size;
      const nbrs: number[] = [];
      if (cx > 0) nbrs.push(cell - 1);
      if (cx < size - 1) nbrs.push(cell + 1);
      if (cy > 0) nbrs.push(cell - size);
      if (cy < size - 1) nbrs.push(cell + size);

      for (const n of nbrs) {
        if (board[n] === EMPTY && !seenSpace[n]) {
          seenSpace[n] = 1;
          queue.push({ cell: n, dist: dist + 1 });
        } else if (board[n] === opp) {
          oppNeighborStones++;
        }
      }
    }

    const avgLibInfluence = libertyCount > 0 ? friendlyInfluenceSum / libertyCount : -10;

    const clearlyDead =
      (libertyCount === 1 && chain.stones.length <= 4 && avgLibInfluence < 1.5) ||
      (chain.stones.length <= 3 && friendlyExtendedSpace <= 4 && avgLibInfluence < -2.2 && oppNeighborStones >= 3) ||
      (chain.stones.length <= 5 && libertyCount <= 2 && friendlyExtendedSpace <= 3 && avgLibInfluence < -1.5);

    if (clearlyDead) {
      for (const s of chain.stones) {
        deadMask[s] = 1;
      }
    }
  }

  return deadMask;
}

export function toggleDeadChainAt(
  board: Uint8Array,
  size: BoardSize,
  deadMask: Uint8Array,
  x: number,
  y: number
): Uint8Array {
  const nextMask = new Uint8Array(deadMask);
  if (x < 0 || x >= size || y < 0 || y >= size) return nextMask;
  const idx = y * size + x;
  if (board[idx] === EMPTY) return nextMask;

  const chain = inspectChain(board, size, idx);
  const nextVal = nextMask[idx] ? 0 : 1;
  for (const s of chain.stones) {
    nextMask[s] = nextVal;
  }
  return nextMask;
}

export function calculateScore(params: {
  board: Uint8Array;
  size: BoardSize;
  ruleset: RulesetType;
  komi: number;
  captures: { black: number; white: number };
  deadStoneMask?: Uint8Array;
}): ScoreBreakdown {
  const { board, size, ruleset, komi, captures } = params;
  const total = size * size;
  const deadStoneMask = params.deadStoneMask ? new Uint8Array(params.deadStoneMask) : new Uint8Array(total);

  const effective = new Uint8Array(board);
  let deadBlackStones = 0;
  let deadWhiteStones = 0;
  let blackAliveStones = 0;
  let whiteAliveStones = 0;

  for (let i = 0; i < total; i++) {
    const stone = board[i];
    if (stone === BLACK) {
      if (deadStoneMask[i]) {
        effective[i] = EMPTY;
        deadBlackStones++;
      } else {
        blackAliveStones++;
      }
    } else if (stone === WHITE) {
      if (deadStoneMask[i]) {
        effective[i] = EMPTY;
        deadWhiteStones++;
      } else {
        whiteAliveStones++;
      }
    }
  }

  const visited = new Uint8Array(total);
  const territoryMap = new Int8Array(total);
  let blackTerritory = 0;
  let whiteTerritory = 0;
  let dameCount = 0;

  for (let i = 0; i < total; i++) {
    if (effective[i] !== EMPTY || visited[i]) continue;

    const region: number[] = [];
    const stack: number[] = [i];
    visited[i] = 1;
    let touchesBlack = false;
    let touchesWhite = false;

    while (stack.length > 0) {
      const curr = stack.pop()!;
      region.push(curr);
      const cx = curr % size;
      const cy = (curr - cx) / size;

      const checkNeighbor = (nIdx: number) => {
        const c = effective[nIdx];
        if (c === EMPTY) {
          if (!visited[nIdx]) {
            visited[nIdx] = 1;
            stack.push(nIdx);
          }
        } else if (c === BLACK) {
          touchesBlack = true;
        } else if (c === WHITE) {
          touchesWhite = true;
        }
      };

      if (cx > 0) checkNeighbor(curr - 1);
      if (cx < size - 1) checkNeighbor(curr + 1);
      if (cy > 0) checkNeighbor(curr - size);
      if (cy < size - 1) checkNeighbor(curr + size);
    }

    if (touchesBlack && !touchesWhite) {
      blackTerritory += region.length;
      for (const r of region) territoryMap[r] = BLACK;
    } else if (touchesWhite && !touchesBlack) {
      whiteTerritory += region.length;
      for (const r of region) territoryMap[r] = WHITE;
    } else {
      dameCount += region.length;
    }
  }

  let blackTotal: number;
  let whiteTotal: number;

  if (ruleset === 'korean') {
    blackTotal = blackTerritory + captures.black + deadWhiteStones;
    whiteTotal = whiteTerritory + captures.white + deadBlackStones + komi;
  } else {
    blackTotal = blackAliveStones + blackTerritory;
    whiteTotal = whiteAliveStones + whiteTerritory + komi;
  }

  const diff = blackTotal - whiteTotal;
  let winner: PlayerColor | 'draw' = 'draw';
  if (Math.abs(diff) > 1e-6) {
    winner = diff > 0 ? BLACK : WHITE;
  }
  const margin = Math.round(Math.abs(diff) * 10) / 10;

  return {
    ruleset,
    komi,
    blackTerritory,
    whiteTerritory,
    blackAliveStones,
    whiteAliveStones,
    blackCapturesDuringPlay: captures.black,
    whiteCapturesDuringPlay: captures.white,
    deadBlackStones,
    deadWhiteStones,
    dameCount,
    blackTotal,
    whiteTotal,
    winner,
    margin,
    territoryMap,
    deadStoneMask,
  };
}

export function buildScoreGameResult(breakdown: ScoreBreakdown): GameResult {
  let summaryText = '빅 (무승부)';
  if (breakdown.winner === BLACK) {
    summaryText = `흑 ${breakdown.margin}집 승`;
  } else if (breakdown.winner === WHITE) {
    summaryText = `백 ${breakdown.margin}집 승`;
  }
  return {
    winner: breakdown.winner,
    reason: 'score',
    margin: breakdown.margin,
    scoreBreakdown: breakdown,
    summaryText,
  };
}
