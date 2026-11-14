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
import { evaluateKataOmokPosition, type KataOmokEval } from './katago/KataOmokNet';

interface GomokuProfile {
  maxVisits: number;
  timeBudgetMs: number;
  maxRootChildren: number;
  maxInnerChildren: number;
  rootPolicyTemperature: number;
  chosenMoveTemperature: number;
  wideRootNoise: number;
  useLcb: boolean;
  lcbStdevs: number;
  tacticalVerifyDepth: number;
  tacticalVerifyTopK: number;
  tacticalVerifyBudgetMs: number;
  enableVcf: boolean;
  vcfDepth: number;
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
    // 입문: 낮은 탐색수 + 높은 정책/선택 온도 + 큰 노이즈 — 완전 초보자도 편하게 승리 가능
    maxVisits: 6,
    timeBudgetMs: 90,
    maxRootChildren: 16,
    maxInnerChildren: 10,
    rootPolicyTemperature: 2.6,
    chosenMoveTemperature: 1.9,
    wideRootNoise: 0.28,
    useLcb: false,
    lcbStdevs: 0,
    tacticalVerifyDepth: 0,
    tacticalVerifyTopK: 0,
    tacticalVerifyBudgetMs: 0,
    enableVcf: false,
    vcfDepth: 0,
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
    // 초급: 16회 PUCT 탐색 + 부드러운 열린 3 방어 — 입문보다 강하지만 일반인이 쉽게 승리
    maxVisits: 16,
    timeBudgetMs: 180,
    maxRootChildren: 14,
    maxInnerChildren: 10,
    rootPolicyTemperature: 2.2,
    chosenMoveTemperature: 1.75,
    wideRootNoise: 0.2,
    useLcb: false,
    lcbStdevs: 0,
    tacticalVerifyDepth: 0,
    tacticalVerifyTopK: 0,
    tacticalVerifyBudgetMs: 0,
    enableVcf: false,
    vcfDepth: 0,
    useOpenFourShortcut: false,
    immediateWinProb: 1.0,
    urgentBlockProb: 1.0,
    open3DefenseMult: 0.38,
    forkWeightMult: 0.18,
    useSplitPatterns: false,
    useOpponentVcfDefense: false,
    casualLapseProb: 0,
  },
  3: {
    // 중급: 42회 PUCT 탐색 — 초급을 확실히 이기면서 일반인도 50% 이상 승리 가능한 표준 난이도
    maxVisits: 42,
    timeBudgetMs: 320,
    maxRootChildren: 14,
    maxInnerChildren: 10,
    rootPolicyTemperature: 1.35,
    chosenMoveTemperature: 0.85,
    wideRootNoise: 0.08,
    useLcb: false,
    lcbStdevs: 0,
    tacticalVerifyDepth: 0,
    tacticalVerifyTopK: 0,
    tacticalVerifyBudgetMs: 0,
    enableVcf: false,
    vcfDepth: 0,
    useOpenFourShortcut: false,
    immediateWinProb: 1.0,
    urgentBlockProb: 1.0,
    open3DefenseMult: 0.52,
    forkWeightMult: 0.28,
    useSplitPatterns: false,
    useOpponentVcfDefense: false,
    casualLapseProb: 0.78,
  },
  4: {
    // 고급: KataGo PUCT (180 visits) + LCB + 10수 VCF + 5수(홀수 깊이) 반복 심화 전술 검증
    maxVisits: 180,
    timeBudgetMs: 820,
    maxRootChildren: 16,
    maxInnerChildren: 10,
    rootPolicyTemperature: 1.0,
    chosenMoveTemperature: 0,
    wideRootNoise: 0,
    useLcb: true,
    lcbStdevs: 1.55,
    tacticalVerifyDepth: 5,
    tacticalVerifyTopK: 10,
    tacticalVerifyBudgetMs: 520,
    enableVcf: true,
    vcfDepth: 10,
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
    // 마스터: KataGo PUCT (420 visits) + LCB + 18수(최단수순) VCF + 상대 VCF 선방어 + 5수(폭 확장 홀수 깊이) 전술 검증
    maxVisits: 420,
    timeBudgetMs: 1400,
    maxRootChildren: 18,
    maxInnerChildren: 12,
    rootPolicyTemperature: 1.0,
    chosenMoveTemperature: 0,
    wideRootNoise: 0,
    useLcb: true,
    lcbStdevs: 1.65,
    tacticalVerifyDepth: 5,
    tacticalVerifyTopK: 12,
    tacticalVerifyBudgetMs: 750,
    enableVcf: true,
    vcfDepth: 18,
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
  const effectiveDiff = req.includeHints
    ? (Math.max(4, req.difficulty) as AIDifficulty)
    : req.difficulty;
  const base = GOMOKU_PROFILES[effectiveDiff];
  if (!req.includeHints) {
    return base;
  }
  return {
    ...base,
    maxVisits: req.difficulty <= 3 ? 160 : base.maxVisits,
    timeBudgetMs: req.difficulty <= 3 ? 280 : base.timeBudgetMs,
    chosenMoveTemperature: 0,
    wideRootNoise: 0,
    casualLapseProb: 0,
    immediateWinProb: 1.0,
    urgentBlockProb: 1.0,
    useOpenFourShortcut: true,
    enableVcf: true,
    vcfDepth: Math.max(10, base.vcfDepth),
    open3DefenseMult: 1.0,
    forkWeightMult: 1.0,
    useSplitPatterns: true,
    useLcb: true,
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

const CPUCT_EXPLORATION = 1.15;
const CPUCT_EXPLORATION_LOG = 0.45;
const CPUCT_BASE = 19652;
const ROOT_FPU_REDUCTION_MAX = 0.12;
const INNER_FPU_REDUCTION_MAX = 0.22;

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

interface PuctNode {
  turnColor: PlayerColor;
  moveIdx: number; // -1 at root
  moveX: number;
  moveY: number;
  prior: number;
  visits: number;
  valueSum: number; // from parent's perspective (for children)
  valueSqSum: number;
  netUtility: number; // from this node's turnColor perspective
  terminalValue: number | null; // if terminal win/draw, from parent's perspective
  children: PuctNode[] | null;
}

function inBounds(size: number, x: number, y: number): boolean {
  return x >= 0 && x < size && y >= 0 && y < size;
}

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

function scorePointOnAxis(
  board: Uint8Array,
  size: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: PlayerColor
): { count: number; openEnds: number; gapCount: number } {
  let count = 1;
  let openEnds = 0;
  let gapCount = 0;

  let posCount = 0;
  let negCount = 0;

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
  return { count, openEnds, gapCount };
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
  if (ownFours >= 1 && ownThrees >= 1) forkBonus += 22_000;
  if (ownFours >= 2 && !(color === BLACK && ruleset === 'renju')) forkBonus += 24_000;
  if (ownThrees >= 2 && !(color === BLACK && ruleset === 'renju')) forkBonus += 14_000;
  attack += forkBonus * tuning.forkWeightMult;

  if (tuning.forkWeightMult >= 0.9) {
    if (oppFours >= 1 && oppThrees >= 1) defense += 14_000;
    else if (oppThrees >= 2 && !(opp === BLACK && ruleset === 'renju')) defense += 7_500;
  }

  return attack + defense + centerBonus;
}

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
    if (runLen === 5) return WIN_SCORE * 0.5;
    if (runLen >= 6) {
      if (color === BLACK && ruleset === 'renju') return 0;
      return WIN_SCORE * 0.5;
    }

    const openEnds = (openBefore ? 1 : 0) + (openAfter ? 1 : 0);
    if (openEnds === 0) return 0;

    const turnBoost = color === turnToMove ? 1.45 : 1.0;
    if (runLen === 4) {
      if (color === turnToMove) {
        return WIN_SCORE * 0.45;
      }
      return openEnds === 2 ? 90_000 : 1_100;
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

  const scanDirection = (dx: number, dy: number, startX: number, startY: number) => {
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

      if (tuning.useSplitPatterns && prevColor === color && emptySincePrev === 1) {
        const combined = prevRunLen + runLen;
        const turnBoost = color === turnToMove ? 1.25 : 1.0;
        if (combined === 4) {
          pts += color === turnToMove ? WIN_SCORE * 0.45 : 1_100;
        } else if (combined >= 5) {
          if (color === WHITE || ruleset === 'freestyle') {
            pts += color === turnToMove ? WIN_SCORE * 0.45 : 1_100;
          }
        } else if (combined === 3) {
          if (prevOpenBefore && openAfter) {
            // Split Open-3: tactical threat, but fragile to a single interior block
            let splitThreePts = 1_100 * turnBoost;
            if (color !== perspective) splitThreePts *= tuning.open3DefenseMult;
            pts += splitThreePts;
          } else if (prevOpenBefore || openAfter) {
            pts += 220 * turnBoost;
          }
        } else if (combined === 2 && prevOpenBefore && openAfter) {
          pts += 90 * turnBoost;
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

  for (let y = 0; y < size; y++) scanDirection(1, 0, 0, y);
  for (let x = 0; x < size; x++) scanDirection(0, 1, x, 0);
  for (let x = 0; x < size; x++) scanDirection(1, 1, x, 0);
  for (let y = 1; y < size; y++) scanDirection(1, 1, 0, y);
  for (let x = 0; x < size; x++) scanDirection(1, -1, x, size - 1);
  for (let y = size - 2; y >= 0; y--) scanDirection(1, -1, 0, y);

  return myScore - oppScore * 1.06;
}

function makeOmokResult(payload: {
  coord: Coord | null;
  winrate: number;
  simulations: number;
  elapsedMs: number;
  topSuggestions?: AISuggestion[];
}): AISearchResult {
  return {
    ...payload,
    engineBackend: 'katago-omok-puct',
  } as AISearchResult;
}

function turnCacheKey(hash: bigint, turnColor: PlayerColor): bigint {
  return hash ^ (turnColor === BLACK ? 0x9e3779b97f4a7c15n : 0xbf58476d1ce4e5b9n);
}

/**
 * Hybrid KataGo/KataGomo Policy-Value-Ownership Neural Network + PUCT MCTS + Threat-Space (VCF) Omok/Renju Engine.
 */
export class GomokuAI {
  private tt = new Map<bigint, TTEntry>();
  private evalCache = new Map<bigint, KataOmokEval>();

  public chooseMove(req: AISearchRequest): AISearchResult {
    const startTime = performance.now();
    this.tt.clear();
    if (this.evalCache.size > 4096) {
      this.evalCache.clear();
    }

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
      return makeOmokResult({
        coord: { x: center, y: center },
        winrate: 0.54,
        simulations: 1,
        elapsedMs: performance.now() - startTime,
        topSuggestions: [{ coord: { x: center, y: center }, winrate: 0.54, visits: 1 }],
      });
    }

    const candidates = this.generateCandidates(board, size, aiColor, ruleset, 44, tuning);
    if (candidates.length === 0) {
      const fallback = this.findAnyLegalCandidate(board, size, aiColor, ruleset);
      if (!fallback) {
        return makeOmokResult({
          coord: null,
          winrate: 0.5,
          simulations: 0,
          elapsedMs: performance.now() - startTime,
        });
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
        return makeOmokResult({
          coord: { x: winMove.x, y: winMove.y },
          winrate: 0.995,
          simulations: 1,
          elapsedMs: performance.now() - startTime,
          topSuggestions: [{ coord: { x: winMove.x, y: winMove.y }, winrate: 0.995, visits: 1 }],
        });
      }
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
          return makeOmokResult({
            coord: { x: bx, y: by },
            winrate: 0.42,
            simulations: 2,
            elapsedMs: performance.now() - startTime,
            topSuggestions: [{ coord: { x: bx, y: by }, winrate: 0.42, visits: 2 }],
          });
        }
        overlookUrgentBlocks = true;
      }
    } else if (urgentBlocks.length > 1 && profile.urgentBlockProb < 1) {
      if (Math.random() >= profile.urgentBlockProb) {
        overlookUrgentBlocks = true;
      }
    }

    // 4. Straight Open-Four & Forced 4-3 Fork winning closure (Lv.4, Lv.5, and hints)
    if (profile.useOpenFourShortcut && urgentBlocks.length === 0) {
      for (const c of candidates) {
        if (this.createsStraightOpenFour(board, size, c.x, c.y, aiColor, ruleset)) {
          return makeOmokResult({
            coord: { x: c.x, y: c.y },
            winrate: 0.97,
            simulations: 4,
            elapsedMs: performance.now() - startTime,
            topSuggestions: [{ coord: { x: c.x, y: c.y }, winrate: 0.97, visits: 4 }],
          });
        }
      }
      for (const c of candidates) {
        if (this.createsForcedFourThreeFork(board, size, c.x, c.y, aiColor, oppColor, ruleset)) {
          return makeOmokResult({
            coord: { x: c.x, y: c.y },
            winrate: 0.965,
            simulations: 8,
            elapsedMs: performance.now() - startTime,
            topSuggestions: [{ coord: { x: c.x, y: c.y }, winrate: 0.965, visits: 8 }],
          });
        }
      }
    }

    // 5. Threat-Space VCF Solver (Lv.4, Lv.5, and hints) — iterative deepening finds shortest winning VCF first
    const deadline = startTime + profile.timeBudgetMs;
    if (profile.enableVcf && urgentBlocks.length === 0) {
      const vcfDeadline = Math.min(deadline, startTime + Math.min(160, profile.timeBudgetMs * 0.25));
      const vcfMove = this.findShortestVcfMove(board, size, aiColor, ruleset, profile.vcfDepth, vcfDeadline);
      if (vcfMove >= 0) {
        const vx = vcfMove % size;
        const vy = (vcfMove - vx) / size;
        return makeOmokResult({
          coord: { x: vx, y: vy },
          winrate: 0.96,
          simulations: 40,
          elapsedMs: performance.now() - startTime,
          topSuggestions: [{ coord: { x: vx, y: vy }, winrate: 0.96, visits: 40 }],
        });
      }
    }

    // Build legal root candidate pool
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
      searchPool = filtered.slice(0, profile.maxRootChildren);
    }
    let activeCandidates =
      searchPool.length > 0 ? searchPool : candidates.slice(0, profile.maxRootChildren);

    // 5b. Lv.5 Opponent-VCF Counter-Defense pre-filtering
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
          return makeOmokResult({
            coord: { x: only.x, y: only.y },
            winrate: 0.45,
            simulations: 32,
            elapsedMs: performance.now() - startTime,
            topSuggestions: [{ coord: { x: only.x, y: only.y }, winrate: 0.45, visits: 32 }],
          });
        }
        activeCandidates = oppVcfDefenses;
      }
    }

    // 6. KataGo PUCT MCTS Search backed by KataOmokNet Policy-Value-Ownership
    const rootHash = computeBoardHash(board, size);
    const rootEval = this.evaluateCached(board, size, aiColor, ruleset, req.lastMove, rootHash);
    const rootNode: PuctNode = {
      turnColor: aiColor,
      moveIdx: -1,
      moveX: -1,
      moveY: -1,
      prior: 1.0,
      visits: 1,
      valueSum: rootEval.utility,
      valueSqSum: rootEval.utility * rootEval.utility,
      netUtility: rootEval.utility,
      terminalValue: null,
      children: null,
    };

    const allowedRootSet = new Set(activeCandidates.map((c) => c.idx));
    rootNode.children = this.buildRootChildren(
      board,
      size,
      aiColor,
      oppColor,
      ruleset,
      rootEval,
      activeCandidates,
      allowedRootSet,
      profile,
      tuning
    );

    if (rootNode.children.length === 0) {
      const safeMove = this.ensureLegalRootMove(board, size, activeCandidates[0], candidates, aiColor, ruleset);
      return makeOmokResult({
        coord: { x: safeMove.x, y: safeMove.y },
        winrate: rootEval.winrate,
        simulations: 1,
        elapsedMs: performance.now() - startTime,
        topSuggestions: [{ coord: { x: safeMove.x, y: safeMove.y }, winrate: rootEval.winrate, visits: 1 }],
      });
    }

    // Reserve budget for tactical verification on Lv.4 & Lv.5
    const puctDeadline =
      profile.tacticalVerifyDepth > 0
        ? Math.min(deadline - profile.tacticalVerifyBudgetMs, deadline)
        : deadline;

    let puctSimulations = 0;
    const path: PuctNode[] = [];

    for (let v = 0; v < profile.maxVisits; v++) {
      if (v >= 8 && performance.now() >= puctDeadline) break;

      path.length = 0;
      path.push(rootNode);
      let node = rootNode;
      let curHash = rootHash;
      let depth = 0;

      // Selection
      while (node.children !== null && node.children.length > 0 && node.terminalValue === null) {
        const fpuMax = depth === 0 ? ROOT_FPU_REDUCTION_MAX : INNER_FPU_REDUCTION_MAX;
        const selected = this.selectChildPuct(node, fpuMax);
        board[selected.moveIdx] = node.turnColor;
        curHash ^= stoneZobristKey(selected.moveIdx, node.turnColor);
        path.push(selected);
        node = selected;
        depth++;
      }

      // Leaf evaluation / expansion
      let leafValueForParent: number; // from perspective of node's PARENT (i.e. mover who played node)
      if (node.terminalValue !== null) {
        leafValueForParent = node.terminalValue;
      } else {
        const moverColor = opponentColor(node.turnColor);
        if (checkWinAt(board, size, node.moveX, node.moveY, moverColor, ruleset).won) {
          node.terminalValue = 1.0 - depth * 0.001;
          leafValueForParent = node.terminalValue;
        } else {
          const ev = this.evaluateCached(
            board,
            size,
            node.turnColor,
            ruleset,
            { x: node.moveX, y: node.moveY },
            curHash
          );
          node.netUtility = ev.utility;

          // Expand inner node if visited at least once and within depth cap
          if (node.visits >= 1 && depth < 12) {
            const innerChildren = this.buildInnerChildren(
              board,
              size,
              node.turnColor,
              ruleset,
              ev,
              profile.maxInnerChildren
            );
            if (innerChildren.length > 0) {
              node.children = innerChildren;
            } else {
              node.terminalValue = 0.0;
            }
          }

          // `ev.utility` is for `node.turnColor`; parent's mover is opposite color -> negate
          leafValueForParent = -ev.utility;
        }
      }

      // Backpropagation: leafValueForParent is from mover-of-`node` perspective.
      // Walking backwards: path[k] is moved by path[k-1].turnColor.
      let value = leafValueForParent;
      for (let k = path.length - 1; k >= 1; k--) {
        const child = path[k];
        board[child.moveIdx] = EMPTY;
        child.visits++;
        child.valueSum += value;
        child.valueSqSum += value * value;
        value = -value;
      }
      rootNode.visits++;
      rootNode.valueSum += value;
      rootNode.valueSqSum += value * value;

      puctSimulations++;
    }

    // 7. Rank root children by KataGo LCB (Lv.4/Lv.5/hints) or visits (Lv.1..Lv.3)
    const rankedChildren = this.rankRootChildren(rootNode.children, profile.useLcb, profile.lcbStdevs);
    let chosenChild = rankedChildren[0];
    let tacticalNodes = 0;

    // 8. Tactical Alpha-Beta & Threat Verification on top PUCT candidates (Lv.4, Lv.5, hints)
    if (profile.tacticalVerifyDepth > 0 && rankedChildren.length > 1) {
      const tacticalDeadline = Math.min(deadline, performance.now() + profile.tacticalVerifyBudgetMs);
      const verifyResult = this.verifyTopCandidatesWithTactics(
        board,
        size,
        rootHash,
        aiColor,
        oppColor,
        ruleset,
        rankedChildren,
        profile,
        tuning,
        tacticalDeadline
      );
      tacticalNodes = verifyResult.nodes;
      chosenChild = verifyResult.chosen;
    }

    // 9. Calibrated Casual Softening / Temperature Selection (!includeHints on Lv.1..Lv.3)
    if (!req.includeHints) {
      const hasCasualLapse =
        profile.casualLapseProb > 0 &&
        urgentBlocks.length === 0 &&
        immediateWins.length === 0 &&
        rankedChildren.length > 1 &&
        Math.random() < profile.casualLapseProb;

      if (hasCasualLapse) {
        // Casual human-like lapse on non-immediate-loss turns: soften across top 5 PUCT candidates
        const lapsePool = rankedChildren.slice(0, Math.min(5, rankedChildren.length));
        chosenChild = this.sampleByTemperature(lapsePool, 2.6);
      } else if (profile.chosenMoveTemperature > 0 && rankedChildren.length > 1) {
        const samplePool = rankedChildren.slice(0, Math.min(6, rankedChildren.length));
        chosenChild = this.sampleByTemperature(samplePool, profile.chosenMoveTemperature);
      }
    }

    // Belt-and-suspenders Renju safety verification
    let finalCoord: Coord = { x: chosenChild.moveX, y: chosenChild.moveY };
    if (!isLegalOmokCell(board, size, finalCoord.x, finalCoord.y, aiColor, ruleset)) {
      const fallback = this.ensureLegalRootMove(board, size, activeCandidates[0], candidates, aiColor, ruleset);
      finalCoord = { x: fallback.x, y: fallback.y };
    }

    const totalSimulations = Math.max(1, puctSimulations + tacticalNodes);
    const childWinrate = (child: PuctNode): number => {
      const meanQ = child.visits > 0 ? child.valueSum / child.visits : -child.netUtility;
      return Math.max(0.01, Math.min(0.99, (meanQ + 1.0) * 0.5));
    };

    // Build Top-3 suggestions from real PUCT root stats with chosen move first
    const orderedForSuggestions: PuctNode[] = [
      chosenChild,
      ...rankedChildren.filter((c) => c.moveIdx !== chosenChild.moveIdx),
    ];
    const topSuggestions: AISuggestion[] = [];
    for (let i = 0; i < orderedForSuggestions.length && topSuggestions.length < 3; i++) {
      const c = orderedForSuggestions[i];
      if (!isLegalOmokCell(board, size, c.moveX, c.moveY, aiColor, ruleset)) continue;
      topSuggestions.push({
        coord: { x: c.moveX, y: c.moveY },
        winrate: childWinrate(c),
        visits: Math.max(1, c.visits),
      });
    }
    if (topSuggestions.length === 0) {
      topSuggestions.push({
        coord: finalCoord,
        winrate: rootEval.winrate,
        visits: totalSimulations,
      });
    } else {
      topSuggestions[0].coord = finalCoord;
    }

    return makeOmokResult({
      coord: finalCoord,
      winrate: topSuggestions[0].winrate,
      simulations: totalSimulations,
      elapsedMs: performance.now() - startTime,
      topSuggestions,
    });
  }

  private evaluateCached(
    board: Uint8Array,
    size: BoardSize,
    pla: PlayerColor,
    ruleset: OmokRulesetType,
    lastMove: Coord | null,
    hash: bigint
  ): KataOmokEval {
    const key = turnCacheKey(hash, pla);
    const hit = this.evalCache.get(key);
    if (hit) return hit;

    const ev = evaluateKataOmokPosition(board, size, pla, ruleset, lastMove);
    if (this.evalCache.size < 4096) {
      this.evalCache.set(key, ev);
    }
    return ev;
  }

  private buildRootChildren(
    board: Uint8Array,
    size: BoardSize,
    aiColor: PlayerColor,
    oppColor: PlayerColor,
    ruleset: OmokRulesetType,
    rootEval: KataOmokEval,
    activeCandidates: CandidateMove[],
    allowedRootSet: Set<number>,
    profile: GomokuProfile,
    tuning: EvalTuning
  ): PuctNode[] {
    const items: Array<{ cand: CandidateMove; logit: number }> = [];
    const softenPriors = profile.open3DefenseMult < 0.99 || profile.forkWeightMult < 0.99;

    for (const c of activeCandidates) {
      if (!allowedRootSet.has(c.idx)) continue;
      if (board[c.idx] !== EMPTY) continue;
      if (aiColor === BLACK && ruleset === 'renju' && rootEval.forbiddenMask[c.idx] !== 0) continue;

      let logit = rootEval.policyLogits[c.idx];
      if (!Number.isFinite(logit)) continue;

      // Difficulty prior softening for Lv.1..Lv.3 (!includeHints)
      if (softenPriors) {
        let isOpen3Block = false;
        let isFork = false;
        let ownThree = 0;
        let ownFour = 0;
        for (const [dx, dy] of AXES) {
          const def = scorePointOnAxis(board, size, c.x, c.y, dx, dy, oppColor);
          if (def.count === 3 && def.openEnds === 2) isOpen3Block = true;
          const atk = scorePointOnAxis(board, size, c.x, c.y, dx, dy, aiColor);
          if (atk.count === 3 && atk.openEnds === 2) ownThree++;
          if (atk.count >= 4) ownFour++;
        }
        if ((ownFour >= 1 && ownThree >= 1) || ownThree >= 2 || ownFour >= 2) {
          isFork = true;
        }
        if (isOpen3Block) {
          logit *= tuning.open3DefenseMult;
        }
        if (isFork) {
          logit *= Math.max(0.25, tuning.forkWeightMult);
        }
      }

      items.push({ cand: c, logit });
    }

    if (items.length === 0) return [];

    // Apply rootPolicyTemperature
    const invTemp = 1.0 / Math.max(0.2, profile.rootPolicyTemperature);
    let maxL = -Infinity;
    for (const it of items) {
      it.logit *= invTemp;
      if (it.logit > maxL) maxL = it.logit;
    }

    let sumP = 0;
    const probs = new Float64Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const p = Math.exp(items[i].logit - maxL);
      probs[i] = p;
      sumP += p;
    }
    const invSum = sumP > 0 ? 1.0 / sumP : 1.0 / items.length;
    for (let i = 0; i < items.length; i++) {
      probs[i] *= invSum;
    }

    // Apply wideRootNoise (KataGo exploration noise)
    if (profile.wideRootNoise > 0) {
      const noiseArr = new Float64Array(items.length);
      let noiseSum = 0;
      for (let i = 0; i < items.length; i++) {
        // Exponential(1) sample for Dirichlet(1)
        const n = -Math.log(Math.max(1e-6, 1.0 - Math.random()));
        noiseArr[i] = n;
        noiseSum += n;
      }
      const eps = profile.wideRootNoise;
      for (let i = 0; i < items.length; i++) {
        probs[i] = (1 - eps) * probs[i] + eps * (noiseArr[i] / Math.max(1e-9, noiseSum));
      }
    }

    const oppTurn = opponentColor(aiColor);
    const children: PuctNode[] = [];
    for (let i = 0; i < items.length; i++) {
      const c = items[i].cand;
      children.push({
        turnColor: oppTurn,
        moveIdx: c.idx,
        moveX: c.x,
        moveY: c.y,
        prior: probs[i],
        visits: 0,
        valueSum: 0,
        valueSqSum: 0,
        netUtility: 0,
        terminalValue: null,
        children: null,
      });
    }
    children.sort((a, b) => b.prior - a.prior);
    return children;
  }

  private buildInnerChildren(
    board: Uint8Array,
    size: BoardSize,
    turnColor: PlayerColor,
    ruleset: OmokRulesetType,
    ev: KataOmokEval,
    maxChildren: number
  ): PuctNode[] {
    const area = size * size;
    const maskBlack = turnColor === BLACK && ruleset === 'renju';
    const top: Array<{ idx: number; p: number }> = [];

    for (let idx = 0; idx < area; idx++) {
      if (board[idx] !== EMPTY) continue;
      if (maskBlack && ev.forbiddenMask[idx] !== 0) continue;
      const p = ev.policyProbs[idx];
      if (p <= 1e-6) continue;
      if (top.length < maxChildren) {
        top.push({ idx, p });
        if (top.length === maxChildren) {
          top.sort((a, b) => a.p - b.p);
        }
      } else if (p > top[0].p) {
        top[0] = { idx, p };
        top.sort((a, b) => a.p - b.p);
      }
    }

    if (top.length === 0) return [];
    top.sort((a, b) => b.p - a.p);

    let sumP = 0;
    for (const t of top) sumP += t.p;
    const invSum = sumP > 0 ? 1.0 / sumP : 1.0 / top.length;

    const nextTurn = opponentColor(turnColor);
    const children: PuctNode[] = new Array(top.length);
    for (let i = 0; i < top.length; i++) {
      const idx = top[i].idx;
      const x = idx % size;
      const y = (idx - x) / size;
      children[i] = {
        turnColor: nextTurn,
        moveIdx: idx,
        moveX: x,
        moveY: y,
        prior: top[i].p * invSum,
        visits: 0,
        valueSum: 0,
        valueSqSum: 0,
        netUtility: 0,
        terminalValue: null,
        children: null,
      };
    }
    return children;
  }

  private selectChildPuct(node: PuctNode, fpuReductionMax: number): PuctNode {
    const children = node.children!;
    const parentVisits = Math.max(1, node.visits);
    const cpuct =
      CPUCT_EXPLORATION +
      CPUCT_EXPLORATION_LOG * Math.log((parentVisits + CPUCT_BASE + 1) / CPUCT_BASE);
    const sqrtParent = Math.sqrt(parentVisits);

    let visitedPolicyMass = 0;
    for (let i = 0; i < children.length; i++) {
      if (children[i].visits > 0) {
        visitedPolicyMass += children[i].prior;
      }
    }
    const parentUtility = node.visits > 0 ? node.valueSum / node.visits : node.netUtility;
    const fpuValue =
      parentUtility - fpuReductionMax * Math.sqrt(Math.min(1.0, visitedPolicyMass));

    let best = children[0];
    let bestScore = -Infinity;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      const q = c.visits > 0 ? c.valueSum / c.visits : fpuValue;
      const u = (cpuct * c.prior * sqrtParent) / (1 + c.visits);
      const score = q + u;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  private computeLcb(child: PuctNode, lcbStdevs: number): number {
    if (child.terminalValue !== null && child.terminalValue > 0.9) {
      return 10.0 + child.terminalValue;
    }
    if (child.visits <= 0) return -10.0;
    const mean = child.valueSum / child.visits;
    const variance = Math.max(0, child.valueSqSum / child.visits - mean * mean);
    const stdev = Math.sqrt((variance + 0.02) / child.visits);
    return mean - lcbStdevs * stdev;
  }

  private rankRootChildren(children: PuctNode[], useLcb: boolean, lcbStdevs: number): PuctNode[] {
    let maxVisits = 0;
    for (const c of children) {
      if (c.visits > maxVisits) maxVisits = c.visits;
    }
    const minLcbVisits = Math.max(2, Math.floor(maxVisits * 0.2));

    return children.slice().sort((a, b) => {
      if (useLcb) {
        const aTermWin = a.terminalValue !== null && a.terminalValue > 0.9;
        const bTermWin = b.terminalValue !== null && b.terminalValue > 0.9;
        if (aTermWin !== bTermWin) return aTermWin ? -1 : 1;

        const aQual = a.visits >= minLcbVisits;
        const bQual = b.visits >= minLcbVisits;
        if (aQual !== bQual) return aQual ? -1 : 1;
        if (aQual && bQual) {
          const lcbDiff = this.computeLcb(b, lcbStdevs) - this.computeLcb(a, lcbStdevs);
          if (Math.abs(lcbDiff) > 1e-4) return lcbDiff;
        }
      }
      if (b.visits !== a.visits) return b.visits - a.visits;
      const aMean = a.visits > 0 ? a.valueSum / a.visits : a.prior;
      const bMean = b.visits > 0 ? b.valueSum / b.visits : b.prior;
      return bMean - aMean;
    });
  }

  private sampleByTemperature(pool: PuctNode[], temp: number): PuctNode {
    const invT = 1.0 / Math.max(0.1, temp);
    const weights = new Float64Array(pool.length);
    let total = 0;
    for (let i = 0; i < pool.length; i++) {
      const w = Math.pow(pool[i].visits + 0.5, invT);
      weights[i] = w;
      total += w;
    }
    if (total <= 0) return pool[0];
    let r = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i];
    }
    return pool[0];
  }

  /**
   * Tactical verification over the top PUCT root candidates (Lv.4, Lv.5, and hints):
   * - Detects forced tactical wins / 4-3 forks / blunders missed by static neural leaves
   * - Checks opponent counter-open-4 / VCF refutations
   */
  /**
   * Iterative-deepening tactical alpha-beta verification over the top PUCT root candidates
   * (Lv.4, Lv.5, and hints): catches multi-move 4-3/3-3/VCT combinations and blunders while
   * using KataGo PUCT LCB ordering for root move priority and tie-breaking.
   */
  private verifyTopCandidatesWithTactics(
    board: Uint8Array,
    size: BoardSize,
    rootHash: bigint,
    aiColor: PlayerColor,
    oppColor: PlayerColor,
    ruleset: OmokRulesetType,
    rankedChildren: PuctNode[],
    profile: GomokuProfile,
    tuning: EvalTuning,
    deadline: number
  ): { chosen: PuctNode; nodes: number } {
    const topK = Math.min(profile.tacticalVerifyTopK, rankedChildren.length);
    const pool = rankedChildren.slice(0, topK);
    let nodes = 0;
    const innerLimit = profile.maxRootChildren >= 18 ? 10 : 8;

    const moveScores = new Map<number, number>();
    const completedScores = new Map<number, number>();
    for (let i = 0; i < pool.length; i++) {
      const bonus = (pool.length - i) * 15;
      moveScores.set(pool[i].moveIdx, bonus);
      completedScores.set(pool[i].moveIdx, bonus);
    }

    let bestChild = pool[0];
    let bestRootScore = -Infinity;
    let hasCompletedIter = false;

    for (let depth = 1; depth <= profile.tacticalVerifyDepth; depth += 2) {
      if (performance.now() >= deadline && depth > 1) break;

      pool.sort((a, b) => (moveScores.get(b.moveIdx) ?? 0) - (moveScores.get(a.moveIdx) ?? 0));

      let iterBest = pool[0];
      let iterBestScore = -Infinity;
      let alpha = -Infinity;
      const beta = Infinity;
      let aborted = false;

      for (let i = 0; i < pool.length; i++) {
        if (performance.now() >= deadline && depth > 2) {
          aborted = true;
          break;
        }
        const child = pool[i];
        board[child.moveIdx] = aiColor;
        const nextHash = rootHash ^ stoneZobristKey(child.moveIdx, aiColor);

        let score: number;
        if (checkWinAt(board, size, child.moveX, child.moveY, aiColor, ruleset).won) {
          score = WIN_SCORE - 1;
        } else {
          const res = this.alphaBeta(
            board,
            size,
            nextHash,
            depth - 1,
            1,
            alpha,
            beta,
            false,
            aiColor,
            oppColor,
            ruleset,
            innerLimit,
            tuning,
            deadline,
            () => {
              nodes++;
            }
          );
          if (res.aborted) {
            board[child.moveIdx] = EMPTY;
            aborted = true;
            break;
          }
          score = res.score;
        }

        board[child.moveIdx] = EMPTY;

        moveScores.set(child.moveIdx, score);
        if (score > iterBestScore) {
          iterBestScore = score;
          iterBest = child;
        }
        if (score > alpha) alpha = score;
        if (score >= WIN_SCORE - 50) {
          bestRootScore = iterBestScore;
          bestChild = iterBest;
          completedScores.set(child.moveIdx, score);
          hasCompletedIter = true;
          aborted = true;
          break;
        }
      }

      if (!aborted) {
        hasCompletedIter = true;
        for (const c of pool) {
          completedScores.set(c.moveIdx, moveScores.get(c.moveIdx) ?? 0);
        }
        bestRootScore = iterBestScore;
        bestChild = iterBest;
      }
      if (bestRootScore >= WIN_SCORE - 50) break;
    }

    if (!hasCompletedIter) {
      return { chosen: rankedChildren[0], nodes };
    }

    // Only let PUCT LCB break dead-even tactical ties (< 10 pts)
    const puctPrimary = rankedChildren[0];
    const puctPrimaryScore = completedScores.get(puctPrimary.moveIdx) ?? -Infinity;
    if (
      bestChild.moveIdx !== puctPrimary.moveIdx &&
      bestRootScore < WIN_SCORE * 0.4 &&
      puctPrimaryScore > -WIN_SCORE * 0.4 &&
      bestRootScore - puctPrimaryScore < 10
    ) {
      return { chosen: puctPrimary, nodes };
    }

    return { chosen: bestChild, nodes };
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
   * Checks whether placing `aiColor` at (x, y) creates a forced 4-3 fork where:
   * - Opponent must block the single Four threat (and cannot win on the block square), AND
   * - After opponent's forced block, `aiColor` still has a Straight Open-4 move available.
   */
  private createsForcedFourThreeFork(
    board: Uint8Array,
    size: BoardSize,
    x: number,
    y: number,
    aiColor: PlayerColor,
    oppColor: PlayerColor,
    ruleset: OmokRulesetType
  ): boolean {
    const idx = y * size + x;
    board[idx] = aiColor;
    try {
      const replies = this.findImmediateWinsNear(board, size, x, y, aiColor, ruleset);
      if (replies.length !== 1) return false;

      const blockIdx = replies[0];
      const bx = blockIdx % size;
      const by = (blockIdx - bx) / size;
      if (oppColor === BLACK && ruleset === 'renju' && checkRenjuForbidden(board, size, bx, by).forbidden) {
        return true;
      }

      board[blockIdx] = oppColor;
      try {
        if (checkWinAt(board, size, bx, by, oppColor, ruleset).won) return false;
        // Opponent cannot counter-threat a Four that forces our reply away?
        // Check if opponent's block itself created a 4-threat (winning-5 reply for opp)
        const oppReplies = this.findImmediateWinsNear(board, size, bx, by, oppColor, ruleset);
        if (oppReplies.length > 0) return false;

        // Check if aiColor has a legal Straight Open-4 follow-up along any of the 4 axes through (x, y)
        for (const [dx, dy] of AXES) {
          for (let k = -3; k <= 3; k++) {
            if (k === 0) continue;
            const tx = x + dx * k;
            const ty = y + dy * k;
            if (!inBounds(size, tx, ty)) continue;
            const tIdx = ty * size + tx;
            if (board[tIdx] !== EMPTY) continue;
            if (aiColor === BLACK && ruleset === 'renju' && checkRenjuForbidden(board, size, tx, ty).forbidden) {
              continue;
            }
            if (this.createsStraightOpenFour(board, size, tx, ty, aiColor, ruleset)) {
              return true;
            }
          }
        }
        return false;
      } finally {
        board[blockIdx] = EMPTY;
      }
    } finally {
      board[idx] = EMPTY;
    }
  }

  /**
   * Iterative-deepening VCF wrapper: discovers the shortest forced Four-win within `maxPlies` first.
   */
  private findShortestVcfMove(
    board: Uint8Array,
    size: BoardSize,
    attacker: PlayerColor,
    ruleset: OmokRulesetType,
    maxMoves: number,
    deadline: number
  ): number {
    const maxAttackerMoves = Math.max(2, maxMoves);
    const vcfVisited = new Map<bigint, number>();
    const rootHash = computeBoardHash(board, size);

    for (let d = 2; d <= maxAttackerMoves; d++) {
      if (performance.now() >= deadline) break;
      const mv = this.searchVcf(board, size, attacker, ruleset, d, deadline, undefined, vcfVisited, rootHash);
      if (mv >= 0) return mv;
    }
    return -1;
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

      if (defender === BLACK && ruleset === 'renju' && checkRenjuForbidden(board, size, bx, by).forbidden) {
        board[fm.idx] = EMPTY;
        if (pathOut) pathOut.push(fm.idx);
        return fm.idx;
      }

      board[blockIdx] = defender;
      const defenderWonByBlocking = checkWinAt(board, size, bx, by, defender, ruleset).won;
      const defenderCounterFours = !defenderWonByBlocking
        ? this.findImmediateWinsNear(board, size, bx, by, defender, ruleset)
        : [];
      const counterStopped =
        defenderCounterFours.length > 0 &&
        this.findImmediateWins(board, size, attacker, ruleset).length === 0;
      if (!defenderWonByBlocking && !counterStopped) {
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
    const detectDeadline = Math.min(searchDeadline - 350, now + 95);
    if (detectDeadline <= now) return null;

    const oppVcfPath: number[] = [];
    const oppDepth = Math.min(12, vcfDepth);
    const oppVcfMove = this.searchVcf(board, size, oppColor, ruleset, oppDepth, detectDeadline, oppVcfPath);
    if (oppVcfMove < 0) return null;

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

    const plyLimit = ply >= 2 ? (maxCandidates >= 10 ? 7 : 6) : maxCandidates;
    const candidates = this.generateCandidates(board, size, turnColor, ruleset, plyLimit, tuning);
    if (candidates.length === 0) {
      return { score: 0, aborted: false };
    }

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
