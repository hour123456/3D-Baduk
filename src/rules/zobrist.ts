import { BoardSize, PlayerColor, StoneColor, BLACK, WHITE } from './types';

const MAX_CELLS = 19 * 19;

class SplitMix64 {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = seed & 0xffffffffffffffffn;
  }

  next(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    return (z ^ (z >> 31n)) & 0xffffffffffffffffn;
  }
}

const rng = new SplitMix64(0x2026bad0c3d9a7f1n);

const ZOBRIST_TABLE: BigUint64Array = new BigUint64Array(MAX_CELLS * 2);
for (let i = 0; i < MAX_CELLS * 2; i++) {
  ZOBRIST_TABLE[i] = rng.next();
}

export function stoneZobristKey(cellIndex: number, color: PlayerColor): bigint {
  const offset = color === BLACK ? 0 : 1;
  return ZOBRIST_TABLE[cellIndex * 2 + offset];
}

export function computeBoardHash(board: Uint8Array, size: BoardSize): bigint {
  let hash = 0n;
  const total = size * size;
  for (let i = 0; i < total; i++) {
    const stone = board[i] as StoneColor;
    if (stone === BLACK || stone === WHITE) {
      hash ^= stoneZobristKey(i, stone);
    }
  }
  return hash;
}
