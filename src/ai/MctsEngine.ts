import {
  BLACK,
  WHITE,
  EMPTY,
  AIDifficulty,
  BoardSize,
  Coord,
  GameType,
  OmokRulesetType,
  PlayerColor,
  RulesetType,
  opponentColor,
} from '../rules/types';
import { calculateScore, estimateDeadStones } from '../rules/scoring';
import { FastBoard } from './FastBoard';
import { HeuristicLevel, computeCandidateMovesAndPriors } from './GoHeuristics';
import { getKataGoModelSync } from './katago/KataGoWeights';
import { evaluateKataGoPosition, type KataGoNetOutput } from './katago/KataGoNet';
import { type KataGoInputPosition } from './katago/KataGoFeatures';

export type AIEngineBackend = 'katago-native' | 'katago-neural' | 'katago-omok-puct';

export interface AISearchRequest {
  gameType?: GameType;
  omokRuleset?: OmokRulesetType;
  includeHints?: boolean;
  board: Uint8Array;
  size: BoardSize;
  color: PlayerColor;
  ruleset: RulesetType;
  komi: number;
  koPoint: Coord | null;
  captures: { black: number; white: number };
  lastMove: Coord | null;
  opponentPassed: boolean;
  moveCount: number;
  positionHashes: string[]; // serialized bigint strings
  difficulty: AIDifficulty;
  moveHistory?: Array<{ color: PlayerColor; coord: Coord | null }>;
  initialStones?: Array<{ color: PlayerColor; coord: Coord }>;
}

export interface AISuggestion {
  coord: Coord;
  winrate: number;
  visits: number;
}

export interface AISearchResult {
  coord: Coord | null; // null = PASS
  winrate: number; // 0..1 for AI color
  simulations: number;
  elapsedMs: number;
  topSuggestions?: AISuggestion[];
  engineBackend?: AIEngineBackend;
  scoreLead?: number;
}

interface DifficultyProfile {
  maxSimulations: number;
  timeBudgetMs: number;
  nnEvalBudget: number;
  rootPolicyTemperature: number;
  nnWeight: number;
  wideRootNoise: number;
  cPuct: number;
  cPuctLog: number;
  fpuReductionMax: number;
  useLcb: boolean;
  ownershipBlend: number;
  raveEquiv: number; // Used only if NN model is unavailable
  temperature: number;
  minRatio: number; // Minimum visit ratio relative to maxVisits for softmax move sampling
  heuristicLevel: HeuristicLevel;
  useLgrf: boolean;
  rolloutTacticsProb: number; // Probability [0..1] of applying tactical capture/atari checks in playouts
  rolloutDepthFactor: number; // Playout max steps = board.total * rolloutDepthFactor
  casualErrorProb: number; // Probability [0..1] of picking a sub-optimal casual candidate (!includeHints only)
  casualErrorBand: number; // Rank band [1..casualErrorBand] sampled when casualErrorProb triggers
  maxChildren9: number;
  maxChildren13: number;
  maxChildren19: number;
}

const NN_CACHE_CAPACITY = 4096;
const SCORE_UTILITY_FACTOR = 0.08;

const DIFFICULTY_PROFILES: Record<AIDifficulty, DifficultyProfile> = {
  1: {
    // 입문: 높은 정책 온도·노이즈·가벼운 탐색으로 초보자도 편하게 대국·승리할 수 있는 수준
    maxSimulations: 40,
    timeBudgetMs: 150,
    nnEvalBudget: 1,
    rootPolicyTemperature: 3.1,
    nnWeight: 0.18,
    wideRootNoise: 0.30,
    cPuct: 2.3,
    cPuctLog: 0.45,
    fpuReductionMax: 0.14,
    useLcb: false,
    ownershipBlend: 0.04,
    raveEquiv: 0,
    temperature: 2.3,
    minRatio: 0.02,
    heuristicLevel: 'novice',
    useLgrf: false,
    rolloutTacticsProb: 0.16,
    rolloutDepthFactor: 0.45,
    casualErrorProb: 0.52,
    casualErrorBand: 18,
    maxChildren9: 42,
    maxChildren13: 50,
    maxChildren19: 48,
  },
  2: {
    // 초급: 완화된 KataGo 감각 + 기본 활로 인식, 깊은 전술은 배제
    maxSimulations: 80,
    timeBudgetMs: 230,
    nnEvalBudget: 2,
    rootPolicyTemperature: 2.35,
    nnWeight: 0.30,
    wideRootNoise: 0.20,
    cPuct: 1.85,
    cPuctLog: 0.45,
    fpuReductionMax: 0.20,
    useLcb: false,
    ownershipBlend: 0.08,
    raveEquiv: 0,
    temperature: 1.55,
    minRatio: 0.04,
    heuristicLevel: 'elementary',
    useLgrf: false,
    rolloutTacticsProb: 0.40,
    rolloutDepthFactor: 0.58,
    casualErrorProb: 0.35,
    casualErrorBand: 10,
    maxChildren9: 40,
    maxChildren13: 46,
    maxChildren19: 44,
  },
  3: {
    // 중급 (기본값): 자연스러운 KataGo 형세·모양 감각을 갖추되 일반인도 50%+ 승률이 가능한 균형형
    maxSimulations: 120,
    timeBudgetMs: 330,
    nnEvalBudget: 3,
    rootPolicyTemperature: 1.90,
    nnWeight: 0.43,
    wideRootNoise: 0.14,
    cPuct: 1.55,
    cPuctLog: 0.45,
    fpuReductionMax: 0.25,
    useLcb: false,
    ownershipBlend: 0.12,
    raveEquiv: 80,
    temperature: 1.15,
    minRatio: 0.06,
    heuristicLevel: 'casual',
    useLgrf: false,
    rolloutTacticsProb: 0.62,
    rolloutDepthFactor: 0.70,
    casualErrorProb: 0.38,
    casualErrorBand: 8,
    maxChildren9: 38,
    maxChildren13: 44,
    maxChildren19: 44,
  },
  4: {
    // 고급: KataGo b6c96 신경망 PUCT + LCB + 전술 판독기 + Ownership 가이드 탐색
    maxSimulations: 260,
    timeBudgetMs: 650,
    nnEvalBudget: 10,
    rootPolicyTemperature: 1.05,
    nnWeight: 0.78,
    wideRootNoise: 0.0,
    cPuct: 1.15,
    cPuctLog: 0.45,
    fpuReductionMax: 0.35,
    useLcb: true,
    ownershipBlend: 0.52,
    raveEquiv: 800,
    temperature: 0.0,
    minRatio: 0.6,
    heuristicLevel: 'full',
    useLgrf: true,
    rolloutTacticsProb: 0.96,
    rolloutDepthFactor: 0.90,
    casualErrorProb: 0.0,
    casualErrorBand: 0,
    maxChildren9: 36,
    maxChildren13: 48,
    maxChildren19: 60,
  },
  5: {
    // 마스터: 최대 KataGo b6c96 신경망 탐색 예산 + LCB + LGRF-1 + 정밀 수읽기
    maxSimulations: 520,
    timeBudgetMs: 1100,
    nnEvalBudget: 20,
    rootPolicyTemperature: 1.0,
    nnWeight: 0.80,
    wideRootNoise: 0.0,
    cPuct: 1.10,
    cPuctLog: 0.45,
    fpuReductionMax: 0.35,
    useLcb: true,
    ownershipBlend: 0.58,
    raveEquiv: 1200,
    temperature: 0.0,
    minRatio: 1.0,
    heuristicLevel: 'master',
    useLgrf: true,
    rolloutTacticsProb: 1.0,
    rolloutDepthFactor: 1.0,
    casualErrorProb: 0.0,
    casualErrorBand: 0,
    maxChildren9: 42,
    maxChildren13: 56,
    maxChildren19: 76,
  },
};

class MctsNode {
  public readonly moveIdx: number; // -1 = PASS
  public readonly playerJustMoved: PlayerColor;
  public readonly prior: number;
  public readonly urgentScore: number;
  public visits = 0;
  public valueSum = 0; // KataGo utility sum from perspective of playerJustMoved
  public valueSqSum = 0; // Sum of squared utilities for LCB variance
  public winrateSum = 0; // Sum of [0..1] winrates from perspective of playerJustMoved
  public scoreLeadSum = 0; // Sum of score leads from perspective of playerJustMoved
  public amafVisits = 0;
  public amafValueSum = 0;
  public children: MctsNode[] | null = null;

  constructor(moveIdx: number, playerJustMoved: PlayerColor, prior: number, urgentScore = 0) {
    this.moveIdx = moveIdx;
    this.playerJustMoved = playerJustMoved;
    this.prior = prior;
    this.urgentScore = urgentScore;
  }
}

function computeKataGoUtility(winrate: number, scoreLead: number, boardSize: number): number {
  const winLoss = 2.0 * winrate - 1.0;
  const scoreUtility = SCORE_UTILITY_FACTOR * (2.0 / Math.PI) * Math.atan(scoreLead / boardSize);
  return winLoss + scoreUtility;
}

export class MctsEngine {
  private rngState = 0x9e3779b9;
  private readonly nnCache = new Map<string, KataGoNetOutput>();

  private getCachedNN(key: string): KataGoNetOutput | undefined {
    const val = this.nnCache.get(key);
    if (val !== undefined) {
      // Refresh LRU insertion order
      this.nnCache.delete(key);
      this.nnCache.set(key, val);
    }
    return val;
  }

  private setCachedNN(key: string, val: KataGoNetOutput): void {
    if (this.nnCache.has(key)) {
      this.nnCache.delete(key);
    } else if (this.nnCache.size >= NN_CACHE_CAPACITY) {
      const oldestKey = this.nnCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.nnCache.delete(oldestKey);
      }
    }
    this.nnCache.set(key, val);
  }

  private buildNNCacheKey(
    board: FastBoard,
    pla: PlayerColor,
    ruleset: RulesetType,
    komi: number
  ): string {
    return `${board.size}_${board.hash.toString(16)}_${pla}_${board.koIdx}_${ruleset}_${Math.round(komi * 2)}`;
  }

  private evaluatePositionWithCache(params: {
    board: FastBoard;
    pla: PlayerColor;
    ruleset: RulesetType;
    komi: number;
    lastIdx: number | null;
    opponentPassed: boolean;
    moveHistory?: Array<{ color: PlayerColor; coord: Coord | null }>;
    legalMask?: Uint8Array;
    allowFreshEval: boolean;
  }): { output: KataGoNetOutput | null; usedFreshEval: boolean } {
    const {
      board,
      pla,
      ruleset,
      komi,
      lastIdx,
      opponentPassed,
      moveHistory,
      legalMask,
      allowFreshEval,
    } = params;

    const key = this.buildNNCacheKey(board, pla, ruleset, komi);
    const cached = this.getCachedNN(key);
    if (cached !== undefined) {
      return { output: cached, usedFreshEval: false };
    }

    if (!allowFreshEval || getKataGoModelSync() === null) {
      return { output: null, usedFreshEval: false };
    }

    const size = board.size;
    const koPoint =
      board.koIdx >= 0
        ? { x: board.koIdx % size, y: (board.koIdx - (board.koIdx % size)) / size }
        : null;
    const lastMove =
      lastIdx !== null && lastIdx >= 0
        ? { x: lastIdx % size, y: (lastIdx - (lastIdx % size)) / size }
        : null;

    const pos: KataGoInputPosition = {
      board: board.grid,
      size,
      pla,
      ruleset,
      komi,
      koPoint,
      moveHistory,
      lastMove,
      opponentPassed,
    };

    const evaluated = evaluateKataGoPosition(pos, legalMask, 0);
    if (evaluated !== null) {
      this.setCachedNN(key, evaluated);
      return { output: evaluated, usedFreshEval: true };
    }

    return { output: null, usedFreshEval: false };
  }

  /**
   * Checks whether `idx` sits strictly inside `color`'s already completely enclosed alive territory
   * with zero opponent stones nearby — playing there is pointless or loses a point in Korean rules.
   */
  private isRedundantOwnTerritoryFill(
    board: Uint8Array,
    size: BoardSize,
    idx: number,
    color: PlayerColor,
    territoryMap: Int8Array,
    deadMask: Uint8Array
  ): boolean {
    if (territoryMap[idx] !== color) return false;
    const opp = opponentColor(color);
    const x = idx % size;
    const y = (idx - x) / size;

    // If any live opponent stone is within Manhattan distance 2, keep move available for defense/shortage-of-liberties
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > 2) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
        const nIdx = ny * size + nx;
        if (board[nIdx] === opp && !deadMask[nIdx]) {
          return false;
        }
      }
    }
    return true;
  }

  private buildBlendedPriors(params: {
    moves: Int16Array;
    heurPriors: Float32Array;
    urgentScores: Float32Array;
    count: number;
    netOut: KataGoNetOutput | null;
    policyTemp: number;
    nnWeight: number;
    wideRootNoise: number;
    applyUrgentOverride: boolean;
    isRoot: boolean;
    maxWidth: number;
  }): Array<{ idx: number; prior: number; urgent: number }> {
    const {
      moves,
      heurPriors,
      urgentScores,
      count,
      netOut,
      policyTemp,
      nnWeight,
      wideRootNoise,
      applyUrgentOverride,
      isRoot,
      maxWidth,
    } = params;

    const blended: Array<{ idx: number; prior: number; urgent: number }> = new Array(count);

    if (netOut === null) {
      for (let i = 0; i < count; i++) {
        blended[i] = { idx: moves[i], prior: heurPriors[i], urgent: urgentScores[i] };
      }
    } else {
      const invTemp = policyTemp > 0.05 ? 1.0 / policyTemp : 1.0;
      const nnPriors = new Float32Array(count);
      let nnSum = 0;
      for (let i = 0; i < count; i++) {
        const rawP = Math.max(1e-7, netOut.policyProbs[moves[i]]);
        const p = invTemp === 1.0 ? rawP : Math.pow(rawP, invTemp);
        nnPriors[i] = p;
        nnSum += p;
      }
      if (nnSum > 0) {
        const invSum = 1.0 / nnSum;
        for (let i = 0; i < count; i++) nnPriors[i] *= invSum;
      } else if (count > 0) {
        const uniform = 1.0 / count;
        for (let i = 0; i < count; i++) nnPriors[i] = uniform;
      }

      if (isRoot && wideRootNoise > 0 && count > 1) {
        const noise = new Float32Array(count);
        let nSum = 0;
        for (let i = 0; i < count; i++) {
          const u = Math.max(1e-6, Math.random());
          const g = -Math.log(u);
          noise[i] = g;
          nSum += g;
        }
        const invNSum = nSum > 0 ? 1.0 / nSum : 1.0 / count;
        const keep = 1.0 - wideRootNoise;
        for (let i = 0; i < count; i++) {
          nnPriors[i] = keep * nnPriors[i] + wideRootNoise * (noise[i] * invNSum);
        }
      }

      const heurWeight = 1.0 - nnWeight;
      const urgentScale = isRoot ? 0.55 : 0.30;
      for (let i = 0; i < count; i++) {
        let p = nnWeight * nnPriors[i] + heurWeight * heurPriors[i];
        if (applyUrgentOverride && urgentScores[i] > 0) {
          p += urgentScores[i] * urgentScale;
        }
        blended[i] = { idx: moves[i], prior: p, urgent: urgentScores[i] };
      }
    }

    blended.sort((a, b) => b.prior - a.prior);
    const sliced = blended.slice(0, maxWidth);
    let sum = 0;
    for (let i = 0; i < sliced.length; i++) sum += sliced[i].prior;
    if (sum > 0) {
      const inv = 1.0 / sum;
      for (let i = 0; i < sliced.length; i++) sliced[i].prior *= inv;
    } else if (sliced.length > 0) {
      const u = 1.0 / sliced.length;
      for (let i = 0; i < sliced.length; i++) sliced[i].prior = u;
    }

    return sliced;
  }

  public chooseMove(req: AISearchRequest): AISearchResult {
    const startTime = performance.now();
    // CRITICAL HINT CONTRACT: when includeHints is true, always use sharp 'full'+ search & tactics
    const baseProfile = req.includeHints
      ? DIFFICULTY_PROFILES[Math.max(4, req.difficulty) as AIDifficulty]
      : DIFFICULTY_PROFILES[req.difficulty];
    const profile: DifficultyProfile = req.includeHints
      ? {
          ...baseProfile,
          rootPolicyTemperature: 1.0,
          wideRootNoise: 0.0,
          temperature: 0.0,
          minRatio: 1.0,
          useLgrf: true,
          useLcb: true,
          rolloutTacticsProb: 1.0,
          casualErrorProb: 0.0,
          casualErrorBand: 0,
        }
      : baseProfile;

    const size = req.size;
    const total = size * size;
    const aiColor = req.color;
    const oppColor = opponentColor(aiColor);

    const forbiddenHashes = new Set<bigint>(req.positionHashes.map((s) => BigInt(s)));
    const koIdx = req.koPoint ? req.koPoint.y * size + req.koPoint.x : -1;
    const lastMoveIdx = req.lastMove ? req.lastMove.y * size + req.lastMove.x : null;

    const rootBoard = new FastBoard(size);
    rootBoard.copyFromState(req.board, koIdx, req.captures.black, req.captures.white);

    // Precompute current territory / dead stone estimate to avoid filling settled own territory in late endgame
    const deadMask = estimateDeadStones(req.board, size);
    const currentScore = calculateScore({
      board: req.board,
      size,
      ruleset: req.ruleset,
      komi: req.komi,
      captures: req.captures,
      deadStoneMask: deadMask,
    });
    const heuristicScoreLead =
      aiColor === BLACK
        ? currentScore.blackTotal - currentScore.whiteTotal
        : currentScore.whiteTotal - currentScore.blackTotal;

    const {
      moves: rawMoves,
      priors: rawPriors,
      urgentScores: rawUrgent,
      legalMask,
      count: rawCount,
    } = computeCandidateMovesAndPriors({
      board: rootBoard,
      color: aiColor,
      lastMoveIdx,
      moveCount: req.moveCount,
      forbiddenHashes,
      heuristicLevel: profile.heuristicLevel,
    });

    // Filter out redundant moves inside completely settled own territory
    const filteredIdx = new Int16Array(rawCount);
    const filteredHeur = new Float32Array(rawCount);
    const filteredUrgent = new Float32Array(rawCount);
    let filteredCount = 0;

    for (let i = 0; i < rawCount; i++) {
      const mIdx = rawMoves[i];
      if (
        req.moveCount > total * 0.35 &&
        this.isRedundantOwnTerritoryFill(req.board, size, mIdx, aiColor, currentScore.territoryMap, deadMask)
      ) {
        legalMask[mIdx] = 0;
        continue;
      }
      filteredIdx[filteredCount] = mIdx;
      filteredHeur[filteredCount] = rawPriors[i];
      filteredUrgent[filteredCount] = rawUrgent[i];
      filteredCount++;
    }

    // If no worthwhile moves remain at all -> PASS immediately!
    if (filteredCount === 0) {
      return {
        coord: null,
        winrate: 0.5,
        simulations: 0,
        elapsedMs: performance.now() - startTime,
        engineBackend: 'katago-neural',
        scoreLead: heuristicScoreLead,
      };
    }

    // If opponent just passed and dameCount === 0 (all boundaries closed), check if any tactical atari exists; if not, pass!
    if (req.opponentPassed && currentScore.dameCount === 0 && req.moveCount >= total * 0.3) {
      let hasUrgentTactic = false;
      for (let i = 0; i < filteredCount; i++) {
        if (filteredHeur[i] > 0.18 && filteredCount > 3) {
          hasUrgentTactic = true;
          break;
        }
      }
      if (!hasUrgentTactic) {
        const aiLeads =
          (aiColor === BLACK && currentScore.blackTotal > currentScore.whiteTotal) ||
          (aiColor === WHITE && currentScore.whiteTotal > currentScore.blackTotal);
        return {
          coord: null,
          winrate: aiLeads ? 0.92 : 0.15,
          simulations: 1,
          elapsedMs: performance.now() - startTime,
          engineBackend: 'katago-neural',
          scoreLead: heuristicScoreLead,
        };
      }
    }

    // Always evaluate at least the root node with KataGo NN (when model is loaded)
    const rootEval = this.evaluatePositionWithCache({
      board: rootBoard,
      pla: aiColor,
      ruleset: req.ruleset,
      komi: req.komi,
      lastIdx: lastMoveIdx,
      opponentPassed: req.opponentPassed,
      moveHistory: req.moveHistory,
      legalMask,
      allowFreshEval: true,
    });
    const rootNetOut = rootEval.output;
    let nnEvalsUsed = rootEval.usedFreshEval ? 1 : 0;

    // Re-normalize filtered heuristic priors so blending sums cleanly
    let heurSum = 0;
    for (let i = 0; i < filteredCount; i++) heurSum += filteredHeur[i];
    if (heurSum > 0) {
      const invH = 1.0 / heurSum;
      for (let i = 0; i < filteredCount; i++) filteredHeur[i] *= invH;
    }

    const maxWidth =
      size === 19 ? profile.maxChildren19 : size === 13 ? profile.maxChildren13 : profile.maxChildren9;
    const isCompetitive =
      req.includeHints === true || profile.heuristicLevel === 'full' || profile.heuristicLevel === 'master';

    const rootPriors = this.buildBlendedPriors({
      moves: filteredIdx,
      heurPriors: filteredHeur,
      urgentScores: filteredUrgent,
      count: filteredCount,
      netOut: rootNetOut,
      policyTemp: profile.rootPolicyTemperature,
      nnWeight: profile.nnWeight,
      wideRootNoise: req.includeHints ? 0.0 : profile.wideRootNoise,
      applyUrgentOverride: isCompetitive,
      isRoot: true,
      maxWidth,
    });

    const root = new MctsNode(-1, oppColor, 1.0);
    root.children = rootPriors.map((p) => new MctsNode(p.idx, aiColor, p.prior, p.urgent));

    if (rootNetOut !== null) {
      const rootUtilAi = computeKataGoUtility(rootNetOut.winrate, rootNetOut.scoreLead, size);
      const rootUtilJustMoved = -rootUtilAi;
      root.visits = 1;
      root.valueSum = rootUtilJustMoved;
      root.valueSqSum = rootUtilJustMoved * rootUtilJustMoved;
      root.winrateSum = 1.0 - rootNetOut.winrate;
      root.scoreLeadSum = -rootNetOut.scoreLead;
    }

    // Dynamic Komi for rollout evaluation in high-handicap / large score disparity openings
    let effectiveKomi = req.komi;
    if (Math.abs(req.komi) >= 12) {
      const openingPhase = Math.max(0, 1 - req.moveCount / (total * 0.45));
      effectiveKomi = req.komi * (1 - 0.35 * openingPhase);
    }

    const simBoard = new FastBoard(size);
    const rolloutScratch = new FastBoard(size);
    const playedBlackMask = new Uint8Array(total);
    const playedWhiteMask = new Uint8Array(total);
    const lgrBlack = new Int16Array(total).fill(-1);
    const lgrWhite = new Int16Array(total).fill(-1);
    const maxRolloutLog = Math.max(16, Math.ceil(total * profile.rolloutDepthFactor) + 8);
    const rolloutMoveLog = new Int16Array(maxRolloutLog);
    const rolloutColorLog = new Uint8Array(maxRolloutLog);
    const pathNodes: MctsNode[] = [];
    const pathMoves: Array<{ color: PlayerColor; coord: Coord | null }> = [];
    const interiorLegalMask = new Uint8Array(total);

    let sims = 0;
    const deadline = startTime + profile.timeBudgetMs;
    const nnDeadline = startTime + profile.timeBudgetMs * 0.62;
    const hasModel = getKataGoModelSync() !== null;
    const baseHistoryTail =
      req.moveHistory && req.moveHistory.length > 0 ? req.moveHistory.slice(-5) : [];

    while (sims < profile.maxSimulations) {
      if ((sims & 7) === 0 && sims > 0 && performance.now() >= deadline) {
        break;
      }

      simBoard.copyFrom(rootBoard);
      playedBlackMask.fill(0);
      playedWhiteMask.fill(0);
      pathNodes.length = 0;
      pathMoves.length = 0;

      let node = root;
      pathNodes.push(node);
      let turn: PlayerColor = aiColor;
      let lastIdx = lastMoveIdx;
      let passes = req.opponentPassed ? 1 : 0;
      let leafNNOut: KataGoNetOutput | null = null;
      let illegalSelection = false;

      // 1. PUCT Selection & Selective Neural Expansion
      while (node.children !== null && node.children.length > 0 && passes < 2) {
        const child = this.selectChild(node, profile, hasModel, isCompetitive);
        if (child.moveIdx === -1) {
          passes++;
          simBoard.koIdx = -1;
          lastIdx = null;
          pathMoves.push({ color: turn, coord: null });
        } else {
          const cap = simBoard.play(child.moveIdx, turn);
          if (cap < 0) {
            child.visits += 1;
            child.valueSum -= 0.5;
            child.valueSqSum += 0.25;
            illegalSelection = true;
            break;
          }
          if (turn === BLACK) playedBlackMask[child.moveIdx] = 1;
          else playedWhiteMask[child.moveIdx] = 1;
          passes = 0;
          lastIdx = child.moveIdx;
          pathMoves.push({
            color: turn,
            coord: { x: child.moveIdx % size, y: (child.moveIdx - (child.moveIdx % size)) / size },
          });
        }

        node = child;
        pathNodes.push(node);
        turn = opponentColor(turn);

        if (node.children === null) {
          if (passes >= 2) {
            break;
          }

          // Check cache or fresh interior NN evaluation budget
          const allowFresh =
            hasModel && nnEvalsUsed < profile.nnEvalBudget && performance.now() < nnDeadline;
          const combinedHist =
            baseHistoryTail.length > 0 || pathMoves.length > 0
              ? baseHistoryTail.concat(pathMoves).slice(-5)
              : undefined;

          // Build fast interior legal mask only if needed for fresh NN eval or cache lookup
          interiorLegalMask.fill(0);
          for (let i = 0; i < total; i++) {
            if (simBoard.grid[i] === EMPTY && i !== simBoard.koIdx && !simBoard.isTrueEye(i, turn)) {
              interiorLegalMask[i] = 1;
            }
          }

          const nodeEval = this.evaluatePositionWithCache({
            board: simBoard,
            pla: turn,
            ruleset: req.ruleset,
            komi: req.komi,
            lastIdx,
            opponentPassed: passes > 0,
            moveHistory: combinedHist,
            legalMask: interiorLegalMask,
            allowFreshEval: allowFresh,
          });
          if (nodeEval.usedFreshEval) nnEvalsUsed++;

          if (nodeEval.output !== null) {
            leafNNOut = nodeEval.output;
            this.expandNode(
              node,
              simBoard,
              turn,
              lastIdx,
              req.moveCount + pathNodes.length,
              profile,
              nodeEval.output,
              isCompetitive
            );
            break;
          }

          if (node.visits >= 2) {
            this.expandNode(
              node,
              simBoard,
              turn,
              lastIdx,
              req.moveCount + pathNodes.length,
              profile,
              null,
              isCompetitive
            );
          }
          break;
        }
      }

      if (illegalSelection) {
        sims++;
        continue;
      }

      // 2. Leaf Evaluation: KataGo NN output OR Ownership-Guided Tactical Rollout
      let blackWinrate: number;
      let blackScoreLead: number;
      let blackUtility: number;

      if (leafNNOut !== null) {
        blackWinrate = turn === BLACK ? leafNNOut.winrate : 1.0 - leafNNOut.winrate;
        blackScoreLead = turn === BLACK ? leafNNOut.scoreLead : -leafNNOut.scoreLead;
        blackUtility = computeKataGoUtility(blackWinrate, blackScoreLead, size);
      } else {
        const playout = this.runTacticalPlayout(
          simBoard,
          rolloutScratch,
          turn,
          lastIdx,
          passes,
          req.ruleset,
          effectiveKomi,
          playedBlackMask,
          playedWhiteMask,
          lgrBlack,
          lgrWhite,
          rolloutMoveLog,
          rolloutColorLog,
          profile
        );

        if (rootNetOut !== null && profile.ownershipBlend > 0) {
          const depth = pathNodes.length - 1;
          const ownershipEst = this.estimateLeafFromRootOwnership(
            simBoard,
            rootBoard,
            aiColor,
            oppColor,
            rootNetOut
          );
          const owWeight = Math.max(0.10, profile.ownershipBlend - depth * 0.025);
          blackWinrate = owWeight * ownershipEst.blackWinrate + (1.0 - owWeight) * playout.blackWinrate;
          blackScoreLead = owWeight * ownershipEst.blackScoreLead + (1.0 - owWeight) * playout.blackScoreDiff;
        } else {
          blackWinrate = playout.blackWinrate;
          blackScoreLead = playout.blackScoreDiff;
        }
        blackUtility = computeKataGoUtility(blackWinrate, blackScoreLead, size);
      }

      // 3. Backpropagation + fallback RAVE (AMAF) update when NN is absent
      for (let i = 0; i < pathNodes.length; i++) {
        const pNode = pathNodes[i];
        pNode.visits += 1;
        const isBlackJustMoved = pNode.playerJustMoved === BLACK;
        const uVal = isBlackJustMoved ? blackUtility : -blackUtility;
        const wVal = isBlackJustMoved ? blackWinrate : 1.0 - blackWinrate;
        const sVal = isBlackJustMoved ? blackScoreLead : -blackScoreLead;
        pNode.valueSum += uVal;
        pNode.valueSqSum += uVal * uVal;
        pNode.winrateSum += wVal;
        pNode.scoreLeadSum += sVal;

        if (!hasModel && profile.raveEquiv > 0 && pNode.children !== null) {
          const nextTurn = opponentColor(pNode.playerJustMoved);
          const mask = nextTurn === BLACK ? playedBlackMask : playedWhiteMask;
          const nextUtil = nextTurn === BLACK ? blackUtility : -blackUtility;
          for (let c = 0; c < pNode.children.length; c++) {
            const ch = pNode.children[c];
            if (ch.moveIdx >= 0 && mask[ch.moveIdx]) {
              ch.amafVisits += 1;
              ch.amafValueSum += nextUtil;
            }
          }
        }
      }

      sims++;
    }

    // Select final move according to difficulty LCB, temperature, minRatio, and casual oversight variance
    const children = root.children!;
    let chosen: MctsNode = children[0];

    let maxRootVisits = 1;
    let maxRootWinrate = 0;
    for (const ch of children) {
      if (ch.visits > maxRootVisits) maxRootVisits = ch.visits;
      if (ch.visits > 0) {
        const wr = ch.winrateSum / ch.visits;
        if (wr > maxRootWinrate) maxRootWinrate = wr;
      }
    }

    const scoreForCompetitive = (ch: MctsNode, maxV: number): number => {
      if (ch.visits <= 0) return -1e9;
      const chWinrate = ch.winrateSum / ch.visits;
      const tacticalTieBreak =
        isCompetitive && ch.urgentScore >= 0.70 && chWinrate >= maxRootWinrate - 0.14
          ? 0.28 * Math.min(1.5, ch.urgentScore)
          : 0.0;
      if (profile.useLcb && maxV >= 6) {
        const minLcbVisits = Math.max(3, Math.ceil(maxV * 0.16));
        if (ch.visits < minLcbVisits) {
          return -1e6 + ch.visits + tacticalTieBreak;
        }
        const mean = ch.valueSum / ch.visits;
        const rawVar = Math.max(0.015, ch.valueSqSum / ch.visits - mean * mean);
        return mean - 2.6 * Math.sqrt(rawVar / ch.visits) + tacticalTieBreak;
      }
      const q = ch.valueSum / ch.visits;
      return ch.visits + q * 4.0 + tacticalTieBreak * 50.0;
    };

    if (
      !req.includeHints &&
      profile.casualErrorProb > 0 &&
      children.length >= 3 &&
      Math.random() < profile.casualErrorProb
    ) {
      const sorted = children
        .slice()
        .sort((a, b) => {
          const sa = a.visits + (a.visits > 0 ? (a.valueSum / a.visits) * 3.0 : a.prior * 2.0);
          const sb = b.visits + (b.visits > 0 ? (b.valueSum / b.visits) * 3.0 : b.prior * 2.0);
          return sb - sa;
        });
      const maxBand = Math.min(sorted.length - 1, Math.max(1, profile.casualErrorBand));
      const pickIdx = 1 + Math.floor(Math.random() * maxBand);
      chosen = sorted[pickIdx];
    } else if (profile.useLcb || profile.temperature <= 0.02) {
      let bestScore = -1e9;
      for (const ch of children) {
        if (ch.visits === 0) continue;
        const s = scoreForCompetitive(ch, maxRootVisits);
        if (s > bestScore || (s === bestScore && ch.visits > chosen.visits)) {
          bestScore = s;
          chosen = ch;
        }
      }
    } else {
      const invT = 1 / profile.temperature;
      const minRatio = profile.minRatio;
      const weights: number[] = [];
      const pool: MctsNode[] = [];
      let wSum = 0;

      for (const ch of children) {
        if (ch.visits >= maxRootVisits * minRatio && ch.visits > 0) {
          const w = Math.pow(ch.visits / maxRootVisits, invT);
          pool.push(ch);
          weights.push(w);
          wSum += w;
        }
      }

      if (pool.length > 0 && wSum > 0) {
        let r = Math.random() * wSum;
        chosen = pool[0];
        for (let i = 0; i < pool.length; i++) {
          r -= weights[i];
          if (r <= 0) {
            chosen = pool[i];
            break;
          }
        }
      }
    }

    const winrate =
      chosen.visits > 0
        ? Math.max(0, Math.min(1, chosen.winrateSum / chosen.visits))
        : rootNetOut
          ? rootNetOut.winrate
          : 0.5;
    const scoreLead =
      chosen.visits > 0
        ? chosen.scoreLeadSum / chosen.visits
        : rootNetOut
          ? rootNetOut.scoreLead
          : heuristicScoreLead;

    // Collect top 3 root suggestions for Hints / Winrate tracking (aligned with final selection ranking)
    const ranked = children
      .filter((c) => c.moveIdx >= 0 && c.visits > 0)
      .slice()
      .sort((a, b) => {
        if (profile.useLcb || profile.temperature <= 0.02) {
          const sa = scoreForCompetitive(a, maxRootVisits);
          const sb = scoreForCompetitive(b, maxRootVisits);
          if (sb !== sa) return sb - sa;
          return b.visits - a.visits;
        }
        const qa = a.winrateSum / Math.max(1, a.visits);
        const qb = b.winrateSum / Math.max(1, b.visits);
        return b.visits + qb * 4.0 - (a.visits + qa * 4.0);
      })
      .slice(0, 3)
      .map((c) => ({
        coord: { x: c.moveIdx % size, y: (c.moveIdx - (c.moveIdx % size)) / size },
        winrate: Math.max(0, Math.min(1, c.winrateSum / Math.max(1, c.visits))),
        visits: c.visits,
      }));

    // Late-game Pass check: if game is past midgame and even best move has terrible value while opponent passed
    if (req.opponentPassed && req.moveCount > total * 0.45 && winrate < 0.04) {
      return {
        coord: null,
        winrate,
        simulations: sims,
        elapsedMs: performance.now() - startTime,
        topSuggestions: ranked,
        engineBackend: 'katago-neural',
        scoreLead,
      };
    }

    const x = chosen.moveIdx % size;
    const y = (chosen.moveIdx - x) / size;

    return {
      coord: { x, y },
      winrate,
      simulations: sims,
      elapsedMs: performance.now() - startTime,
      topSuggestions: ranked,
      engineBackend: 'katago-neural',
      scoreLead,
    };
  }

  private estimateLeafFromRootOwnership(
    simBoard: FastBoard,
    rootBoard: FastBoard,
    aiColor: PlayerColor,
    oppColor: PlayerColor,
    rootNetOut: KataGoNetOutput
  ): { blackWinrate: number; blackScoreLead: number } {
    const total = simBoard.total;
    const size = simBoard.size;
    let deltaOwnership = 0;

    for (let i = 0; i < total; i++) {
      const cur = simBoard.grid[i];
      const orig = rootBoard.grid[i];
      if (cur !== orig) {
        const expected = rootNetOut.ownership[i]; // [-1, +1] for aiColor
        if (cur === aiColor) {
          deltaOwnership += 0.65 * (1.0 - expected);
        } else if (cur === oppColor) {
          deltaOwnership += 0.65 * (-1.0 - expected);
        } else {
          // Stone captured at cell i
          deltaOwnership += orig === oppColor ? 0.85 : -0.85;
        }
      }
    }

    const aiCapDelta =
      aiColor === BLACK
        ? simBoard.capturesBlack - rootBoard.capturesBlack - (simBoard.capturesWhite - rootBoard.capturesWhite)
        : simBoard.capturesWhite - rootBoard.capturesWhite - (simBoard.capturesBlack - rootBoard.capturesBlack);

    const estScoreForAi = rootNetOut.scoreLead + deltaOwnership + aiCapDelta * 0.5;
    const estWinrateForAi = 1.0 / (1.0 + Math.exp(-estScoreForAi / Math.max(3.5, size * 0.65)));

    return {
      blackWinrate: aiColor === BLACK ? estWinrateForAi : 1.0 - estWinrateForAi,
      blackScoreLead: aiColor === BLACK ? estScoreForAi : -estScoreForAi,
    };
  }

  private selectChild(
    parent: MctsNode,
    profile: DifficultyProfile,
    hasModel: boolean,
    isCompetitive: boolean
  ): MctsNode {
    const children = parent.children!;
    const N = Math.max(1, parent.visits);
    const cPuctDynamic = profile.cPuct + profile.cPuctLog * Math.log((N + 500 + 1) / 500);
    const sqrtParent = Math.sqrt(N);

    // Parent-relative FPU: parent.valueSum is from parent.playerJustMoved's perspective; negate for child's mover
    const parentUtility = parent.visits > 0 ? -(parent.valueSum / parent.visits) : 0.0;
    let visitedPolicyMass = 0;
    for (let i = 0; i < children.length; i++) {
      if (children[i].visits > 0) visitedPolicyMass += children[i].prior;
    }
    if (visitedPolicyMass > 1.0) visitedPolicyMass = 1.0;
    const fpu = parentUtility - profile.fpuReductionMax * Math.sqrt(visitedPolicyMass);

    let best = children[0];
    let bestScore = -1e9;

    for (let i = 0; i < children.length; i++) {
      const ch = children[i];
      const q = ch.visits > 0 ? ch.valueSum / ch.visits : fpu;

      let blendedQ = q;
      if (!hasModel && profile.raveEquiv > 0 && ch.amafVisits > 0) {
        const amafQ = ch.amafValueSum / ch.amafVisits;
        const beta =
          ch.amafVisits / (ch.amafVisits + ch.visits + (4 * ch.amafVisits * ch.visits) / profile.raveEquiv + 1e-5);
        blendedQ = (1 - beta) * q + beta * amafQ;
      }

      const u = cPuctDynamic * ch.prior * (sqrtParent / (1 + ch.visits));
      const tacticalProg =
        isCompetitive && ch.urgentScore >= 0.70 ? (ch.urgentScore * 0.25) / (1 + ch.visits * 0.03) : 0.0;
      const score = blendedQ + u + tacticalProg;
      if (score > bestScore) {
        bestScore = score;
        best = ch;
      }
    }

    return best;
  }

  private expandNode(
    node: MctsNode,
    board: FastBoard,
    turn: PlayerColor,
    lastIdx: number | null,
    moveCount: number,
    profile: DifficultyProfile,
    netOut: KataGoNetOutput | null,
    isCompetitive: boolean
  ): void {
    const { moves, priors, urgentScores, count } = computeCandidateMovesAndPriors({
      board,
      color: turn,
      lastMoveIdx: lastIdx,
      moveCount,
      heuristicLevel: profile.heuristicLevel,
      skipLadder: true,
    });

    if (count === 0) {
      node.children = [new MctsNode(-1, turn, 1.0)];
      return;
    }

    const cap = board.size === 19 ? Math.min(30, profile.maxChildren19) : board.size === 13 ? 26 : 24;
    const items = this.buildBlendedPriors({
      moves,
      heurPriors: priors,
      urgentScores,
      count,
      netOut,
      policyTemp: 1.0,
      nnWeight: profile.nnWeight,
      wideRootNoise: 0.0,
      applyUrgentOverride: isCompetitive,
      isRoot: false,
      maxWidth: cap,
    });

    node.children = items.map((s) => new MctsNode(s.idx, turn, s.prior, s.urgent));
  }

  /**
   * Graduated Monte Carlo rollout returning winrate in [0, 1] and scoreDiff for BLACK.
   */
  private runTacticalPlayout(
    board: FastBoard,
    scratch: FastBoard,
    startTurn: PlayerColor,
    initialLastIdx: number | null,
    initialPasses: number,
    ruleset: RulesetType,
    komi: number,
    playedBlackMask: Uint8Array,
    playedWhiteMask: Uint8Array,
    lgrBlack: Int16Array,
    lgrWhite: Int16Array,
    rolloutMoveLog: Int16Array,
    rolloutColorLog: Uint8Array,
    profile: DifficultyProfile
  ): { blackWinrate: number; blackScoreDiff: number } {
    const total = board.total;
    const maxSteps = Math.max(8, Math.floor(total * profile.rolloutDepthFactor));
    let turn = startTurn;
    let lastIdx = initialLastIdx;
    let passes = initialPasses;
    let logLen = 0;

    const emptyCells = new Int16Array(total);
    let emptyCount = 0;
    for (let i = 0; i < total; i++) {
      if (board.grid[i] === EMPTY) {
        emptyCells[emptyCount++] = i;
      }
    }

    // Persistent per-engine PRNG state avoids identical Date.now() seeds within the same millisecond
    this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
    let rng = (this.rngState ^ (emptyCount * 2654435761)) >>> 0 || 1234567;
    const nextRand = (bound: number) => {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return rng % bound;
    };

    const tacticsThreshold = Math.round(profile.rolloutTacticsProb * 1000);
    const scanGlobalAtariOnEntry = profile.rolloutTacticsProb >= 0.9;

    for (let step = 0; step < maxSteps && passes < 2; step++) {
      let chosenMove = -1;
      const opp = opponentColor(turn);
      const doTactic = tacticsThreshold >= 1000 || nextRand(1000) < tacticsThreshold;

      // A) Local tactical check around opponent's last move (gated by rolloutTacticsProb)
      if (doTactic && lastIdx !== null && lastIdx >= 0 && board.grid[lastIdx] === opp) {
        const nbrs = board.getNeighborsOffset(lastIdx);
        for (let i = 0; i < 4; i++) {
          const n = nbrs[i];
          if (n < 0) break;
          if (board.grid[n] === turn) {
            const ownCh = board.analyzeChain(n, 2);
            if (ownCh.libertyCount === 1 && ownCh.lib0 >= 0 && !board.isTrueEye(ownCh.lib0, turn)) {
              scratch.copyFrom(board);
              if (scratch.play(ownCh.lib0, turn) >= 0 && scratch.analyzeChain(ownCh.lib0, 2).libertyCount >= 2) {
                chosenMove = ownCh.lib0;
                break;
              }
            }
          }
        }

        if (chosenMove < 0) {
          const lastCh = board.analyzeChain(lastIdx, 2);
          if (lastCh.libertyCount === 1 && lastCh.lib0 >= 0 && board.isLegal(lastCh.lib0, turn)) {
            chosenMove = lastCh.lib0;
          }
        }

        // B) LGRF-1 Last Good Reply lookup (only when profile.useLgrf is enabled)
        if (chosenMove < 0 && profile.useLgrf) {
          const lgrCandidate = turn === BLACK ? lgrBlack[lastIdx] : lgrWhite[lastIdx];
          if (
            lgrCandidate >= 0 &&
            lgrCandidate < total &&
            board.grid[lgrCandidate] === EMPTY &&
            lgrCandidate !== board.koIdx &&
            !board.isTrueEye(lgrCandidate, turn)
          ) {
            scratch.copyFrom(board);
            const cap = scratch.play(lgrCandidate, turn);
            if (cap >= 0 && (cap > 0 || scratch.analyzeChain(lgrCandidate, 2).libertyCount >= 2)) {
              chosenMove = lgrCandidate;
            }
          }
        }
      }

      // A2) On entry to high-precision rollouts (Lv.4/Lv.5/Hints), catch any neglected 1-liberty atari on board
      if (chosenMove < 0 && step === 0 && scanGlobalAtariOnEntry) {
        let bestOppCapMove = -1;
        let bestOppCapStones = 0;
        let bestOwnSaveMove = -1;
        let bestOwnSaveStones = 0;

        for (let i = 0; i < total; i++) {
          const stone = board.grid[i];
          if (stone === EMPTY) continue;
          const nbrs = board.getNeighborsOffset(i);
          let emptyNbrs = 0;
          for (let j = 0; j < 4; j++) {
            const n = nbrs[j];
            if (n < 0) break;
            if (board.grid[n] === EMPTY) emptyNbrs++;
          }
          if (emptyNbrs >= 2) continue;

          const ch = board.analyzeChain(i, 2);
          if (ch.libertyCount !== 1 || ch.lib0 < 0) continue;

          if (stone === opp) {
            if (ch.stoneCount > bestOppCapStones && ch.lib0 !== board.koIdx && board.isLegal(ch.lib0, turn)) {
              bestOppCapStones = ch.stoneCount;
              bestOppCapMove = ch.lib0;
            }
          } else if (stone === turn) {
            if (ch.stoneCount > bestOwnSaveStones && !board.isTrueEye(ch.lib0, turn)) {
              scratch.copyFrom(board);
              if (scratch.play(ch.lib0, turn) >= 0 && scratch.analyzeChain(ch.lib0, 2).libertyCount >= 2) {
                bestOwnSaveStones = ch.stoneCount;
                bestOwnSaveMove = ch.lib0;
              }
            }
          }
        }

        if (bestOppCapMove >= 0 && bestOppCapStones >= bestOwnSaveStones) {
          chosenMove = bestOppCapMove;
        } else if (bestOwnSaveMove >= 0) {
          chosenMove = bestOwnSaveMove;
        } else if (bestOppCapMove >= 0) {
          chosenMove = bestOppCapMove;
        }
      }

      // C) Randomized scan of empty intersections avoiding own true eyes (and self-atari when doTactic)
      if (chosenMove < 0 && emptyCount > 0) {
        const startOffset = nextRand(emptyCount);
        for (let k = 0; k < emptyCount; k++) {
          const pos = (startOffset + k) % emptyCount;
          const cell = emptyCells[pos];

          if (board.grid[cell] !== EMPTY) {
            emptyCells[pos] = emptyCells[emptyCount - 1];
            emptyCount--;
            if (emptyCount === 0) break;
            continue;
          }

          if (cell === board.koIdx || board.isTrueEye(cell, turn)) continue;

          const nbrs = board.getNeighborsOffset(cell);
          let emptyNbrs = 0;
          for (let j = 0; j < 4; j++) {
            const n = nbrs[j];
            if (n < 0) break;
            if (board.grid[n] === EMPTY) emptyNbrs++;
          }

          if (emptyNbrs >= 2) {
            chosenMove = cell;
            break;
          } else {
            scratch.copyFrom(board);
            const cap = scratch.play(cell, turn);
            if (cap >= 0 && (!doTactic || cap > 0 || scratch.analyzeChain(cell, 2).libertyCount >= 2)) {
              chosenMove = cell;
              break;
            }
          }
        }
      }

      if (chosenMove >= 0) {
        const cap = board.play(chosenMove, turn);
        if (cap >= 0) {
          if (turn === BLACK) playedBlackMask[chosenMove] = 1;
          else playedWhiteMask[chosenMove] = 1;

          if (logLen < rolloutMoveLog.length) {
            rolloutMoveLog[logLen] = chosenMove;
            rolloutColorLog[logLen] = turn;
            logLen++;
          }

          if (cap > 0) {
            emptyCount = 0;
            for (let i = 0; i < total; i++) {
              if (board.grid[i] === EMPTY) emptyCells[emptyCount++] = i;
            }
          }
          passes = 0;
          lastIdx = chosenMove;
          turn = opp;
          continue;
        }
      }

      // Pass
      passes++;
      board.koIdx = -1;
      lastIdx = null;
      turn = opp;
    }

    const diff = board.evaluateRolloutScore(ruleset, komi);
    const blackWon = diff > 0;
    const winFlag = diff > 0 ? 1.0 : diff < 0 ? 0.0 : 0.5;
    const marginBonus = 0.5 + 0.5 * Math.tanh(diff / 14.0);

    // LGRF-1 table update (only when useLgrf is enabled)
    if (profile.useLgrf) {
      for (let i = 1; i < logLen; i++) {
        const prevMove = rolloutMoveLog[i - 1];
        const replyMove = rolloutMoveLog[i];
        const replyColor = rolloutColorLog[i];
        if (prevMove >= 0 && replyMove >= 0) {
          if (replyColor === BLACK) {
            if (blackWon) lgrBlack[prevMove] = replyMove;
            else if (lgrBlack[prevMove] === replyMove) lgrBlack[prevMove] = -1;
          } else {
            if (!blackWon && diff < 0) lgrWhite[prevMove] = replyMove;
            else if (lgrWhite[prevMove] === replyMove) lgrWhite[prevMove] = -1;
          }
        }
      }
    }

    return {
      blackWinrate: 0.86 * winFlag + 0.14 * marginBonus,
      blackScoreDiff: diff,
    };
  }
}
