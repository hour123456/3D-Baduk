import {
  AIDifficulty,
  BLACK,
  BoardSize,
  Coord,
  EMPTY,
  OmokRulesetType,
  opponentColor,
  PlayerColor,
  WHITE,
} from '../rules/types';
import { checkRenjuForbidden, checkWinAt } from '../rules/GomokuEngine';
import { computeBoardHash, stoneZobristKey } from '../rules/zobrist';
import type { AISearchRequest, AISearchResult, AISuggestion } from './MctsEngine';

interface GomokuProfile {
  maxDepth: number;
  timeBudgetMs: number;
  maxCandidates: number;
  enableVcf: boolean;
  vcfDepth: number;
  noiseRange: number;
}

const GOMOKU_PROFILES: Record<AIDifficulty, GomokuProfile> = {
  1: {
    maxDepth: 1,
    timeBudgetMs: 90,
    maxCandidates: 10,
    enableVcf: false,
    vcfDepth: 0,
    noiseRange: 1400,
  },
  2: {
    maxDepth: 2,
    timeBudgetMs: 180,
    maxCandidates: 14,
    enableVcf: false,
    vcfDepth: 0,
    noiseRange: 260,
  },
  3: {
    maxDepth: 4,
    timeBudgetMs: 420,
    maxCandidates: 18,
    enableVcf: false,
    vcfDepth: 0,
    noiseRange: 40,
  },
  4: {
    maxDepth: 6,
    timeBudgetMs: 850,
    maxCandidates: 20,
    enableVcf: true,
    vcfDepth: 10,
    noiseRange: 0,
  },
  5: {
    maxDepth: 8,
    timeBudgetMs: 1450,
    maxCandidates: 22,
    enableVcf: true,
    vcfDepth: 16,
    noiseRange: 0,
  },
};

const AXES: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

const WIN_SCORE = 1_000_000;
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;

interface TTEntry {
  depth: number;
  flag: number;
  score: number;
  bestMove: number;
}

function inBounds(size: number, x: number, y: number): boolean {
  return x >= 0 && x < size && y >= 0 && y < size;
}

/**
 * Evaluates a single axis (dx, dy) around (x, y) assuming color is placed there,
 * returning tactical pattern strength (used both for candidate ordering and fast board eval).
 */
function scorePointOnAxis(
  board: Uint8Array,
  size: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: PlayerColor
): { count: number; openEnds: number; gapCount: number; jumpSpan: number } {
  let count = 1;
  let openEnds = 0;
  let gapCount = 0;

  let posCount = 0;
  let negCount = 0;

  // Forward scan (allow at most 1 single-cell empty jump)
  let cx = x + dx;
  let cy = y + dy;
  let usedGap = false;
  while (inBounds(size, cx, cy)) {
    const c = board[cy * size + cx];
    if (c === color) {
      posCount++;
      cx += dx;
      cy += dy;
    } else if (c === EMPTY) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!usedGap && gapCount === 0 && inBounds(size, nx, ny) && board[ny * size + nx] === color) {
        usedGap = true;
        gapCount++;
        cx = nx;
        cy = ny;
      } else {
        openEnds++;
        break;
      }
    } else {
      break;
    }
  }

  // Backward scan
  cx = x - dx;
  cy = y - dy;
  usedGap = false;
  while (inBounds(size, cx, cy)) {
    const c = board[cy * size + cx];
    if (c === color) {
      negCount++;
      cx -= dx;
      cy -= dy;
    } else if (c === EMPTY) {
      const nx = cx - dx;
      const ny = cy - dy;
      if (!usedGap && gapCount === 0 && inBounds(size, nx, ny) && board[ny * size + nx] === color) {
        usedGap = true;
        gapCount++;
        cx = nx;
        cy = ny;
      } else {
        openEnds++;
        break;
      }
    } else {
      break;
    }
  }

  count += posCount + negCount;
  return { count, openEnds, gapCount, jumpSpan: gapCount };
}

function classifyPatternWeight(count: number, openEnds: number, hasGap: boolean): number {
  if (count >= 5 && !hasGap) return 240_000;
  if (count >= 4) {
    if (!hasGap && openEnds === 2) return 45_000;
    if (openEnds >= 1 || hasGap) return 8_500;
  }
  if (count === 3) {
    if (openEnds === 2) return hasGap ? 5_200 : 6_800;
    if (openEnds === 1) return 680;
  }
  if (count === 2) {
    if (openEnds === 2) return hasGap ? 220 : 340;
    if (openEnds === 1) return 48;
  }
  return 10;
}

function scoreLocalPlacement(
  board: Uint8Array,
  size: number,
  x: number,
  y: number,
  color: PlayerColor,
  opp: PlayerColor,
  ruleset: OmokRulesetType
): number {
  let attack = 0;
  let defense = 0;
  const center = (size - 1) * 0.5;
  const centerBonus = 24 - (Math.abs(x - center) + Math.abs(y - center)) * 1.4;

  let ownThrees = 0;
  let ownFours = 0;

  for (const [dx, dy] of AXES) {
    const atk = scorePointOnAxis(board, size, x, y, dx, dy, color);
    if (atk.count === 3 && atk.openEnds === 2) ownThrees++;
    if (atk.count === 4 && (atk.openEnds >= 1 || atk.gapCount > 0)) ownFours++;
    attack += classifyPatternWeight(atk.count, atk.openEnds, atk.gapCount > 0);

    // Evaluate how blocking here disrupts opponent's potential line
    const def = scorePointOnAxis(board, size, x, y, dx, dy, opp);
    // In Renju, White ignores points that would merely complete an illegal Black 3-3/overline unless exact 5
    defense += classifyPatternWeight(def.count, def.openEnds, def.gapCount > 0) * 0.92;
  }

  if (ownFours >= 1 && ownThrees >= 1) attack += 22_000; // 4-3 winning fork!
  if (ownFours >= 2 && !(color === BLACK && ruleset === 'renju')) attack += 24_000;
  if (ownThrees >= 2 && !(color === BLACK && ruleset === 'renju')) attack += 14_000;

  return attack + defense + centerBonus;
}

/**
 * Full-board static heuristic score from `perspective` point of view.
 */
function evaluateBoard(
  board: Uint8Array,
  size: number,
  perspective: PlayerColor,
  turnToMove: PlayerColor,
  ruleset: OmokRulesetType
): number {
  let myScore = 0;
  let oppScore = 0;
  const opp = opponentColor(perspective);

  const scoreLine = (color: PlayerColor, runLen: number, openBefore: boolean, openAfter: boolean): number => {
    if (runLen <= 0) return 0;
    const isExactFive = runLen === 5;
    const isOverline = runLen >= 6;
    if (isExactFive) return WIN_SCORE * 0.5;
    if (isOverline) {
      if (color === BLACK && ruleset === 'renju') return 0;
      return WIN_SCORE * 0.5;
    }

    const openEnds = (openBefore ? 1 : 0) + (openAfter ? 1 : 0);
    if (openEnds === 0) return 0;

    const turnBoost = color === turnToMove ? 1.45 : 1.0;
    if (runLen === 4) {
      return (openEnds === 2 ? 65_000 : 12_000) * turnBoost;
    }
    if (runLen === 3) {
      return (openEnds === 2 ? 7_200 : 850) * turnBoost;
    }
    if (runLen === 2) {
      return (openEnds === 2 ? 320 : 52) * turnBoost;
    }
    return openEnds === 2 ? 18 : 4;
  };

  // Scan all 4 directions across the grid (each cell-axis visited linearly)
  const seenDirections = (dx: number, dy: number, startX: number, startY: number) => {
    let x = startX;
    let y = startY;
    while (inBounds(size, x, y)) {
      const cell = board[y * size + x];
      if (cell === EMPTY) {
        x += dx;
        y += dy;
        continue;
      }
      const color = cell as PlayerColor;
      const px = x - dx;
      const py = y - dy;
      const openBefore = inBounds(size, px, py) && board[py * size + px] === EMPTY;

      let runLen = 0;
      while (inBounds(size, x, y) && board[y * size + x] === color) {
        runLen++;
        x += dx;
        y += dy;
      }
      const openAfter = inBounds(size, x, y) && board[y * size + x] === EMPTY;

      const pts = scoreLine(color, runLen, openBefore, openAfter);
      if (color === perspective) myScore += pts;
      else oppScore += pts;
    }
  };

  // Horizontal
  for (let y = 0; y < size; y++) seenDirections(1, 0, 0, y);
  // Vertical
  for (let x = 0; x < size; x++) seenDirections(0, 1, x, 0);
  // Diagonal down-right
  for (let x = 0; x < size; x++) seenDirections(1, 1, x, 0);
  for (let y = 1; y < size; y++) seenDirections(1, 1, 0, y);
  // Diagonal up-right
  for (let x = 0; x < size; x++) seenDirections(1, -1, x, size - 1);
  for (let y = size - 2; y >= 0; y--) seenDirections(1, -1, 0, y);

  return myScore - oppScore * 1.06;
}

export class GomokuAI {
  private tt = new Map<bigint, TTEntry>();

  public chooseMove(req: AISearchRequest): AISearchResult {
    const startTime = performance.now();
    this.tt.clear();

    const size: BoardSize = req.size === 19 || req.size === 15 ? req.size : 15;
    const ruleset: OmokRulesetType = req.omokRuleset ?? 'renju';
    const aiColor = req.color;
    const oppColor = opponentColor(aiColor);
    const profile = GOMOKU_PROFILES[req.difficulty];

    const board = new Uint8Array(req.board);
    const center = Math.floor(size / 2);

    // 1. Empty board opening: play Tengen (center)
    let stoneCount = 0;
    const total = size * size;
    for (let i = 0; i < total; i++) {
      if (board[i] !== EMPTY) stoneCount++;
    }
    if (stoneCount === 0) {
      return {
        coord: { x: center, y: center },
        winrate: 0.54,
        simulations: 1,
        elapsedMs: performance.now() - startTime,
        topSuggestions: [{ coord: { x: center, y: center }, winrate: 0.54, visits: 1 }],
      };
    }

    const candidates = this.generateCandidates(board, size, aiColor, ruleset, 40);
    if (candidates.length === 0) {
      return {
        coord: null,
        winrate: 0.5,
        simulations: 0,
        elapsedMs: performance.now() - startTime,
      };
    }

    // 2. Check immediate winning 5 moves for AI
    for (const c of candidates) {
      if (checkWinAt(board, size, c.x, c.y, aiColor, ruleset).won) {
        return {
          coord: { x: c.x, y: c.y },
          winrate: 0.995,
          simulations: 1,
          elapsedMs: performance.now() - startTime,
          topSuggestions: [{ coord: { x: c.x, y: c.y }, winrate: 0.995, visits: 1 }],
        };
      }
    }

    // 3. Check urgent opponent immediate winning 5 moves
    const urgentBlocks = this.findImmediateWins(board, size, oppColor, ruleset);
    if (urgentBlocks.length === 1) {
      const bIdx = urgentBlocks[0];
      const bx = bIdx % size;
      const by = (bIdx - bx) / size;
      // Only block if it is legal for AI (e.g. if Renju Black can't play a forbidden square to block, pick fallback)
      const isForbiddenBlock = aiColor === BLACK && ruleset === 'renju' && checkRenjuForbidden(board, size, bx, by).forbidden;
      if (!isForbiddenBlock) {
        return {
          coord: { x: bx, y: by },
          winrate: 0.42,
          simulations: 2,
          elapsedMs: performance.now() - startTime,
          topSuggestions: [{ coord: { x: bx, y: by }, winrate: 0.42, visits: 2 }],
        };
      }
    }

    // 4. Straight Open Four attack for AI (instant win unless opponent had an ignored immediate 5)
    if (urgentBlocks.length === 0) {
      for (const c of candidates) {
        if (this.createsStraightOpenFour(board, size, c.x, c.y, aiColor, ruleset)) {
          return {
            coord: { x: c.x, y: c.y },
            winrate: 0.97,
            simulations: 4,
            elapsedMs: performance.now() - startTime,
            topSuggestions: [{ coord: { x: c.x, y: c.y }, winrate: 0.97, visits: 4 }],
          };
        }
      }
    }

    // 5. VCF (Victory by Continuous Fours) for Lv.4 and Lv.5
    let nodesVisited = 0;
    const deadline = startTime + profile.timeBudgetMs;
    if (profile.enableVcf && urgentBlocks.length === 0) {
      const vcfMove = this.searchVcf(board, size, aiColor, ruleset, profile.vcfDepth, deadline);
      if (vcfMove >= 0) {
        const vx = vcfMove % size;
        const vy = (vcfMove - vx) / size;
        return {
          coord: { x: vx, y: vy },
          winrate: 0.96,
          simulations: 40,
          elapsedMs: performance.now() - startTime,
          topSuggestions: [{ coord: { x: vx, y: vy }, winrate: 0.96, visits: 40 }],
        };
      }
    }

    // Filter root candidates if urgent opponent 5-threats exist
    const searchPool =
      urgentBlocks.length > 1
        ? candidates.filter((c) => urgentBlocks.includes(c.idx))
        : candidates.slice(0, profile.maxCandidates);
    const activeCandidates = searchPool.length > 0 ? searchPool : candidates.slice(0, profile.maxCandidates);

    // 6. Lv.1 noisy novice choice (with basic win/block awareness already handled!)
    if (req.difficulty === 1) {
      const topK = activeCandidates.slice(0, Math.min(5, activeCandidates.length));
      let bestMove = topK[0];
      let bestNoisy = -Infinity;
      const scoredSuggestions: AISuggestion[] = topK.slice(0, 3).map((m) => ({
        coord: { x: m.x, y: m.y },
        winrate: this.scoreToWinrate(m.heuristic * 0.25),
        visits: Math.max(1, Math.round(m.heuristic / 100)),
      }));

      for (const m of topK) {
        const val = m.heuristic + (Math.random() - 0.5) * profile.noiseRange * 2;
        if (val > bestNoisy) {
          bestNoisy = val;
          bestMove = m;
        }
      }
      return {
        coord: { x: bestMove.x, y: bestMove.y },
        winrate: this.scoreToWinrate(bestMove.heuristic * 0.2),
        simulations: topK.length,
        elapsedMs: performance.now() - startTime,
        topSuggestions: scoredSuggestions,
      };
    }

    // 7. Iterative Deepening Alpha-Beta with Transposition Table
    let hash = computeBoardHash(board, size);
    const moveScores = new Map<number, number>();
    for (const c of activeCandidates) moveScores.set(c.idx, c.heuristic);

    let bestCoord: Coord = { x: activeCandidates[0].x, y: activeCandidates[0].y };
    let bestRootScore = -Infinity;

    for (let depth = 1; depth <= profile.maxDepth; depth++) {
      if (performance.now() >= deadline && depth > 2) break;

      // Order root candidates by previous iteration's scores
      activeCandidates.sort((a, b) => (moveScores.get(b.idx) ?? 0) - (moveScores.get(a.idx) ?? 0));

      let iterBestIdx = activeCandidates[0].idx;
      let iterBestScore = -Infinity;
      let alpha = -Infinity;
      const beta = Infinity;
      let aborted = false;

      for (let i = 0; i < activeCandidates.length; i++) {
        if (performance.now() >= deadline && depth > 2) {
          aborted = true;
          break;
        }
        const c = activeCandidates[i];
        board[c.idx] = aiColor;
        hash ^= stoneZobristKey(c.idx, aiColor);

        let score: number;
        if (checkWinAt(board, size, c.x, c.y, aiColor, ruleset).won) {
          score = WIN_SCORE - 1;
        } else {
          const res = this.alphaBeta(
            board,
            size,
            hash,
            depth - 1,
            alpha,
            beta,
            false,
            aiColor,
            oppColor,
            ruleset,
            profile.maxCandidates,
            deadline,
            () => {
              nodesVisited++;
            }
          );
          if (res.aborted) {
            board[c.idx] = EMPTY;
            hash ^= stoneZobristKey(c.idx, aiColor);
            aborted = true;
            break;
          }
          score = res.score;
        }

        board[c.idx] = EMPTY;
        hash ^= stoneZobristKey(c.idx, aiColor);

        moveScores.set(c.idx, score);
        if (score > iterBestScore) {
          iterBestScore = score;
          iterBestIdx = c.idx;
        }
        if (score > alpha) alpha = score;
      }

      if (!aborted) {
        bestRootScore = iterBestScore;
        bestCoord = { x: iterBestIdx % size, y: (iterBestIdx - (iterBestIdx % size)) / size };
        if (bestRootScore >= WIN_SCORE - 50) break;
      }
    }

    // Small organic variety for Lv.2
    if (profile.noiseRange > 0 && activeCandidates.length > 1 && bestRootScore < WIN_SCORE * 0.3) {
      const noisySorted = activeCandidates
        .slice(0, 4)
        .map((c) => ({
          c,
          v: (moveScores.get(c.idx) ?? 0) + (Math.random() - 0.5) * profile.noiseRange,
        }))
        .sort((a, b) => b.v - a.v);
      bestCoord = { x: noisySorted[0].c.x, y: noisySorted[0].c.y };
    }

    const sortedFinal = activeCandidates
      .slice()
      .sort((a, b) => (moveScores.get(b.idx) ?? 0) - (moveScores.get(a.idx) ?? 0))
      .slice(0, 3);

    const topSuggestions: AISuggestion[] = sortedFinal.map((c, i) => ({
      coord: { x: c.x, y: c.y },
      winrate: this.scoreToWinrate(moveScores.get(c.idx) ?? 0),
      visits: Math.max(10, Math.round(nodesVisited / (i + 1.5))),
    }));

    return {
      coord: bestCoord,
      winrate: this.scoreToWinrate(bestRootScore === -Infinity ? 0 : bestRootScore),
      simulations: Math.max(1, nodesVisited),
      elapsedMs: performance.now() - startTime,
      topSuggestions,
    };
  }

  private scoreToWinrate(score: number): number {
    if (score >= WIN_SCORE * 0.4) return 0.98;
    if (score <= -WIN_SCORE * 0.4) return 0.02;
    const raw = 1 / (1 + Math.exp(-score / 5500));
    return Math.max(0.03, Math.min(0.97, raw));
  }

  private generateCandidates(
    board: Uint8Array,
    size: BoardSize,
    color: PlayerColor,
    ruleset: OmokRulesetType,
    limit: number
  ): Array<{ idx: number; x: number; y: number; heuristic: number }> {
    const opp = opponentColor(color);
    const total = size * size;
    const nearMask = new Uint8Array(total);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (board[y * size + x] === EMPTY) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (inBounds(size, nx, ny)) {
              const nIdx = ny * size + nx;
              if (board[nIdx] === EMPTY) nearMask[nIdx] = 1;
            }
          }
        }
      }
    }

    const candidates: Array<{ idx: number; x: number; y: number; heuristic: number }> = [];
    for (let idx = 0; idx < total; idx++) {
      if (!nearMask[idx]) continue;
      const x = idx % size;
      const y = (idx - x) / size;

      if (color === BLACK && ruleset === 'renju' && checkRenjuForbidden(board, size, x, y).forbidden) {
        continue;
      }

      const heuristic = scoreLocalPlacement(board, size, x, y, color, opp, ruleset);
      candidates.push({ idx, x, y, heuristic });
    }

    candidates.sort((a, b) => b.heuristic - a.heuristic);
    return candidates.length > limit ? candidates.slice(0, limit) : candidates;
  }

  private findImmediateWins(
    board: Uint8Array,
    size: BoardSize,
    color: PlayerColor,
    ruleset: OmokRulesetType
  ): number[] {
    const wins: number[] = [];
    const total = size * size;
    for (let idx = 0; idx < total; idx++) {
      if (board[idx] !== EMPTY) continue;
      const x = idx % size;
      const y = (idx - x) / size;
      if (!this.hasAdjacentSameColorWithin4(board, size, x, y, color)) continue;
      if (checkWinAt(board, size, x, y, color, ruleset).won) {
        if (color === BLACK && ruleset === 'renju') {
          // Exact 5 is already verified by checkWinAt returning won: true
          wins.push(idx);
        } else {
          wins.push(idx);
        }
      }
    }
    return wins;
  }

  private hasAdjacentSameColorWithin4(
    board: Uint8Array,
    size: number,
    x: number,
    y: number,
    color: PlayerColor
  ): boolean {
    for (const [dx, dy] of AXES) {
      for (const s of [-1, 1]) {
        const nx = x + dx * s;
        const ny = y + dy * s;
        if (inBounds(size, nx, ny) && board[ny * size + nx] === color) return true;
      }
    }
    return false;
  }

  private createsStraightOpenFour(
    board: Uint8Array,
    size: number,
    x: number,
    y: number,
    color: PlayerColor,
    ruleset: OmokRulesetType
  ): boolean {
    const idx = y * size + x;
    board[idx] = color;
    let isOpenFour = false;
    try {
      for (const [dx, dy] of AXES) {
        const info = scorePointOnAxis(board, size, x, y, dx, dy, color);
        if (info.count === 4 && info.gapCount === 0 && info.openEnds === 2) {
          if (color === BLACK && ruleset === 'renju') {
            // Confirm both endpoints extend to exact 5 (no overline)
            let forwardSteps = 1;
            while (
              inBounds(size, x + dx * forwardSteps, y + dy * forwardSteps) &&
              board[(y + dy * forwardSteps) * size + (x + dx * forwardSteps)] === color
            ) {
              forwardSteps++;
            }
            const end1x = x + dx * forwardSteps;
            const end1y = y + dy * forwardSteps;
            let backSteps = 1;
            while (
              inBounds(size, x - dx * backSteps, y - dy * backSteps) &&
              board[(y - dy * backSteps) * size + (x - dx * backSteps)] === color
            ) {
              backSteps++;
            }
            const end2x = x - dx * backSteps;
            const end2y = y - dy * backSteps;
            if (
              checkWinAt(board, size, end1x, end1y, BLACK, ruleset).won &&
              checkWinAt(board, size, end2x, end2y, BLACK, ruleset).won
            ) {
              isOpenFour = true;
              break;
            }
          } else {
            isOpenFour = true;
            break;
          }
        }
      }
    } finally {
      board[idx] = EMPTY;
    }
    return isOpenFour;
  }

  /**
   * Victory by Continuous Fours (VCF) solver: tests whether `attacker` can force a win using only Four threats.
   */
  private searchVcf(
    board: Uint8Array,
    size: BoardSize,
    attacker: PlayerColor,
    ruleset: OmokRulesetType,
    depth: number,
    deadline: number
  ): number {
    if (depth <= 0 || performance.now() >= deadline) return -1;

    const defender = opponentColor(attacker);
    const total = size * size;

    // 1. Immediate winning 5 for attacker
    for (let idx = 0; idx < total; idx++) {
      if (board[idx] !== EMPTY) continue;
      const x = idx % size;
      const y = (idx - x) / size;
      if (!this.hasAdjacentSameColorWithin4(board, size, x, y, attacker)) continue;
      if (checkWinAt(board, size, x, y, attacker, ruleset).won) {
        return idx;
      }
    }

    // 2. Find all empty squares where attacker creates a Four (forcing defender to block the exact-5 square)
    const candidates = this.generateCandidates(board, size, attacker, ruleset, 24);
    for (const c of candidates) {
      board[c.idx] = attacker;

      // Check how many immediate 5 wins `attacker` now threatens
      const replyWins = this.findImmediateWins(board, size, attacker, ruleset);
      if (replyWins.length >= 2) {
        // Double threat -> Unstoppable VCF!
        board[c.idx] = EMPTY;
        return c.idx;
      }

      if (replyWins.length === 1) {
        const blockIdx = replyWins[0];
        const bx = blockIdx % size;
        const by = (blockIdx - bx) / size;

        // If Renju rules forbid Defender (BLACK) from playing the block square, Attacker wins immediately!
        if (defender === BLACK && ruleset === 'renju' && checkRenjuForbidden(board, size, bx, by).forbidden) {
          board[c.idx] = EMPTY;
          return c.idx;
        }

        // Check defender counter-5 before continuing VCF
        board[blockIdx] = defender;
        const defenderWonByBlocking = checkWinAt(board, size, bx, by, defender, ruleset).won;
        if (!defenderWonByBlocking) {
          const next = this.searchVcf(board, size, attacker, ruleset, depth - 1, deadline);
          if (next >= 0) {
            board[blockIdx] = EMPTY;
            board[c.idx] = EMPTY;
            return c.idx;
          }
        }
        board[blockIdx] = EMPTY;
      }

      board[c.idx] = EMPTY;
    }

    return -1;
  }

  private alphaBeta(
    board: Uint8Array,
    size: BoardSize,
    hash: bigint,
    depth: number,
    alpha: number,
    beta: number,
    maximizing: boolean,
    aiColor: PlayerColor,
    oppColor: PlayerColor,
    ruleset: OmokRulesetType,
    maxCandidates: number,
    deadline: number,
    onNode: () => void
  ): { score: number; aborted: boolean } {
    onNode();
    if (performance.now() >= deadline) {
      return { score: 0, aborted: true };
    }

    const alphaOrig = alpha;
    const cached = this.tt.get(hash);
    if (cached && cached.depth >= depth) {
      if (cached.flag === TT_EXACT) return { score: cached.score, aborted: false };
      if (cached.flag === TT_LOWER && cached.score > alpha) alpha = cached.score;
      else if (cached.flag === TT_UPPER && cached.score < beta) beta = cached.score;
      if (alpha >= beta) return { score: cached.score, aborted: false };
    }

    const turnColor = maximizing ? aiColor : oppColor;
    if (depth <= 0) {
      return {
        score: evaluateBoard(board, size, aiColor, turnColor, ruleset),
        aborted: false,
      };
    }

    const candidates = this.generateCandidates(board, size, turnColor, ruleset, maxCandidates);
    if (candidates.length === 0) {
      return { score: 0, aborted: false };
    }

    // Prioritize TT best move first for maximal beta cutoffs
    if (cached && cached.bestMove >= 0) {
      const idxPos = candidates.findIndex((c) => c.idx === cached.bestMove);
      if (idxPos > 0) {
        const [hit] = candidates.splice(idxPos, 1);
        candidates.unshift(hit);
      }
    }

    let bestScore = maximizing ? -Infinity : Infinity;
    let bestMove = candidates[0].idx;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (checkWinAt(board, size, c.x, c.y, turnColor, ruleset).won) {
        const winVal = maximizing ? WIN_SCORE - (10 - depth) : -(WIN_SCORE - (10 - depth));
        this.storeTT(hash, depth, TT_EXACT, winVal, c.idx);
        return { score: winVal, aborted: false };
      }

      board[c.idx] = turnColor;
      const nextHash = hash ^ stoneZobristKey(c.idx, turnColor);
      const childRes = this.alphaBeta(
        board,
        size,
        nextHash,
        depth - 1,
        alpha,
        beta,
        !maximizing,
        aiColor,
        oppColor,
        ruleset,
        maxCandidates,
        deadline,
        onNode
      );
      board[c.idx] = EMPTY;

      if (childRes.aborted) {
        return { score: 0, aborted: true };
      }

      if (maximizing) {
        if (childRes.score > bestScore) {
          bestScore = childRes.score;
          bestMove = c.idx;
        }
        if (bestScore > alpha) alpha = bestScore;
        if (alpha >= beta) break;
      } else {
        if (childRes.score < bestScore) {
          bestScore = childRes.score;
          bestMove = c.idx;
        }
        if (bestScore < beta) beta = bestScore;
        if (alpha >= beta) break;
      }
    }

    let flag = TT_EXACT;
    if (bestScore <= alphaOrig) flag = TT_UPPER;
    else if (bestScore >= beta) flag = TT_LOWER;
    this.storeTT(hash, depth, flag, bestScore, bestMove);

    return { score: bestScore, aborted: false };
  }

  private storeTT(hash: bigint, depth: number, flag: number, score: number, bestMove: number): void {
    if (this.tt.size > 120_000) {
      this.tt.clear();
    }
    this.tt.set(hash, { depth, flag, score, bestMove });
  }
}
