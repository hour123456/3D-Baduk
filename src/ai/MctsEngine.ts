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
import { computeCandidateMovesAndPriors } from './GoHeuristics';

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
}

interface DifficultyProfile {
  maxSimulations: number;
  timeBudgetMs: number;
  cPuct: number;
  raveEquiv: number; // 0 disables RAVE
  temperature: number;
  advancedTactics: boolean;
  maxChildren19: number;
}

const DIFFICULTY_PROFILES: Record<AIDifficulty, DifficultyProfile> = {
  1: {
    // 입문: 빠르고 부드러운 수읽기, 입문자도 충분히 이길 수 있는 빈틈 허용
    maxSimulations: 140,
    timeBudgetMs: 260,
    cPuct: 1.75,
    raveEquiv: 0,
    temperature: 1.15,
    advancedTactics: false,
    maxChildren19: 30,
  },
  2: {
    // 초급: 기본 단수와 포석을 갖추지만 깊은 수읽기는 생략
    maxSimulations: 520,
    timeBudgetMs: 480,
    cPuct: 1.48,
    raveEquiv: 300,
    temperature: 0.52,
    advancedTactics: false,
    maxChildren19: 38,
  },
  3: {
    // 중급: RAVE + LGRF + 행마 패턴 활성화, 자연스러운 포석과 중반 전투
    maxSimulations: 1850,
    timeBudgetMs: 920,
    cPuct: 1.32,
    raveEquiv: 800,
    temperature: 0.16,
    advancedTactics: false,
    maxChildren19: 48,
  },
  4: {
    // 고급: 축·환격·양단수 전술 판독기 + 정밀 수읽기
    maxSimulations: 4800,
    timeBudgetMs: 1650,
    cPuct: 1.24,
    raveEquiv: 1350,
    temperature: 0.04,
    advancedTactics: true,
    maxChildren19: 64,
  },
  5: {
    // 마스터: 최대 시뮬레이션 예산 + LGRF-1 + 전술/끝내기 정밀도 극대화
    maxSimulations: 10500,
    timeBudgetMs: 2400,
    cPuct: 1.16,
    raveEquiv: 1800,
    temperature: 0.0,
    advancedTactics: true,
    maxChildren19: 84,
  },
};

class MctsNode {
  public readonly moveIdx: number; // -1 = PASS
  public readonly playerJustMoved: PlayerColor;
  public readonly prior: number;
  public visits = 0;
  public valueSum = 0; // from perspective of playerJustMoved
  public amafVisits = 0;
  public amafValueSum = 0;
  public children: MctsNode[] | null = null;

  constructor(moveIdx: number, playerJustMoved: PlayerColor, prior: number) {
    this.moveIdx = moveIdx;
    this.playerJustMoved = playerJustMoved;
    this.prior = prior;
  }
}

export class MctsEngine {
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

  public chooseMove(req: AISearchRequest): AISearchResult {
    const startTime = performance.now();
    const profile = DIFFICULTY_PROFILES[req.difficulty];
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

    const { moves: rawMoves, priors: rawPriors, count: rawCount } = computeCandidateMovesAndPriors({
      board: rootBoard,
      color: aiColor,
      lastMoveIdx,
      moveCount: req.moveCount,
      forbiddenHashes,
      enableAdvancedTactics: profile.advancedTactics,
    });

    // Filter out redundant moves inside completely settled own territory
    const filteredMoves: Array<{ idx: number; prior: number }> = [];
    for (let i = 0; i < rawCount; i++) {
      const mIdx = rawMoves[i];
      if (
        req.moveCount > total * 0.35 &&
        this.isRedundantOwnTerritoryFill(req.board, size, mIdx, aiColor, currentScore.territoryMap, deadMask)
      ) {
        continue;
      }
      filteredMoves.push({ idx: mIdx, prior: rawPriors[i] });
    }

    // If no worthwhile moves remain at all -> PASS immediately!
    if (filteredMoves.length === 0) {
      return {
        coord: null,
        winrate: 0.5,
        simulations: 0,
        elapsedMs: performance.now() - startTime,
      };
    }

    // If opponent just passed and dameCount === 0 (all boundaries closed), check if any tactical atari exists; if not, pass!
    if (req.opponentPassed && currentScore.dameCount === 0 && req.moveCount >= total * 0.3) {
      let hasUrgentTactic = false;
      for (const item of filteredMoves) {
        if (item.prior > 0.18 && filteredMoves.length > 3) {
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
        };
      }
    }

    // Sort root candidates by prior descending and cap width on large boards
    filteredMoves.sort((a, b) => b.prior - a.prior);
    const maxWidth = size === 19 ? profile.maxChildren19 : size === 13 ? 52 : 81;
    const pruned = filteredMoves.slice(0, maxWidth);
    let priorSum = 0;
    for (const p of pruned) priorSum += p.prior;

    const root = new MctsNode(-1, oppColor, 1.0);
    root.children = pruned.map((p) => new MctsNode(p.idx, aiColor, priorSum > 0 ? p.prior / priorSum : 1 / pruned.length));

    // Dynamic Komi for high-handicap / large score disparity openings so rollouts stay sharp
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
    const rolloutMoveLog = new Int16Array(Math.floor(total * 1.4) + 8);
    const rolloutColorLog = new Uint8Array(Math.floor(total * 1.4) + 8);
    const pathNodes: MctsNode[] = [];

    let sims = 0;
    const deadline = startTime + profile.timeBudgetMs;

    while (sims < profile.maxSimulations) {
      if ((sims & 31) === 0 && sims > 0 && performance.now() >= deadline) {
        break;
      }

      simBoard.copyFrom(rootBoard);
      playedBlackMask.fill(0);
      playedWhiteMask.fill(0);
      pathNodes.length = 0;

      let node = root;
      pathNodes.push(node);
      let turn: PlayerColor = aiColor;
      let lastIdx = lastMoveIdx;
      let passes = req.opponentPassed ? 1 : 0;

      // 1. Selection
      while (node.children !== null && node.children.length > 0 && passes < 2) {
        const child = this.selectChild(node, profile);
        if (child.moveIdx === -1) {
          passes++;
          simBoard.koIdx = -1;
          lastIdx = null;
        } else {
          const cap = simBoard.play(child.moveIdx, turn);
          if (cap < 0) {
            child.visits += 1;
            break;
          }
          if (turn === BLACK) playedBlackMask[child.moveIdx] = 1;
          else playedWhiteMask[child.moveIdx] = 1;
          passes = 0;
          lastIdx = child.moveIdx;
        }

        node = child;
        pathNodes.push(node);
        turn = opponentColor(turn);

        if (node.children === null && node.visits >= 2 && passes < 2) {
          this.expandNode(node, simBoard, turn, lastIdx, req.moveCount + pathNodes.length, profile);
          break;
        }
        if (node.children === null) {
          break;
        }
      }

      // 2. Playout (Light-tactical simulation with LGRF-1 & zero-alloc scratch board)
      const blackUtility = this.runTacticalPlayout(
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
        rolloutColorLog
      );

      // 3. Backpropagation + RAVE (AMAF) update
      for (let i = 0; i < pathNodes.length; i++) {
        const pNode = pathNodes[i];
        pNode.visits += 1;
        const val = pNode.playerJustMoved === BLACK ? blackUtility : 1.0 - blackUtility;
        pNode.valueSum += val;

        if (profile.raveEquiv > 0 && pNode.children !== null) {
          const nextTurn = opponentColor(pNode.playerJustMoved);
          const mask = nextTurn === BLACK ? playedBlackMask : playedWhiteMask;
          const nextVal = nextTurn === BLACK ? blackUtility : 1.0 - blackUtility;
          for (let c = 0; c < pNode.children.length; c++) {
            const ch = pNode.children[c];
            if (ch.moveIdx >= 0 && mask[ch.moveIdx]) {
              ch.amafVisits += 1;
              ch.amafValueSum += nextVal;
            }
          }
        }
      }

      sims++;
    }

    // Select final move according to difficulty temperature
    const children = root.children!;
    let chosen: MctsNode = children[0];

    if (profile.temperature <= 0.02) {
      let bestScore = -1;
      for (const ch of children) {
        const q = ch.visits > 0 ? ch.valueSum / ch.visits : 0.5;
        const score = ch.visits + q * 4.0;
        if (score > bestScore) {
          bestScore = score;
          chosen = ch;
        }
      }
    } else {
      const invT = 1 / profile.temperature;
      let maxVisits = 1;
      for (const ch of children) if (ch.visits > maxVisits) maxVisits = ch.visits;

      const minRatio = req.difficulty === 1 ? 0.08 : 0.25;
      const weights: number[] = [];
      const pool: MctsNode[] = [];
      let wSum = 0;

      for (const ch of children) {
        if (ch.visits >= maxVisits * minRatio) {
          const w = Math.pow(Math.max(1, ch.visits) / maxVisits, invT);
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

    const winrate = chosen.visits > 0 ? chosen.valueSum / chosen.visits : 0.5;

    // Collect top 3 root suggestions for Hints / Winrate tracking
    const ranked = children
      .filter((c) => c.moveIdx >= 0 && c.visits > 0)
      .slice()
      .sort((a, b) => {
        const qa = a.valueSum / Math.max(1, a.visits);
        const qb = b.valueSum / Math.max(1, b.visits);
        return b.visits + qb * 4.0 - (a.visits + qa * 4.0);
      })
      .slice(0, 3)
      .map((c) => ({
        coord: { x: c.moveIdx % size, y: (c.moveIdx - (c.moveIdx % size)) / size },
        winrate: c.valueSum / Math.max(1, c.visits),
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
    };
  }

  private selectChild(parent: MctsNode, profile: DifficultyProfile): MctsNode {
    const children = parent.children!;
    const sqrtParent = Math.sqrt(Math.max(1, parent.visits));
    let best = children[0];
    let bestScore = -1e9;

    for (let i = 0; i < children.length; i++) {
      const ch = children[i];
      const q = ch.visits > 0 ? ch.valueSum / ch.visits : 0.48;

      let blendedQ = q;
      if (profile.raveEquiv > 0 && ch.amafVisits > 0) {
        const amafQ = ch.amafValueSum / ch.amafVisits;
        const beta =
          ch.amafVisits / (ch.amafVisits + ch.visits + (4 * ch.amafVisits * ch.visits) / profile.raveEquiv + 1e-5);
        blendedQ = (1 - beta) * q + beta * amafQ;
      }

      const u = profile.cPuct * ch.prior * (sqrtParent / (1 + ch.visits));
      const score = blendedQ + u;
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
    profile: DifficultyProfile
  ): void {
    const { moves, priors, count } = computeCandidateMovesAndPriors({
      board,
      color: turn,
      lastMoveIdx: lastIdx,
      moveCount,
      enableAdvancedTactics: false,
    });

    if (count === 0) {
      node.children = [new MctsNode(-1, turn, 1.0)];
      return;
    }

    const items: Array<{ idx: number; prior: number }> = [];
    for (let i = 0; i < count; i++) {
      items.push({ idx: moves[i], prior: priors[i] });
    }
    items.sort((a, b) => b.prior - a.prior);

    const cap = board.size === 19 ? Math.min(32, profile.maxChildren19) : 28;
    const sliced = items.slice(0, cap);
    let sum = 0;
    for (const s of sliced) sum += s.prior;

    node.children = sliced.map((s) => new MctsNode(s.idx, turn, sum > 0 ? s.prior / sum : 1 / sliced.length));
  }

  /**
   * Light-tactical Monte Carlo rollout returning utility in [0, 1] for BLACK.
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
    rolloutColorLog: Uint8Array
  ): number {
    const total = board.total;
    const maxSteps = Math.floor(total * 1.35);
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

    let rng = ((Date.now() ^ (emptyCount * 2654435761)) >>> 0) || 1234567;
    const nextRand = (bound: number) => {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return rng % bound;
    };

    for (let step = 0; step < maxSteps && passes < 2; step++) {
      let chosenMove = -1;
      const opp = opponentColor(turn);

      // A) Local tactical check around opponent's last move
      if (lastIdx !== null && lastIdx >= 0 && board.grid[lastIdx] === opp) {
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

        // B) LGRF-1 Last Good Reply lookup
        if (chosenMove < 0) {
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

      // C) Randomized scan of empty intersections avoiding eyes and blatant self-atari
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
            if (cap >= 0 && (cap > 0 || scratch.analyzeChain(cell, 2).libertyCount >= 2)) {
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

    // LGRF-1 table update
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

    return 0.86 * winFlag + 0.14 * marginBonus;
  }
}
