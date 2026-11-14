import { BLACK, WHITE, EMPTY, PlayerColor, opponentColor } from '../rules/types';
import { FastBoard } from './FastBoard';

/**
 * Recursive tactical Ladder (축 / 장문) reader:
 * Determines if the chain containing `targetIdx` (which currently has 1 or 2 liberties)
 * can be forcibly captured when `attacker` plays to chase it, or if `defender` can escape to >= 3 liberties!
 */
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
  if (info.libertyCount >= 3) return false; // Escaped safely!
  if (info.libertyCount === 0) return true;
  if (depth >= maxDepth) return false;

  if (turnToMove === attacker) {
    if (info.libertyCount === 1) {
      // Attacker can immediately capture on lib0 if legal!
      const next = board.clone();
      if (next.play(info.lib0, attacker) >= 0) return true;
      return false;
    }
    // info.libertyCount === 2: try putting defender into atari on lib0 or lib1
    const candidates = [info.lib0, info.lib1];
    for (const move of candidates) {
      if (move < 0) continue;
      const next = board.clone();
      if (next.play(move, attacker) < 0) continue;
      // Check attacker's newly placed stone wasn't itself left in immediate 1-liberty self-atari without capturing
      const atkInfo = next.analyzeChain(move, 2);
      if (atkInfo.libertyCount >= 2) {
        if (isCapturedInLadder(next, targetIdx, defender, depth + 1, maxDepth)) {
          return true;
        }
      }
    }
    return false;
  } else {
    // Defender's turn to escape!
    // 1) Try capturing an adjacent 1-liberty attacker group to immediately gain liberties
    const visitedNbrs = new Set<number>();
    const size = board.size;
    for (let idx = 0; idx < board.total; idx++) {
      if (board.grid[idx] !== defender) continue;
      // Only inspect stones belonging to target chain? Quick check via neighbors of target if small, or analyze
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

    // 2) Try extending onto own liberties
    const libs = info.libertyCount === 1 ? [info.lib0] : [info.lib0, info.lib1];
    for (const move of libs) {
      if (move < 0) continue;
      const next = board.clone();
      if (next.play(move, defender) < 0) continue;
      if (!isCapturedInLadder(next, targetIdx, attacker, depth + 1, maxDepth)) {
        return false; // Defender escapes!
      }
    }
    return true;
  }
}

/**
 * Computes prior weights (urgency scores) for all legal candidate moves on `board` for `color`.
 * Incorporates:
 * - True eye protection (excludes true eyes)
 * - Self-atari & Ladder trap penalties
 * - Immediate capture & Atari escape bonuses
 * - Opening Fuseki principles (4-4 Hoshi, 3-4 Komoku, side extensions, avoiding 1st/2nd line early)
 * - Local 3x3 tactical & shape responses around `lastMoveIdx` (hane, block, tiger's mouth, cut/connect)
 */
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

  const sim = new FastBoard(size);
  const snapSim = new FastBoard(size);

  for (let idx = 0; idx < total; idx++) {
    if (board.grid[idx] !== EMPTY || idx === board.koIdx) continue;
    if (board.isTrueEye(idx, color)) continue;

    // Test move legality & resulting local tactics on a zero-alloc scratch copy
    sim.copyFrom(board);
    const captured = sim.play(idx, color, forbiddenHashes);
    if (captured < 0) continue;

    let score = 1.0;
    const x = idx % size;
    const y = (idx - x) / size;
    const distEdgeX = Math.min(x, size - 1 - x);
    const distEdgeY = Math.min(y, size - 1 - y);
    const minEdgeDist = Math.min(distEdgeX, distEdgeY);
    const maxEdgeDist = Math.max(distEdgeX, distEdgeY);

    const nbrs = board.getNeighborsOffset(idx);
    const diags = board.getDiagonalsOffset(idx);

    // 1. Capture bonus!
    if (captured > 0) {
      score += 4.8 + captured * 3.4;
    }

    // 2. Check resulting liberty state & Snapback (환격)
    const afterOwn = sim.analyzeChain(idx, 4);
    let isSnapbackThrowIn = false;
    if (afterOwn.libertyCount === 1 && afterOwn.stoneCount === 1 && captured === 0) {
      for (let i = 0; i < 4; i++) {
        const n = nbrs[i];
        if (n < 0) break;
        if (sim.grid[n] === opp) {
          const oppAtari = sim.analyzeChain(n, 2);
          if (oppAtari.libertyCount === 1 && oppAtari.stoneCount >= 2 && oppAtari.lib0 >= 0) {
            snapSim.copyFrom(sim);
            const oppCap = snapSim.play(oppAtari.lib0, opp);
            if (oppCap === 1 && snapSim.analyzeChain(oppAtari.lib0, 2).libertyCount === 1) {
              isSnapbackThrowIn = true;
              break;
            }
          }
        }
      }
    }

    if (isSnapbackThrowIn) {
      score += 8.2;
    } else if (afterOwn.libertyCount === 1) {
      if (captured === 0 && afterOwn.stoneCount >= 2) {
        score *= 0.03;
      } else if (captured === 0) {
        score *= 0.12;
      }
    } else if (afterOwn.libertyCount === 2 && enableAdvancedTactics && afterOwn.stoneCount >= 2) {
      if (isCapturedInLadder(sim, idx, opp, 0, 20)) {
        score *= 0.07;
      }
    }

    // 3. Atari defense, Double Atari (양단수), Net/Geta, & Ladder capture bonuses
    let ownNbrs = 0;
    let oppNbrs = 0;
    let atariOppChains = 0;
    let twoLibOppChains = 0;
    const seenAtariLibs = new Set<number>();

    for (let i = 0; i < 4; i++) {
      const n = nbrs[i];
      if (n < 0) break;
      const nc = board.grid[n];
      if (nc === color) {
        ownNbrs++;
        const beforeChain = board.analyzeChain(n, 3);
        if (beforeChain.libertyCount === 1 && afterOwn.libertyCount >= 2) {
          const trapped = enableAdvancedTactics && isCapturedInLadder(sim, idx, opp, 0, 22);
          score += trapped ? -0.5 : 5.4 + beforeChain.stoneCount * 2.6;
        }
      } else if (nc === opp) {
        oppNbrs++;
        if (sim.grid[n] === opp) {
          const oppAfter = sim.analyzeChain(n, 3);
          if (oppAfter.libertyCount === 1) {
            if (!seenAtariLibs.has(oppAfter.lib0)) {
              seenAtariLibs.add(oppAfter.lib0);
              atariOppChains++;
            }
            if (enableAdvancedTactics && isCapturedInLadder(sim, n, opp, 0, 22)) {
              score += 7.2 + oppAfter.stoneCount * 3.0;
            } else {
              score += 2.1 + oppAfter.stoneCount * 0.75;
            }
          } else if (oppAfter.libertyCount === 2) {
            twoLibOppChains++;
          }
        }
      }
    }

    if (atariOppChains >= 2) {
      score += 11.5; // Double Atari (양단수)!
    }

    // Nakade vital point (치중) when surrounded by opponent stones inside eye space
    if (oppNbrs >= 3 && ownNbrs === 0 && captured === 0 && afterOwn.libertyCount >= 1) {
      score += 3.2;
    }

    // 4. Local 3x3 shape & Empty Triangle penalty
    let ownDiags = 0;
    let oppDiags = 0;
    for (let i = 0; i < 4; i++) {
      const d = diags[i];
      if (d < 0) break;
      if (board.grid[d] === color) ownDiags++;
      else if (board.grid[d] === opp) oppDiags++;
    }

    // Net / Geta tactical surround: diagonally pinching a 2-liberty opponent chain
    if (twoLibOppChains >= 1 && ownDiags >= 1 && afterOwn.libertyCount >= 2) {
      score += 1.4;
    }

    // Empty triangle check (우형 빈삼각 감점)
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
        score *= 0.42;
      }
    }

    // Tiger's mouth (호구) & Hane (젖힘) & Cut protection bonuses
    if (ownDiags >= 1 && ownNbrs === 1 && oppNbrs >= 1) {
      score += 1.75;
    }
    if (ownDiags >= 2 && ownNbrs === 0 && oppNbrs <= 1) {
      score += 1.35;
    }
    if (oppDiags >= 2 && ownNbrs === 0 && captured === 0) {
      score += 0.85; // Peep / Wedge shape tension
    }

    // 5. Proximity to opponent's last move (응수 및 전투 집중성)
    if (lastMoveIdx !== null && lastMoveIdx >= 0) {
      const lx = lastMoveIdx % size;
      const ly = (lastMoveIdx - lx) / size;
      const dx = Math.abs(x - lx);
      const dy = Math.abs(y - ly);
      const manhattan = dx + dy;
      if (manhattan === 1) score += 2.75;
      else if (dx === 1 && dy === 1) score += 2.15;
      else if (manhattan <= 3) score += 1.15;
    }

    // 6. Opening Fuseki Positional Knowledge (귀·변 우선, 1선·2선 조기 착수 억제)
    if (minEdgeDist === 0) {
      if (isEarlyMid && captured === 0 && oppNbrs === 0) {
        score *= 0.06;
      } else if (captured === 0 && oppNbrs === 0) {
        score *= 0.36;
      }
    } else if (minEdgeDist === 1 && isOpening && captured === 0 && oppNbrs === 0) {
      score *= 0.28;
    } else if (isOpening) {
      if (size >= 13) {
        if ((distEdgeX === 2 || distEdgeX === 3) && (distEdgeY === 2 || distEdgeY === 3)) {
          score += 3.6; // Corner Hoshi (4-4), Komoku (3-4), San-san (3-3)
        } else if ((minEdgeDist === 2 || minEdgeDist === 3) && maxEdgeDist >= 4) {
          score += 1.85; // Side extension / enclosure
        }
      } else {
        if (minEdgeDist >= 2) score += 2.3;
      }
    }

    moves[count] = idx;
    weights[count] = Math.max(0.01, score);
    count++;
  }

  // Normalize weights into probability distribution (sum = 1)
  let sum = 0;
  for (let i = 0; i < count; i++) sum += weights[i];
  const priors = new Float32Array(count);
  if (sum > 0) {
    for (let i = 0; i < count; i++) priors[i] = weights[i] / sum;
  }

  return { moves: moves.subarray(0, count), priors, count };
}
