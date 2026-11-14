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

export type HeuristicLevel = 'novice' | 'elementary' | 'casual' | 'full' | 'master';

/**
 * Computes prior weights (urgency scores) for all legal candidate moves on `board` for `color`.
 * Incorporates graduated heuristic tiers (`heuristicLevel`) across 5 AI difficulties:
 * - 'novice' (Lv.1): Broad priors, relaxed self-atari guard, no advanced tactics/Fuseki
 * - 'elementary' (Lv.2): Basic adjacent stone & simple atari awareness, moderate self-atari guard
 * - 'casual' (Lv.3): Basic liberties/captures & mild star-point/shape preference without pro tactics
 * - 'full' (Lv.4): Full tactical priors (Snapback, Double Atari, Nakade, Tiger's Mouth, Empty Triangle, Fuseki, Ladder)
 * - 'master' (Lv.5): Full priors + stronger urgent-tactic, ladder-awareness, and connection weighting
 */
export function computeCandidateMovesAndPriors(params: {
  board: FastBoard;
  color: PlayerColor;
  lastMoveIdx: number | null;
  moveCount: number;
  forbiddenHashes?: Set<bigint>;
  enableAdvancedTactics?: boolean;
  heuristicLevel?: HeuristicLevel;
  skipLadder?: boolean;
}): { moves: Int16Array; priors: Float32Array; count: number } {
  const {
    board,
    color,
    lastMoveIdx,
    moveCount,
    forbiddenHashes,
    enableAdvancedTactics = false,
    skipLadder = false,
  } = params;
  const level: HeuristicLevel = params.heuristicLevel ?? (enableAdvancedTactics ? 'full' : 'casual');

  const isNovice = level === 'novice';
  const isElementary = level === 'elementary';
  const isCasual = level === 'casual';
  const isFull = level === 'full';
  const isMaster = level === 'master';
  const allowAdvancedTactics = isFull || isMaster;
  const allowLadder = allowAdvancedTactics && !skipLadder;

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

    // 1. Capture bonus (graduated by heuristic tier)
    if (captured > 0) {
      if (isNovice) score += 1.2 + captured * 0.8;
      else if (isElementary) score += 2.6 + captured * 1.6;
      else if (isCasual) score += 4.0 + captured * 2.4;
      else if (isFull) score += 9.5 + captured * 4.8;
      else score += 11.5 + captured * 5.5;
    }

    // 2. Check resulting liberty state & Snapback (환격)
    const afterOwn = sim.analyzeChain(idx, 4);
    let isSnapbackThrowIn = false;
    if (allowAdvancedTactics && afterOwn.libertyCount === 1 && afterOwn.stoneCount === 1 && captured === 0) {
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
      score += isMaster ? 10.5 : 8.5;
    } else if (afterOwn.libertyCount === 1) {
      if (captured === 0 && afterOwn.stoneCount >= 2) {
        if (isNovice) score *= 0.45;
        else if (isElementary) score *= 0.25;
        else if (isCasual) score *= 0.10;
        else if (isFull) score *= 0.03;
        else score *= 0.025;
      } else if (captured === 0) {
        if (isNovice) score *= 0.65;
        else if (isElementary) score *= 0.40;
        else if (isCasual) score *= 0.22;
        else if (isFull) score *= 0.12;
        else score *= 0.10;
      }
    } else if (afterOwn.libertyCount === 2 && allowLadder && afterOwn.stoneCount >= 2) {
      const ladderDepth = isMaster ? 24 : 20;
      if (isCapturedInLadder(sim, idx, opp, 0, ladderDepth)) {
        score *= isMaster ? 0.05 : 0.07;
      }
    }

    // 3. Atari defense, Double Atari (양단수), Net/Geta, & Ladder capture bonuses
    let ownNbrs = 0;
    let oppNbrs = 0;
    let atariOppChains = 0;
    let twoLibOppChains = 0;
    let maxBeforeOwnStones = 0;
    let firstAtariLib = -1;
    let secondAtariLib = -1;

    for (let i = 0; i < 4; i++) {
      const n = nbrs[i];
      if (n < 0) break;
      const nc = board.grid[n];
      if (nc === color) {
        ownNbrs++;
        const beforeChain = board.analyzeChain(n, 3);
        if (beforeChain.stoneCount > maxBeforeOwnStones) {
          maxBeforeOwnStones = beforeChain.stoneCount;
        }
        if (beforeChain.libertyCount === 1 && afterOwn.libertyCount >= 2) {
          if (isNovice) {
            score += 0.7;
          } else if (isElementary) {
            score += 2.4 + beforeChain.stoneCount * 1.0;
          } else if (isCasual) {
            score += 4.0 + beforeChain.stoneCount * 1.8;
          } else {
            const ladderDepth = isMaster ? 26 : 22;
            const trapped = allowLadder && isCapturedInLadder(sim, idx, opp, 0, ladderDepth);
            if (trapped) {
              score += isMaster ? -0.8 : -0.5;
            } else if (isMaster) {
              score += 7.0 + beforeChain.stoneCount * 3.4;
            } else {
              score += 5.8 + beforeChain.stoneCount * 2.8;
            }
          }
        }
      } else if (nc === opp) {
        oppNbrs++;
        if (sim.grid[n] === opp) {
          const oppAfter = sim.analyzeChain(n, 3);
          if (oppAfter.libertyCount === 1) {
            const lib0 = oppAfter.lib0;
            if (lib0 !== firstAtariLib && lib0 !== secondAtariLib) {
              if (firstAtariLib < 0) firstAtariLib = lib0;
              else if (secondAtariLib < 0) secondAtariLib = lib0;
              atariOppChains++;
            }
            if (isNovice) {
              score += 0.6;
            } else if (isElementary) {
              score += 1.1 + oppAfter.stoneCount * 0.4;
            } else if (isCasual) {
              score += 1.7 + oppAfter.stoneCount * 0.6;
            } else {
              const ladderDepth = isMaster ? 26 : 22;
              if (allowLadder && isCapturedInLadder(sim, n, opp, 0, ladderDepth)) {
                score += (isMaster ? 9.0 : 7.6) + oppAfter.stoneCount * (isMaster ? 3.5 : 3.0);
              } else {
                score += (isMaster ? 2.6 : 2.1) + oppAfter.stoneCount * (isMaster ? 0.9 : 0.75);
              }
            }
          } else if (oppAfter.libertyCount === 2) {
            twoLibOppChains++;
          }
        }
      }
    }

    if (isElementary && ownNbrs >= 1) {
      score += 0.65;
    } else if (isNovice && ownNbrs >= 1) {
      score += 0.25;
    }

    if (allowAdvancedTactics && atariOppChains >= 2) {
      score += isMaster ? 14.0 : 11.5; // Double Atari (양단수)!
    }

    // Nakade vital point (치중) when surrounded by opponent stones inside eye space
    if (allowAdvancedTactics && oppNbrs >= 3 && ownNbrs === 0 && captured === 0 && afterOwn.libertyCount >= 1) {
      score += isMaster ? 4.4 : 3.4;
    }

    // 4. Local 3x3 shape, Connection weighting & Empty Triangle penalty
    let ownDiags = 0;
    let oppDiags = 0;
    for (let i = 0; i < 4; i++) {
      const d = diags[i];
      if (d < 0) break;
      if (board.grid[d] === color) ownDiags++;
      else if (board.grid[d] === opp) oppDiags++;
    }

    // Extra bonus when capturing an opponent stone that helps stabilize/connect friendly stones around the point (incl. Ponnuki)
    if (allowAdvancedTactics && captured > 0 && ownDiags >= 1) {
      score += ownDiags >= 2 ? (isMaster ? 5.2 : 4.2) : (isMaster ? 2.2 : 1.7);
    }

    // Connection weighting: detects merging >= 2 distinct friendly chains
    const connectsDistinctChains = ownNbrs >= 2 && afterOwn.stoneCount > maxBeforeOwnStones + 1;
    if (allowAdvancedTactics && connectsDistinctChains) {
      if (oppNbrs >= 1 || oppDiags >= 1) {
        score += isMaster ? 3.2 : 1.6;
        if (isMaster && afterOwn.libertyCount >= 3) score += 0.9;
      } else {
        score += isMaster ? 1.3 : 0.7;
      }
    }

    if (allowAdvancedTactics) {
      // Net / Geta tactical surround: diagonally pinching a 2-liberty opponent chain
      if (twoLibOppChains >= 1 && ownDiags >= 1 && afterOwn.libertyCount >= 2) {
        score += isMaster ? 1.9 : 1.4;
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
          if (connectsDistinctChains && oppDiags >= 1) {
            score *= 0.82;
          } else {
            score *= isMaster ? 0.35 : 0.42;
          }
        }
      }

      // Tiger's mouth (호구) & Hane (젖힘) & Peep tension
      if (ownDiags >= 1 && ownNbrs === 1 && oppNbrs >= 1) {
        score += isMaster ? 2.2 : 1.75;
      }
      if (ownDiags >= 2 && ownNbrs === 0 && oppNbrs <= 1) {
        score += isMaster ? 1.65 : 1.35;
      }
      if (oppDiags >= 2 && ownNbrs === 0 && captured === 0) {
        score += isMaster ? 1.1 : 0.85;
      }
    } else if (isCasual) {
      // Mild casual-human shape preference (no Empty Triangle, no Net/Geta, no Peep)
      if (ownDiags >= 1 && ownNbrs === 1 && oppNbrs >= 1) {
        score += 0.8;
      }
      if (ownDiags >= 2 && ownNbrs === 0 && oppNbrs <= 1) {
        score += 0.6;
      }
    }

    // 5. Proximity to opponent's last move (응수 및 전투 집중성)
    if (lastMoveIdx !== null && lastMoveIdx >= 0) {
      const lx = lastMoveIdx % size;
      const ly = (lastMoveIdx - lx) / size;
      const dx = Math.abs(x - lx);
      const dy = Math.abs(y - ly);
      const manhattan = dx + dy;
      if (isNovice) {
        if (manhattan === 1) score += 0.8;
        else if (dx === 1 && dy === 1) score += 0.6;
        else if (manhattan <= 3) score += 0.35;
      } else if (isElementary) {
        if (manhattan === 1) score += 1.5;
        else if (dx === 1 && dy === 1) score += 1.1;
        else if (manhattan <= 3) score += 0.6;
      } else if (isCasual) {
        if (manhattan === 1) score += 2.1;
        else if (dx === 1 && dy === 1) score += 1.6;
        else if (manhattan <= 3) score += 0.85;
      } else if (isFull) {
        if (manhattan === 1) score += 2.75;
        else if (dx === 1 && dy === 1) score += 2.15;
        else if (manhattan <= 3) score += 1.15;
      } else {
        if (manhattan === 1) score += 3.1;
        else if (dx === 1 && dy === 1) score += 2.4;
        else if (manhattan <= 3) score += 1.3;
      }
    }

    // 6. Opening Fuseki Positional Knowledge (graduated by tier)
    if (isNovice) {
      // No Hoshi/Komoku Fuseki bias; only a gentle nudge off the 1st line when uncontested
      if (minEdgeDist === 0 && captured === 0 && oppNbrs === 0) {
        score *= 0.65;
      }
    } else if (isElementary) {
      // No Hoshi/Komoku Fuseki bias; mild early edge avoidance
      if (minEdgeDist === 0 && captured === 0 && oppNbrs === 0) {
        score *= isEarlyMid ? 0.45 : 0.75;
      }
    } else if (isCasual) {
      // Mild edge avoidance and mild star-point/interior preference without rigid Fuseki dominance
      if (minEdgeDist === 0) {
        if (isEarlyMid && captured === 0 && oppNbrs === 0) score *= 0.22;
        else if (captured === 0 && oppNbrs === 0) score *= 0.55;
      } else if (minEdgeDist === 1 && isOpening && captured === 0 && oppNbrs === 0) {
        score *= 0.55;
      } else if (isOpening) {
        if (size >= 13) {
          if ((distEdgeX === 2 || distEdgeX === 3) && (distEdgeY === 2 || distEdgeY === 3)) {
            score += 1.25;
          } else if ((minEdgeDist === 2 || minEdgeDist === 3) && maxEdgeDist >= 4) {
            score += 0.7;
          }
        } else if (minEdgeDist >= 2) {
          score += 0.9;
        }
      }
    } else {
      // 'full' & 'master': Full Fuseki principles
      if (minEdgeDist === 0) {
        if (isEarlyMid && captured === 0 && oppNbrs === 0) {
          score *= isMaster ? 0.05 : 0.06;
        } else if (captured === 0 && oppNbrs === 0) {
          score *= isMaster ? 0.32 : 0.36;
        }
      } else if (minEdgeDist === 1 && isOpening && captured === 0 && oppNbrs === 0) {
        score *= isMaster ? 0.25 : 0.28;
      } else if (isOpening) {
        if (size >= 13) {
          if ((distEdgeX === 2 || distEdgeX === 3) && (distEdgeY === 2 || distEdgeY === 3)) {
            score += isMaster ? 4.2 : 3.8; // Corner Hoshi (4-4), Komoku (3-4), San-san (3-3)
          } else if ((minEdgeDist === 2 || minEdgeDist === 3) && maxEdgeDist >= 4) {
            score += isMaster ? 2.1 : 1.95; // Side extension / enclosure
          }
        } else if (minEdgeDist >= 2) {
          score += isMaster ? 2.5 : 2.3;
        }
      }
    }

    let finalWeight = Math.max(0.01, score);
    if (isNovice) {
      finalWeight = Math.pow(Math.max(0.05, finalWeight), 0.42) + 0.35;
    } else if (isElementary) {
      finalWeight = Math.pow(Math.max(0.02, finalWeight), 0.65) + 0.12;
    } else if (isCasual) {
      finalWeight = Math.pow(finalWeight, 0.85);
    } else if (isMaster) {
      finalWeight = Math.pow(finalWeight, 1.12);
    }

    moves[count] = idx;
    weights[count] = finalWeight;
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
