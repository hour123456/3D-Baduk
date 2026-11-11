import { BLACK, WHITE, EMPTY, PlayerColor, opponentColor } from '../rules/types';
import { FastBoard } from './FastBoard';

export function isCapturedInLadder(
  board: FastBoard,
  targetIdx: number,
  turnToMove: PlayerColor,
  depth = 0,
  maxDepth = 28
): boolean {
  const defender = board.grid[targetIdx] as PlayerColor | 0;
  if (defender === EMPTY) return true;
  const attacker = opponentColor(defender);

  const info = board.analyzeChain(targetIdx, 3);
  if (info.libertyCount >= 3) return false;
  if (info.libertyCount === 0) return true;
  if (depth >= maxDepth) return false;

  if (turnToMove === attacker) {
    if (info.libertyCount === 1) {
      const next = board.clone();
      if (next.play(info.lib0, attacker) >= 0) return true;
      return false;
    }
    const candidates = [info.lib0, info.lib1];
    for (const move of candidates) {
      if (move < 0) continue;
      const next = board.clone();
      if (next.play(move, attacker) < 0) continue;
      const atkInfo = next.analyzeChain(move, 2);
      if (atkInfo.libertyCount >= 2) {
        if (isCapturedInLadder(next, targetIdx, defender, depth + 1, maxDepth)) {
          return true;
        }
      }
    }
    return false;
  } else {
    const visitedNbrs = new Set<number>();
    for (let idx = 0; idx < board.total; idx++) {
      if (board.grid[idx] !== defender) continue;
      const nbrs = board.getNeighborsOffset(idx);
      for (let i = 0; i < 4; i++) {
        const n = nbrs[i];
        if (n < 0) break;
        if (board.grid[n] === attacker && !visitedNbrs.has(n)) {
          visitedNbrs.add(n);
          const oppChain = board.analyzeChain(n, 2);
          if (oppChain.libertyCount === 1 && oppChain.lib0 >= 0) {
            const next = board.clone();
            if (next.play(oppChain.lib0, defender) > 0) {
              if (!isCapturedInLadder(next, targetIdx, attacker, depth + 1, maxDepth)) {
                return false;
              }
            }
          }
        }
      }
    }

    const libs = info.libertyCount === 1 ? [info.lib0] : [info.lib0, info.lib1];
    for (const move of libs) {
      if (move < 0) continue;
      const next = board.clone();
      if (next.play(move, defender) < 0) continue;
      if (!isCapturedInLadder(next, targetIdx, attacker, depth + 1, maxDepth)) {
        return false;
      }
    }
    return true;
  }
}

export function computeCandidateMovesAndPriors(params: {
  board: FastBoard;
  color: PlayerColor;
  lastMoveIdx: number | null;
  moveCount: number;
  forbiddenHashes?: Set<bigint>;
  enableAdvancedTactics: boolean;
}): { moves: Int16Array; priors: Float32Array; count: number } {
  const { board, color, lastMoveIdx, moveCount, forbiddenHashes, enableAdvancedTactics } = params;
  const opp = opponentColor(color);
  const size = board.size;
  const total = board.total;

  const moves = new Int16Array(total);
  const weights = new Float32Array(total);
  let count = 0;

  const isOpening = moveCount < Math.floor(total * 0.16);
  const isEarlyMid = moveCount < Math.floor(total * 0.35);

  for (let idx = 0; idx < total; idx++) {
    if (board.grid[idx] !== EMPTY || idx === board.koIdx) continue;
    if (board.isTrueEye(idx, color)) continue;

    const sim = board.clone();
    const captured = sim.play(idx, color, forbiddenHashes);
    if (captured < 0) continue;

    let score = 1.0;
    const x = idx % size;
    const y = (idx - x) / size;
    const distEdgeX = Math.min(x, size - 1 - x);
    const distEdgeY = Math.min(y, size - 1 - y);
    const minEdgeDist = Math.min(distEdgeX, distEdgeY);

    if (captured > 0) {
      score += 4.5 + captured * 3.2;
    }

    const afterOwn = sim.analyzeChain(idx, 4);
    if (afterOwn.libertyCount === 1) {
      if (captured === 0 && afterOwn.stoneCount >= 2) {
        score *= 0.04;
      } else if (captured === 0) {
        score *= 0.14;
      }
    } else if (afterOwn.libertyCount === 2 && enableAdvancedTactics && afterOwn.stoneCount >= 2) {
      if (isCapturedInLadder(sim, idx, opp, 0, 20)) {
        score *= 0.08;
      }
    }

    const nbrs = board.getNeighborsOffset(idx);
    const diags = board.getDiagonalsOffset(idx);
    let ownNbrs = 0;
    let oppNbrs = 0;

    for (let i = 0; i < 4; i++) {
      const n = nbrs[i];
      if (n < 0) break;
      const nc = board.grid[n];
      if (nc === color) {
        ownNbrs++;
        const beforeChain = board.analyzeChain(n, 3);
        if (beforeChain.libertyCount === 1 && afterOwn.libertyCount >= 2) {
          const trapped = enableAdvancedTactics && isCapturedInLadder(sim, idx, opp, 0, 22);
          score += trapped ? -0.5 : 5.0 + beforeChain.stoneCount * 2.4;
        }
      } else if (nc === opp) {
        oppNbrs++;
        if (sim.grid[n] === opp) {
          const oppAfter = sim.analyzeChain(n, 3);
          if (oppAfter.libertyCount === 1) {
            if (enableAdvancedTactics && isCapturedInLadder(sim, n, opp, 0, 22)) {
              score += 6.5 + oppAfter.stoneCount * 2.8;
            } else {
              score += 1.9 + oppAfter.stoneCount * 0.7;
            }
          }
        }
      }
    }

    let ownDiags = 0;
    for (let i = 0; i < 4; i++) {
      const d = diags[i];
      if (d < 0) break;
      if (board.grid[d] === color) ownDiags++;
    }

    if (ownNbrs === 2 && oppNbrs === 0 && captured === 0) {
      const top = y > 0 ? board.grid[idx - size] === color : false;
      const bot = y < size - 1 ? board.grid[idx + size] === color : false;
      const lft = x > 0 ? board.grid[idx - 1] === color : false;
      const rgt = x < size - 1 ? board.grid[idx + 1] === color : false;
      if (
        (top && lft && board.grid[(y - 1) * size + (x - 1)] === EMPTY) ||
        (top && rgt && board.grid[(y - 1) * size + (x + 1)] === EMPTY) ||
        (bot && lft && board.grid[(y + 1) * size + (x - 1)] === EMPTY) ||
        (bot && rgt && board.grid[(y + 1) * size + (x + 1)] === EMPTY)
      ) {
        score *= 0.45;
      }
    }

    if (ownDiags >= 1 && ownNbrs === 1 && oppNbrs >= 1) {
      score += 1.6;
    }
    if (ownDiags >= 2 && ownNbrs === 0 && oppNbrs <= 1) {
      score += 1.25;
    }

    if (lastMoveIdx !== null && lastMoveIdx >= 0) {
      const lx = lastMoveIdx % size;
      const ly = (lastMoveIdx - lx) / size;
      const dx = Math.abs(x - lx);
      const dy = Math.abs(y - ly);
      const manhattan = dx + dy;
      if (manhattan === 1) score += 2.6;
      else if (dx === 1 && dy === 1) score += 2.0;
      else if (manhattan <= 3) score += 1.1;
    }

    if (minEdgeDist === 0) {
      if (isEarlyMid && captured === 0 && oppNbrs === 0) {
        score *= 0.08;
      } else if (captured === 0 && oppNbrs === 0) {
        score *= 0.4;
      }
    } else if (minEdgeDist === 1 && isOpening && captured === 0 && oppNbrs === 0) {
      score *= 0.32;
    } else if (isOpening) {
      if (size >= 13) {
        if ((distEdgeX === 2 || distEdgeX === 3) && (distEdgeY === 2 || distEdgeY === 3)) {
          score += 3.2;
        } else if (minEdgeDist === 2 || minEdgeDist === 3) {
          score += 1.6;
        }
      } else {
        if (minEdgeDist >= 2) score += 2.1;
      }
    }

    moves[count] = idx;
    weights[count] = Math.max(0.01, score);
    count++;
  }

  let sum = 0;
  for (let i = 0; i < count; i++) sum += weights[i];
  const priors = new Float32Array(count);
  if (sum > 0) {
    for (let i = 0; i < count; i++) priors[i] = weights[i] / sum;
  }

  return { moves: moves.subarray(0, count), priors, count };
}
