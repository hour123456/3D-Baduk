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
  useOpenFourShortcut: boolean;
  immediateWinProb: number;
  urgentBlockProb: number;
  open3DefenseMult: number;
  forkWeightMult: number;
  useSplitPatterns: boolean;
  useOpponentVcfDefense: boolean;
  casualLapseProb: number;
}

interface EvalTuning {
  open3DefenseMult: number;
  forkWeightMult: number;
  useSplitPatterns: boolean;
}

const GOMOKU_PROFILES: Record<AIDifficulty, GomokuProfile> = {
  1: {
    // 입문: 규칙 익히기 수준 — 단발성 수읽기, 즉승/즉패도 가끔 놓치며 큰 노이즈 허용
    maxDepth: 0,
    timeBudgetMs: 80,
    maxCandidates: 14,
    enableVcf: false,
    vcfDepth: 0,
    noiseRange: 26_000,
    useOpenFourShortcut: false,
    immediateWinProb: 0.65,
    urgentBlockProb: 0.3,
    open3DefenseMult: 0.35,
    forkWeightMult: 0.2,
    useSplitPatterns: false,
    useOpponentVcfDefense: false,
    casualLapseProb: 0,
  },
  2: {
    // 초급: 1수 앞 형세만 보며 3 방어가 헐겁고 실수를 섞어 일반인도 쉽게 승리 가능
    maxDepth: 1,
    timeBudgetMs: 160,
    maxCandidates: 11,
    enableVcf: false,
    vcfDepth: 0,
    noiseRange: 5_200,
    useOpenFourShortcut: false,
    immediateWinProb: 1.0,
    urgentBlockProb: 1.0,
    open3DefenseMult: 0.52,
    forkWeightMult: 0.25,
    useSplitPatterns: false,
    useOpponentVcfDefense: false,
    casualLapseProb: 0,
  },
  3: {
    // 중급: 2수 얕은 수읽기와 제한된 후보수로 기본 응수는 하되 복수 위협/빈틈은 허용
    maxDepth: 2,
    timeBudgetMs: 320,
    maxCandidates: 9,
    enableVcf: false,
    vcfDepth: 0,
    noiseRange: 2_600,
    useOpenFourShortcut: false,
    immediateWinProb: 1.0,
    urgentBlockProb: 1.0,
    open3DefenseMult: 0.65,
    forkWeightMult: 0.35,
    useSplitPatterns: false,
    useOpponentVcfDefense: false,
    casualLapseProb: 0.78,
  },
  4: {
    // 고급: 5수 정밀 탐색 + 사삼/삼삼 전술 + 10수 VCF 공격
    maxDepth: 5,
    timeBudgetMs: 820,
    maxCandidates: 18,
    enableVcf: true,
    vcfDepth: 10,
    noiseRange: 0,
    useOpenFourShortcut: true,
    immediateWinProb: 1.0,
    urgentBlockProb: 1.0,
    open3DefenseMult: 1.0,
    forkWeightMult: 1.0,
    useSplitPatterns: false,
    useOpponentVcfDefense: false,
    casualLapseProb: 0,
  },
  5: {
    // 마스터: 8수 심층 탐색 + 18수 VCF + 상대 VCF 선방어 + 뜀사/뜀삼 정밀 평가
    maxDepth: 8,
    timeBudgetMs: 1400,
    maxCandidates: 20,
    enableVcf: true,
    vcfDepth: 18,
    noiseRange: 0,
    useOpenFourShortcut: true,
    immediateWinProb: 1.0,
    urgentBlockProb: 1.0,
    open3DefenseMult: 1.0,
    forkWeightMult: 1.0,
    useSplitPatterns: true,
    useOpponentVcfDefense: true,
    casualLapseProb: 0,
  },
};

function resolveEffectiveProfile(req: AISearchRequest): GomokuProfile {
  const base = GOMOKU_PROFILES[req.difficulty];
  if (!req.includeHints) {
    return base;
  }
  return {
    maxDepth: Math.max(4, base.maxDepth),
    timeBudgetMs: req.difficulty <= 3 ? 220 : base.timeBudgetMs,
    maxCandidates: Math.max(16, base.maxCandidates),
    enableVcf: true,
    vcfDepth: Math.max(10, base.vcfDepth),
    noiseRange: 0,
    useOpenFourShortcut: true,
    immediateWinProb: 1.0,
    urgentBlockProb: 1.0,
    open3DefenseMult: 1.0,
    forkWeightMult: 1.0,
    useSplitPatterns: true,
    useOpponentVcfDefense: req.difficulty >= 5,
    casualLapseProb: 0,
  };
}

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

interface CandidateMove {
  idx: number;
  x: number;
  y: number;
  heuristic: number;
}

function inBounds(size: number, x: number, y: number): boolean {
  return x >= 0 && x < size && y >= 0 && y < size;
}

/**
 * Checks whether placing Black at (x, y) can possibly form any Renju forbidden pattern
 * (overline, double-four, or double-three). Any such pattern requires at least 2 existing
 * Black stones within 4 intersections along the 4 axes.
 */
function hasEnoughNearbyBlackForForbidden(
  board: Uint8Array,
  size: number,
  x: number,
  y: number
): boolean {
  let nearBlack = 0;
  for (const [dx, dy] of AXES) {
    for (const sign of [-1, 1]) {
      for (let step = 1; step <= 4; step++) {
        const nx = x + dx * sign * step;
        const ny = y + dy * sign * step;
        if (!inBounds(size, nx, ny)) break;
        if (board[ny * size + nx] === BLACK) {
          nearBlack++;
          if (nearBlack >= 2) return true;
        }
      }
    }
  }
  return false;
}

function isLegalOmokCell(
  board: Uint8Array,
  size: number,
  x: number,
  y: number,
  color: PlayerColor,
  ruleset: OmokRulesetType
): boolean {
  if (board[y * size + x] !== EMPTY) return false;
  if (color === BLACK && ruleset === 'renju' && hasEnoughNearbyBlackForForbidden(board, size, x, y)) {
    return !checkRenjuForbidden(board, size, x, y).forbidden;
  }
  return true;
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
  ruleset: OmokRulesetType,
  tuning: EvalTuning
): number {
  let attack = 0;
  let defense = 0;
  const center = (size - 1) * 0.5;
  const centerBonus = 24 - (Math.abs(x - center) + Math.abs(y - center)) * 1.4;

  let ownThrees = 0;
  let ownFours = 0;
  let oppThrees = 0;
  let oppFours = 0;

  for (const [dx, dy] of AXES) {
    const atk = scorePointOnAxis(board, size, x, y, dx, dy, color);
    if (atk.count === 3 && atk.openEnds === 2) ownThrees++;
    if (atk.count === 4 && (atk.openEnds >= 1 || atk.gapCount > 0)) ownFours++;
    attack += classifyPatternWeight(atk.count, atk.openEnds, atk.gapCount > 0);

    // Evaluate how blocking here disrupts opponent's potential line
    const def = scorePointOnAxis(board, size, x, y, dx, dy, opp);
    if (def.count === 3 && def.openEnds === 2) oppThrees++;
    if (def.count === 4 && (def.openEnds >= 1 || def.gapCount > 0)) oppFours++;

    let defPts = classifyPatternWeight(def.count, def.openEnds, def.gapCount > 0) * 0.92;
    if (def.count === 3 && def.openEnds === 2) {
      defPts *= tuning.open3DefenseMult;
    }
    defense += defPts;
  }

  let forkBonus = 0;
  if (ownFours >= 1 && ownThrees >= 1) forkBonus += 22_000; // 4-3 winning fork!
  if (ownFours >= 2 && !(color === BLACK && ruleset === 'renju')) forkBonus += 24_000;
  if (ownThrees >= 2 && !(color === BLACK && ruleset === 'renju')) forkBonus += 14_000;
  attack += forkBonus * tuning.forkWeightMult;

  // Competitive levels (Lv.4/Lv.5/hints) also recognize blocking opponent's 4-3 / 3-3 fork points
  if (tuning.forkWeightMult >= 0.9) {
    if (oppFours >= 1 && oppThrees >= 1) defense += 14_000;
    else if (oppThrees >= 2 && !(opp === BLACK && ruleset === 'renju')) defense += 7_500;
  }

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
  ruleset: OmokRulesetType,
  tuning: EvalTuning
): number {
  let myScore = 0;
  let oppScore = 0;

  const scoreLine = (
    color: PlayerColor,
    runLen: number,
    openBefore: boolean,
    openAfter: boolean
  ): number => {
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
      let pts = (openEnds === 2 ? 7_200 : 850) * turnBoost;
      if (openEnds === 2 && color !== perspective) {
        pts *= tuning.open3DefenseMult;
      }
      return pts;
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
    let prevColor: PlayerColor | 0 = EMPTY;
    let prevRunLen = 0;
    let prevOpenBefore = false;
    let emptySincePrev = 0;

    while (inBounds(size, x, y)) {
      const cell = board[y * size + x];
      if (cell === EMPTY) {
        emptySincePrev++;
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

      let pts = scoreLine(color, runLen, openBefore, openAfter);

      // Single-gap split pattern awareness (split-4, split-3, split-2) for Master/hints
      if (tuning.useSplitPatterns && prevColor === color && emptySincePrev === 1) {
        const combined = prevRunLen + runLen;
        const turnBoost = color === turnToMove ? 1.45 : 1.0;
        if (combined === 4) {
          // B _ B B B, B B _ B B, B B B _ B: filling the gap makes an exact 5
          pts += 11_200 * turnBoost;
        } else if (combined >= 5) {
          if (color === WHITE || ruleset === 'freestyle') {
            pts += 11_200 * turnBoost;
          }
        } else if (combined === 3) {
          if (prevOpenBefore && openAfter) {
            // Split Open-3 (e.g. _ B _ B B _): filling the gap creates a Straight Open-4
            let splitThreePts = 5_600 * turnBoost;
            if (color !== perspective) splitThreePts *= tuning.open3DefenseMult;
            pts += splitThreePts;
          } else if (prevOpenBefore || openAfter) {
            // Split Half-Open-3: filling the gap creates a closed-4
            pts += 450 * turnBoost;
          }
        } else if (combined === 2 && prevOpenBefore && openAfter) {
          pts += 160 * turnBoost;
        }
      }

      if (color === perspective) myScore += pts;
      else oppScore += pts;

      prevColor = color;
      prevRunLen = runLen;
      prevOpenBefore = openBefore;
      emptySincePrev = 0;
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
    const profile = resolveEffectiveProfile(req);
    const tuning: EvalTuning = {
      open3DefenseMult: profile.open3DefenseMult,
      forkWeightMult: profile.forkWeightMult,
      useSplitPatterns: profile.useSplitPatterns,
    };

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

    const candidates = this.generateCandidates(board, size, aiColor, ruleset, 40, tuning);
    if (candidates.length === 0) {
      const fallback = this.findAnyLegalCandidate(board, size, aiColor, ruleset);
      if (!fallback) {
        return {
          coord: null,
          winrate: 0.5,
          simulations: 0,
          elapsedMs: performance.now() - startTime,
        };
      }
      candidates.push(fallback);
    }

    // 2. Check immediate winning 5 moves for AI
    const immediateWins: CandidateMove[] = [];
    for (const c of candidates) {
      if (checkWinAt(board, size, c.x, c.y, aiColor, ruleset).won) {
        immediateWins.push(c);
      }
    }
    let suppressedWinIdxs: Set<number> | null = null;
    if (immediateWins.length > 0) {
      if (profile.immediateWinProb >= 1 || Math.random() < profile.immediateWinProb) {
        const winMove = immediateWins[0];
        return {
          coord: { x: winMove.x, y: winMove.y },
          winrate: 0.995,
          simulations: 1,
          elapsedMs: performance.now() - startTime,
          topSuggestions: [{ coord: { x: winMove.x, y: winMove.y }, winrate: 0.995, visits: 1 }],
        };
      }
      // Beginner oversight: suppress immediate win squares so heuristic 240,000 doesn't force picking them
      suppressedWinIdxs = new Set(immediateWins.map((w) => w.idx));
    }

    // 3. Check urgent opponent immediate winning 5 moves
    const urgentBlocks = this.findImmediateWins(board, size, oppColor, ruleset);
    let overlookUrgentBlocks = false;
    if (urgentBlocks.length === 1) {
      const bIdx = urgentBlocks[0];
      const bx = bIdx % size;
      const by = (bIdx - bx) / size;
      const isForbiddenBlock =
        aiColor === BLACK && ruleset === 'renju' && checkRenjuForbidden(board, size, bx, by).forbidden;
      if (!isForbiddenBlock) {
        if (profile.urgentBlockProb >= 1 || Math.random() < profile.urgentBlockProb) {
          return {
            coord: { x: bx, y: by },
            winrate: 0.42,
            simulations: 2,
            elapsedMs: performance.now() - startTime,
            topSuggestions: [{ coord: { x: bx, y: by }, winrate: 0.42, visits: 2 }],
          };
        }
        overlookUrgentBlocks = true;
      }
    } else if (urgentBlocks.length > 1 && profile.urgentBlockProb < 1) {
      if (Math.random() >= profile.urgentBlockProb) {
        overlookUrgentBlocks = true;
      }
    }

    // 4. Straight Open Four attack for AI (enabled for Lv.4+, or whenever includeHints is true)
    if (profile.useOpenFourShortcut && urgentBlocks.length === 0) {
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

    // 5. VCF (Victory by Continuous Fours) for Lv.4, Lv.5, and hints
    let nodesVisited = 0;
    const deadline = startTime + profile.timeBudgetMs;
    if (profile.enableVcf && urgentBlocks.length === 0) {
      const vcfDeadline = Math.min(deadline, startTime + Math.min(240, profile.timeBudgetMs * 0.35));
      const vcfMove = this.searchVcf(board, size, aiColor, ruleset, profile.vcfDepth, vcfDeadline);
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

    // Filter candidates when beginner overlooked win/block or when urgent multi-threats exist
    let searchPool: CandidateMove[];
    if (urgentBlocks.length > 1 && !overlookUrgentBlocks) {
      searchPool = candidates.filter((c) => urgentBlocks.includes(c.idx));
    } else {
      let filtered = candidates;
      if (suppressedWinIdxs || overlookUrgentBlocks) {
        const urgentSet = overlookUrgentBlocks ? new Set(urgentBlocks) : null;
        const reduced = candidates.filter(
          (c) => (!suppressedWinIdxs || !suppressedWinIdxs.has(c.idx)) && (!urgentSet || !urgentSet.has(c.idx))
        );
        if (reduced.length > 0) {
          filtered = reduced;
        }
      }
      searchPool = filtered.slice(0, profile.maxCandidates);
    }
    let activeCandidates = searchPool.length > 0 ? searchPool : candidates.slice(0, profile.maxCandidates);

    // 5b. Lv.5 Opponent-VCF Counter-Defense awareness
    if (profile.useOpponentVcfDefense && urgentBlocks.length === 0 && activeCandidates.length > 1) {
      const oppVcfDefenses = this.findOpponentVcfDefenses(
        board,
        size,
        aiColor,
        oppColor,
        ruleset,
        candidates,
        activeCandidates,
        profile.vcfDepth,
        deadline
      );
      if (oppVcfDefenses && oppVcfDefenses.length > 0) {
        if (oppVcfDefenses.length === 1) {
          const only = oppVcfDefenses[0];
          return {
            coord: { x: only.x, y: only.y },
            winrate: 0.45,
            simulations: 32,
            elapsedMs: performance.now() - startTime,
            topSuggestions: [{ coord: { x: only.x, y: only.y }, winrate: 0.45, visits: 32 }],
          };
        }
        activeCandidates = oppVcfDefenses;
      }
    }

    // 6. Lv.1 noisy novice choice (maxDepth === 0, !includeHints)
    if (profile.maxDepth <= 0) {
      const topK = activeCandidates.slice(0, Math.min(10, activeCandidates.length));
      let bestMove = topK[0];
      let bestNoisy = -Infinity;
      const scoredSuggestions: AISuggestion[] = topK.slice(0, 3).map((m) => ({
        coord: { x: m.x, y: m.y },
        winrate: this.scoreToWinrate(m.heuristic * 0.25),
        visits: Math.max(1, Math.round(m.heuristic / 100)),
      }));

      for (const m of topK) {
        const val = m.heuristic + (Math.random() - 0.5) * 2 * profile.noiseRange;
        if (val > bestNoisy) {
          bestNoisy = val;
          bestMove = m;
        }
      }
      const safeMove = this.ensureLegalRootMove(board, size, bestMove, activeCandidates, aiColor, ruleset);
      return {
        coord: { x: safeMove.x, y: safeMove.y },
        winrate: this.scoreToWinrate(safeMove.heuristic * 0.2),
        simulations: topK.length,
        elapsedMs: performance.now() - startTime,
        topSuggestions: scoredSuggestions,
      };
    }

    // 7. Iterative Deepening Alpha-Beta with Transposition Table
    const hasCasualLapse = profile.casualLapseProb > 0 && Math.random() < profile.casualLapseProb;
    const effectiveMaxDepth = hasCasualLapse ? 1 : profile.maxDepth;
    const effectiveNoiseRange = hasCasualLapse ? Math.max(profile.noiseRange, 5_600) : profile.noiseRange;

    let hash = computeBoardHash(board, size);
    const moveScores = new Map<number, number>();
    const completedScores = new Map<number, number>();
    for (const c of activeCandidates) {
      moveScores.set(c.idx, c.heuristic);
      completedScores.set(c.idx, c.heuristic);
    }

    let bestCoord: Coord = { x: activeCandidates[0].x, y: activeCandidates[0].y };
    let bestRootScore = -Infinity;
    let hasCompletedIter = false;
    const internalMaxCandidates =
      effectiveMaxDepth >= 5 ? Math.min(profile.maxCandidates, 14) : profile.maxCandidates;

    for (let depth = 1; depth <= effectiveMaxDepth; depth++) {
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
            1,
            alpha,
            beta,
            false,
            aiColor,
            oppColor,
            ruleset,
            internalMaxCandidates,
            tuning,
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
        if (score >= WIN_SCORE - 50) {
          bestRootScore = iterBestScore;
          bestCoord = { x: iterBestIdx % size, y: (iterBestIdx - (iterBestIdx % size)) / size };
          completedScores.set(c.idx, score);
          hasCompletedIter = true;
          aborted = true;
          break;
        }
      }

      if (!aborted) {
        hasCompletedIter = true;
        for (const c of activeCandidates) {
          completedScores.set(c.idx, moveScores.get(c.idx) ?? c.heuristic);
        }
        bestRootScore = iterBestScore;
        bestCoord = { x: iterBestIdx % size, y: (iterBestIdx - (iterBestIdx % size)) / size };
      }
      if (bestRootScore >= WIN_SCORE - 50) break;
    }

    const finalScoreMap = hasCompletedIter ? completedScores : moveScores;
    const rankedFinal = activeCandidates
      .slice()
      .sort((a, b) => (finalScoreMap.get(b.idx) ?? 0) - (finalScoreMap.get(a.idx) ?? 0));

    bestCoord = { x: rankedFinal[0].x, y: rankedFinal[0].y };

    // Organic human-like variety for Lv.2 and Lv.3 (!includeHints only)
    if (effectiveNoiseRange > 0 && rankedFinal.length > 1 && bestRootScore < WIN_SCORE * 0.3) {
      const poolSize = req.difficulty <= 2 || hasCasualLapse ? 5 : 4;
      const noisySorted = rankedFinal
        .slice(0, poolSize)
        .map((c) => ({
          c,
          v: (finalScoreMap.get(c.idx) ?? 0) + (Math.random() - 0.5) * 2 * effectiveNoiseRange,
        }))
        .sort((a, b) => b.v - a.v);
      bestCoord = { x: noisySorted[0].c.x, y: noisySorted[0].c.y };
    }

    // Belt-and-suspenders Renju check before returning
    if (!isLegalOmokCell(board, size, bestCoord.x, bestCoord.y, aiColor, ruleset)) {
      const safeMove = this.ensureLegalRootMove(board, size, rankedFinal[0], rankedFinal, aiColor, ruleset);
      bestCoord = { x: safeMove.x, y: safeMove.y };
    }

    const topSuggestions: AISuggestion[] = rankedFinal.slice(0, 3).map((c, i) => ({
      coord: { x: c.x, y: c.y },
      winrate: this.scoreToWinrate(finalScoreMap.get(c.idx) ?? 0),
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

  private ensureLegalRootMove(
    board: Uint8Array,
    size: BoardSize,
    preferred: CandidateMove,
    pool: CandidateMove[],
    color: PlayerColor,
    ruleset: OmokRulesetType
  ): CandidateMove {
    if (isLegalOmokCell(board, size, preferred.x, preferred.y, color, ruleset)) {
      return preferred;
    }
    for (const c of pool) {
      if (isLegalOmokCell(board, size, c.x, c.y, color, ruleset)) return c;
    }
    return this.findAnyLegalCandidate(board, size, color, ruleset) ?? preferred;
  }

  private findAnyLegalCandidate(
    board: Uint8Array,
    size: BoardSize,
    color: PlayerColor,
    ruleset: OmokRulesetType
  ): CandidateMove | null {
    const total = size * size;
    for (let idx = 0; idx < total; idx++) {
      if (board[idx] !== EMPTY) continue;
      const x = idx % size;
      const y = (idx - x) / size;
      if (isLegalOmokCell(board, size, x, y, color, ruleset)) {
        return { idx, x, y, heuristic: 0 };
      }
    }
    return null;
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
    limit: number,
    tuning: EvalTuning
  ): CandidateMove[] {
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

    const candidates: CandidateMove[] = [];
    for (let idx = 0; idx < total; idx++) {
      if (!nearMask[idx]) continue;
      const x = idx % size;
      const y = (idx - x) / size;

      if (
        color === BLACK &&
        ruleset === 'renju' &&
        hasEnoughNearbyBlackForForbidden(board, size, x, y) &&
        checkRenjuForbidden(board, size, x, y).forbidden
      ) {
        continue;
      }

      const heuristic = scoreLocalPlacement(board, size, x, y, color, opp, ruleset, tuning);
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
        wins.push(idx);
      }
    }
    return wins;
  }

  /**
   * Scans only the 4 axes within distance 4 of (cx, cy) to find new immediate 5-wins
   * created by placing `color` at (cx, cy).
   */
  private findImmediateWinsNear(
    board: Uint8Array,
    size: BoardSize,
    cx: number,
    cy: number,
    color: PlayerColor,
    ruleset: OmokRulesetType
  ): number[] {
    const wins: number[] = [];
    for (const [dx, dy] of AXES) {
      for (let k = -4; k <= 4; k++) {
        if (k === 0) continue;
        const tx = cx + dx * k;
        const ty = cy + dy * k;
        if (!inBounds(size, tx, ty)) continue;
        const tIdx = ty * size + tx;
        if (board[tIdx] !== EMPTY) continue;
        if (checkWinAt(board, size, tx, ty, color, ruleset).won) {
          wins.push(tIdx);
        }
      }
    }
    return wins;
  }

  /**
   * Returns true if empty cell (x, y) has at least 3 stones of `color` within [-4..+4]
   * on at least one axis — a necessary condition to create a Four threat.
   */
  private canPossiblyFormFour(
    board: Uint8Array,
    size: number,
    x: number,
    y: number,
    color: PlayerColor
  ): boolean {
    for (const [dx, dy] of AXES) {
      let count = 0;
      for (let k = -4; k <= 4; k++) {
        if (k === 0) continue;
        const nx = x + dx * k;
        const ny = y + dy * k;
        if (inBounds(size, nx, ny) && board[ny * size + nx] === color) {
          count++;
          if (count >= 3) return true;
        }
      }
    }
    return false;
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
    deadline: number,
    pathOut?: number[],
    vcfVisited: Map<bigint, number> = new Map(),
    boardHash?: bigint
  ): number {
    if (depth <= 0 || performance.now() >= deadline) return -1;

    const hash = boardHash ?? computeBoardHash(board, size);
    const failedDepth = vcfVisited.get(hash);
    if (failedDepth !== undefined && failedDepth >= depth) {
      return -1;
    }

    const defender = opponentColor(attacker);
    const total = size * size;

    // 1. Immediate winning 5 for attacker
    for (let idx = 0; idx < total; idx++) {
      if (board[idx] !== EMPTY) continue;
      const x = idx % size;
      const y = (idx - x) / size;
      if (!this.hasAdjacentSameColorWithin4(board, size, x, y, attacker)) continue;
      if (checkWinAt(board, size, x, y, attacker, ruleset).won) {
        if (pathOut) pathOut.push(idx);
        return idx;
      }
    }

    // 2. Collect only empty squares that have >= 3 attacker stones within 4 cells on an axis
    const fourMoves: Array<{ idx: number; x: number; y: number; replyWins: number[] }> = [];
    for (let idx = 0; idx < total; idx++) {
      if (board[idx] !== EMPTY) continue;
      const x = idx % size;
      const y = (idx - x) / size;
      if (!this.canPossiblyFormFour(board, size, x, y, attacker)) continue;
      if (
        attacker === BLACK &&
        ruleset === 'renju' &&
        hasEnoughNearbyBlackForForbidden(board, size, x, y) &&
        checkRenjuForbidden(board, size, x, y).forbidden
      ) {
        continue;
      }

      board[idx] = attacker;
      const replyWins = this.findImmediateWinsNear(board, size, x, y, attacker, ruleset);
      board[idx] = EMPTY;

      if (replyWins.length >= 2) {
        if (pathOut) pathOut.push(idx);
        return idx;
      }
      if (replyWins.length === 1) {
        fourMoves.push({ idx, x, y, replyWins });
      }
    }

    for (const fm of fourMoves) {
      if (performance.now() >= deadline) break;

      const blockIdx = fm.replyWins[0];
      const bx = blockIdx % size;
      const by = (blockIdx - bx) / size;

      board[fm.idx] = attacker;

      // If Renju rules forbid Defender (BLACK) from playing the block square, Attacker wins immediately!
      if (defender === BLACK && ruleset === 'renju' && checkRenjuForbidden(board, size, bx, by).forbidden) {
        board[fm.idx] = EMPTY;
        if (pathOut) pathOut.push(fm.idx);
        return fm.idx;
      }

      // Check defender counter-5 before continuing VCF
      board[blockIdx] = defender;
      const defenderWonByBlocking = checkWinAt(board, size, bx, by, defender, ruleset).won;
      if (!defenderWonByBlocking) {
        const nextHash = hash ^ stoneZobristKey(fm.idx, attacker) ^ stoneZobristKey(blockIdx, defender);
        const next = this.searchVcf(
          board,
          size,
          attacker,
          ruleset,
          depth - 1,
          deadline,
          pathOut,
          vcfVisited,
          nextHash
        );
        if (next >= 0) {
          board[blockIdx] = EMPTY;
          board[fm.idx] = EMPTY;
          if (pathOut) {
            pathOut.push(blockIdx);
            pathOut.push(fm.idx);
          }
          return fm.idx;
        }
      }

      board[blockIdx] = EMPTY;
      board[fm.idx] = EMPTY;
    }

    if (vcfVisited.size > 25_000) vcfVisited.clear();
    vcfVisited.set(hash, depth);
    return -1;
  }

  /**
   * Lv.5 Opponent-VCF Counter-Defense: checks if opponent currently holds a winning VCF;
   * if so, filters/prioritizes legal AI moves (including counter-Four interruptions) that break it.
   */
  private findOpponentVcfDefenses(
    board: Uint8Array,
    size: BoardSize,
    aiColor: PlayerColor,
    oppColor: PlayerColor,
    ruleset: OmokRulesetType,
    allCandidates: CandidateMove[],
    activeCandidates: CandidateMove[],
    vcfDepth: number,
    searchDeadline: number
  ): CandidateMove[] | null {
    const now = performance.now();
    const detectDeadline = Math.min(searchDeadline - 350, now + 160);
    if (detectDeadline <= now) return null;

    const oppVcfPath: number[] = [];
    const oppDepth = Math.min(12, vcfDepth);
    const oppVcfMove = this.searchVcf(board, size, oppColor, ruleset, oppDepth, detectDeadline, oppVcfPath);
    if (oppVcfMove < 0) return null;

    // Build ordered suspect list: VCF line intersections first, then active candidates
    const seenIdx = new Set<number>();
    const suspects: CandidateMove[] = [];
    const candidateByIdx = new Map<number, CandidateMove>();
    for (const c of allCandidates) candidateByIdx.set(c.idx, c);

    for (let i = oppVcfPath.length - 1; i >= 0; i--) {
      const idx = oppVcfPath[i];
      if (seenIdx.has(idx) || board[idx] !== EMPTY) continue;
      const x = idx % size;
      const y = (idx - x) / size;
      if (!isLegalOmokCell(board, size, x, y, aiColor, ruleset)) continue;
      seenIdx.add(idx);
      const existing = candidateByIdx.get(idx);
      suspects.push(existing ?? { idx, x, y, heuristic: 18_000 });
    }
    for (const c of activeCandidates) {
      if (seenIdx.has(c.idx)) continue;
      seenIdx.add(c.idx);
      suspects.push(c);
    }

    const defenseDeadline = Math.min(searchDeadline - 280, performance.now() + 260);
    const survivingDefenses: CandidateMove[] = [];
    const maxCheck = Math.min(16, suspects.length);

    for (let i = 0; i < maxCheck; i++) {
      if (performance.now() >= defenseDeadline) break;
      const c = suspects[i];

      board[c.idx] = aiColor;
      const aiImmediateReplies = this.findImmediateWinsNear(board, size, c.x, c.y, aiColor, ruleset);

      let stopsVcf = false;
      if (aiImmediateReplies.length >= 2) {
        stopsVcf = true;
      } else if (aiImmediateReplies.length === 1) {
        const oppForcedIdx = aiImmediateReplies[0];
        const fx = oppForcedIdx % size;
        const fy = (oppForcedIdx - fx) / size;
        const oppForbidden =
          oppColor === BLACK && ruleset === 'renju' && checkRenjuForbidden(board, size, fx, fy).forbidden;
        if (oppForbidden) {
          stopsVcf = true;
        } else {
          board[oppForcedIdx] = oppColor;
          const oppWonByBlocking = checkWinAt(board, size, fx, fy, oppColor, ruleset).won;
          if (!oppWonByBlocking) {
            stopsVcf =
              this.searchVcf(board, size, oppColor, ruleset, Math.min(10, oppDepth), defenseDeadline) < 0;
          }
          board[oppForcedIdx] = EMPTY;
        }
      } else {
        stopsVcf =
          this.searchVcf(board, size, oppColor, ruleset, Math.min(10, oppDepth), defenseDeadline) < 0;
      }

      board[c.idx] = EMPTY;

      if (stopsVcf) {
        survivingDefenses.push(c);
      }
    }

    if (survivingDefenses.length > 0) {
      return survivingDefenses;
    }

    // If no single move fully stops all VCFs (or sub-budget ended), still keep VCF origin prioritized
    return suspects.slice(0, activeCandidates.length);
  }

  private alphaBeta(
    board: Uint8Array,
    size: BoardSize,
    hash: bigint,
    depth: number,
    ply: number,
    alpha: number,
    beta: number,
    maximizing: boolean,
    aiColor: PlayerColor,
    oppColor: PlayerColor,
    ruleset: OmokRulesetType,
    maxCandidates: number,
    tuning: EvalTuning,
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
        score: evaluateBoard(board, size, aiColor, turnColor, ruleset, tuning),
        aborted: false,
      };
    }

    const plyLimit = ply >= 3 ? Math.max(10, maxCandidates - 4) : maxCandidates;
    const candidates = this.generateCandidates(board, size, turnColor, ruleset, plyLimit, tuning);
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

      // Late Move Reduction (LMR) for deep quiet moves in competitive search
      let nextDepth = depth - 1;
      const canReduce = depth >= 4 && i >= 6 && c.heuristic < 3_500;
      if (canReduce) nextDepth = depth - 2;

      let childRes = this.alphaBeta(
        board,
        size,
        nextHash,
        nextDepth,
        ply + 1,
        alpha,
        beta,
        !maximizing,
        aiColor,
        oppColor,
        ruleset,
        maxCandidates,
        tuning,
        deadline,
        onNode
      );

      // Re-search at full depth if reduced move looks promising
      if (!childRes.aborted && canReduce) {
        const interesting = maximizing ? childRes.score > alpha : childRes.score < beta;
        if (interesting) {
          childRes = this.alphaBeta(
            board,
            size,
            nextHash,
            depth - 1,
            ply + 1,
            alpha,
            beta,
            !maximizing,
            aiColor,
            oppColor,
            ruleset,
            maxCandidates,
            tuning,
            deadline,
            onNode
          );
        }
      }

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
