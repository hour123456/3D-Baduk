export interface KataGoInputPosition {
  board: Uint8Array; // 0=EMPTY, 1=BLACK, 2=WHITE, length size*size (y * size + x)
  size: number;
  pla: 1 | 2;
  ruleset: 'korean' | 'chinese';
  komi: number;
  koPoint: { x: number; y: number } | null;
  moveHistory?: Array<{ color: 1 | 2; coord: { x: number; y: number } | null }>;
  lastMove: { x: number; y: number } | null;
  opponentPassed: boolean;
}

export const NUM_KATAGO_SPATIAL_FEATURES = 22;
export const NUM_KATAGO_GLOBAL_FEATURES = 19;

interface FeatureScratch {
  size: number;
  area: number;
  neighbors: Int16Array; // [idx * 4 + 0..3], -1 terminated
  symTable: Int16Array; // [sym * area + idx] -> symIdx
  visited: Int32Array;
  libStamp: Int32Array;
  stack: Int16Array;
  chainLibs: Uint16Array; // per-cell chain liberty count (0 for empty)
  chainHead: Int16Array; // per-cell chain head idx (-1 for empty)
  chainNext: Int16Array; // linked list of stones in chain
  ladderWorking: Uint8Array;
  areaOwner: Uint8Array;
  simBoard: Uint8Array;
  prevBoard1: Uint8Array;
  prevBoard2: Uint8Array;
  bensonRegionId: Int16Array;
  bensonVitalCount: Int16Array;
  bensonRegionEliminated: Uint8Array;
  bensonChainEliminated: Uint8Array;
  bensonRegionColor: Uint8Array;
}

const SCRATCH_BY_SIZE = new Map<number, FeatureScratch>();

function buildSymTable(size: number): Int16Array {
  const area = size * size;
  const table = new Int16Array(8 * area);
  for (let sym = 0; sym < 8; sym++) {
    const transpose = (sym & 4) !== 0;
    const flipX = (sym & 2) !== 0;
    const flipY = (sym & 1) !== 0;
    const base = sym * area;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sx = flipX ? size - 1 - x : x;
        let sy = flipY ? size - 1 - y : y;
        if (transpose) {
          const tmp = sx;
          sx = sy;
          sy = tmp;
        }
        table[base + y * size + x] = sy * size + sx;
      }
    }
  }
  return table;
}

function getScratch(size: number): FeatureScratch {
  const existing = SCRATCH_BY_SIZE.get(size);
  if (existing) return existing;

  const area = size * size;
  const neighbors = new Int16Array(area * 4).fill(-1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      let k = 0;
      if (x > 0) neighbors[idx * 4 + k++] = idx - 1;
      if (x < size - 1) neighbors[idx * 4 + k++] = idx + 1;
      if (y > 0) neighbors[idx * 4 + k++] = idx - size;
      if (y < size - 1) neighbors[idx * 4 + k++] = idx + size;
    }
  }

  const scratch: FeatureScratch = {
    size,
    area,
    neighbors,
    symTable: buildSymTable(size),
    visited: new Int32Array(area),
    libStamp: new Int32Array(area),
    stack: new Int16Array(area),
    chainLibs: new Uint16Array(area),
    chainHead: new Int16Array(area),
    chainNext: new Int16Array(area),
    ladderWorking: new Uint8Array(area),
    areaOwner: new Uint8Array(area),
    simBoard: new Uint8Array(area),
    prevBoard1: new Uint8Array(area),
    prevBoard2: new Uint8Array(area),
    bensonRegionId: new Int16Array(area),
    bensonVitalCount: new Int16Array(area),
    bensonRegionEliminated: new Uint8Array(area),
    bensonChainEliminated: new Uint8Array(area),
    bensonRegionColor: new Uint8Array(area),
  };
  SCRATCH_BY_SIZE.set(size, scratch);
  return scratch;
}

let stampCounter = 1;
function nextStamp(s: FeatureScratch): number {
  stampCounter++;
  if (stampCounter >= 0x7fffffff) {
    s.visited.fill(0);
    s.libStamp.fill(0);
    stampCounter = 1;
  }
  return stampCounter;
}

/**
 * Compute chainHead, chainNext, and chainLibs for every occupied intersection on `board`.
 */
function computeChains(board: Uint8Array, s: FeatureScratch): void {
  const { area, neighbors, visited, libStamp, stack, chainLibs, chainHead, chainNext } = s;
  const vStamp = nextStamp(s);
  chainHead.fill(-1);
  chainLibs.fill(0);

  for (let i = 0; i < area; i++) {
    const color = board[i];
    if (color === 0 || visited[i] === vStamp) continue;

    const lStamp = nextStamp(s);
    let libs = 0;
    let sp = 0;
    let prevStone = -1;
    const head = i;
    stack[sp++] = i;
    visited[i] = vStamp;

    while (sp > 0) {
      const idx = stack[--sp];
      chainHead[idx] = head;
      if (prevStone !== -1) {
        chainNext[prevStone] = idx;
      }
      prevStone = idx;

      const nBase = idx * 4;
      for (let k = 0; k < 4; k++) {
        const n = neighbors[nBase + k];
        if (n < 0) break;
        const nc = board[n];
        if (nc === 0) {
          if (libStamp[n] !== lStamp) {
            libStamp[n] = lStamp;
            libs++;
          }
        } else if (nc === color && visited[n] !== vStamp) {
          visited[n] = vStamp;
          stack[sp++] = n;
        }
      }
    }
    chainNext[prevStone] = -1;

    // Assign liberty count to all stones in chain
    let cur = head;
    while (cur !== -1) {
      chainLibs[cur] = libs;
      cur = chainNext[cur];
    }
  }
}

/**
 * Lightweight undoable board for exact move replay and KataGo ladder search.
 */
class MiniBoard {
  public readonly size: number;
  public readonly area: number;
  public readonly board: Uint8Array;
  public koIdx = -1;
  private readonly neighbors: Int16Array;
  private readonly visited: Int32Array;
  private readonly libStamp: Int32Array;
  private readonly stack: Int16Array;
  private stamp = 1;

  constructor(size: number, neighbors: Int16Array, initial?: Uint8Array) {
    this.size = size;
    this.area = size * size;
    this.board = new Uint8Array(this.area);
    if (initial) this.board.set(initial);
    this.neighbors = neighbors;
    this.visited = new Int32Array(this.area);
    this.libStamp = new Int32Array(this.area);
    this.stack = new Int16Array(this.area);
  }

  private nextSt(): number {
    this.stamp++;
    if (this.stamp >= 0x7fffffff) {
      this.visited.fill(0);
      this.libStamp.fill(0);
      this.stamp = 1;
    }
    return this.stamp;
  }

  public getChainInfo(startIdx: number, outLibs?: number[]): { libs: number; stones: number[] } {
    const color = this.board[startIdx];
    const stones: number[] = [];
    if (color === 0) return { libs: 0, stones };
    const vs = this.nextSt();
    const ls = this.nextSt();
    let libs = 0;
    let sp = 0;
    this.stack[sp++] = startIdx;
    this.visited[startIdx] = vs;

    while (sp > 0) {
      const idx = this.stack[--sp];
      stones.push(idx);
      const nb = idx * 4;
      for (let k = 0; k < 4; k++) {
        const n = this.neighbors[nb + k];
        if (n < 0) break;
        const nc = this.board[n];
        if (nc === 0) {
          if (this.libStamp[n] !== ls) {
            this.libStamp[n] = ls;
            libs++;
            if (outLibs) outLibs.push(n);
          }
        } else if (nc === color && this.visited[n] !== vs) {
          this.visited[n] = vs;
          this.stack[sp++] = n;
        }
      }
    }
    return { libs, stones };
  }

  public isLegal(idx: number, color: 1 | 2): boolean {
    if (idx < 0 || idx >= this.area || this.board[idx] !== 0 || idx === this.koIdx) return false;
    const opp = color === 1 ? 2 : 1;
    const nb = idx * 4;
    for (let k = 0; k < 4; k++) {
      const n = this.neighbors[nb + k];
      if (n < 0) break;
      if (this.board[n] === 0) return true;
    }
    // Check if it captures an opponent group or joins a friendly group with >= 2 liberties
    this.board[idx] = color;
    let hasCapture = false;
    for (let k = 0; k < 4; k++) {
      const n = this.neighbors[nb + k];
      if (n < 0) break;
      if (this.board[n] === opp) {
        if (this.getChainInfo(n).libs === 0) {
          hasCapture = true;
          break;
        }
      }
    }
    const selfLibs = hasCapture ? 1 : this.getChainInfo(idx).libs;
    this.board[idx] = 0;
    return hasCapture || selfLibs > 0;
  }

  public play(idx: number, color: 1 | 2): { prevKo: number; captured: number[]; oppColor: 1 | 2 } {
    const prevKo = this.koIdx;
    const oppColor: 1 | 2 = color === 1 ? 2 : 1;
    this.board[idx] = color;
    const captured: number[] = [];
    const nb = idx * 4;
    for (let k = 0; k < 4; k++) {
      const n = this.neighbors[nb + k];
      if (n < 0) break;
      if (this.board[n] === oppColor) {
        const info = this.getChainInfo(n);
        if (info.libs === 0) {
          for (const st of info.stones) {
            this.board[st] = 0;
            captured.push(st);
          }
        }
      }
    }
    // Simple ko check
    if (captured.length === 1) {
      const selfInfo = this.getChainInfo(idx);
      if (selfInfo.stones.length === 1 && selfInfo.libs === 1) {
        this.koIdx = captured[0];
      } else {
        this.koIdx = -1;
      }
    } else {
      this.koIdx = -1;
    }
    return { prevKo, captured, oppColor };
  }

  public undo(idx: number, rec: { prevKo: number; captured: number[]; oppColor: 1 | 2 }): void {
    this.board[idx] = 0;
    for (const st of rec.captured) {
      this.board[st] = rec.oppColor;
    }
    this.koIdx = rec.prevKo;
  }

  public findLibertyGainingCaptures(targetIdx: number): number[] {
    const defColor = this.board[targetIdx];
    const oppColor = defColor === 1 ? 2 : 1;
    const defChain = this.getChainInfo(targetIdx);
    const seenCap = new Set<number>();
    const moves: number[] = [];
    for (const st of defChain.stones) {
      const nb = st * 4;
      for (let k = 0; k < 4; k++) {
        const n = this.neighbors[nb + k];
        if (n < 0) break;
        if (this.board[n] === oppColor) {
          const adjOpp = this.getChainInfo(n);
          if (adjOpp.libs === 1) {
            const libOut: number[] = [];
            this.getChainInfo(n, libOut);
            const capPt = libOut[0];
            if (capPt !== undefined && !seenCap.has(capPt)) {
              seenCap.add(capPt);
              moves.push(capPt);
            }
          }
        }
      }
    }
    return moves;
  }

  public countImmediateLiberties(idx: number): number {
    let count = 0;
    const nb = idx * 4;
    for (let k = 0; k < 4; k++) {
      const n = this.neighbors[nb + k];
      if (n < 0) break;
      if (this.board[n] === 0) count++;
    }
    return count;
  }

  public searchIsLadderCaptured(targetIdx: number, defenderFirst: boolean, budget = { nodes: 0 }): boolean {
    const defColor = this.board[targetIdx] as 1 | 2;
    if (defColor !== 1 && defColor !== 2) return false;
    const attColor: 1 | 2 = defColor === 1 ? 2 : 1;

    const savedKo = this.koIdx;
    if (defenderFirst) this.koIdx = -1;

    const maxDepth = Math.min(this.area * 3 / 2 + 1, 96);

    const recurse = (isDefender: boolean, depth: number): boolean => {
      if (depth >= maxDepth) return true; // Stack limit -> treat as failed ladder? Wait: match C++: false if attacker? C++ returns true at stack limit
      if (budget.nodes >= 4000) return false;

      if (this.board[targetIdx] !== defColor) return true;
      const libsArr: number[] = [];
      const info = this.getChainInfo(targetIdx, libsArr);
      const libs = info.libs;

      if (!isDefender && libs <= 1) return true;
      if (!isDefender && libs >= 3) return false;
      if (isDefender && libs >= 2) return false;
      if (isDefender && this.koIdx !== -1) return false;

      if (isDefender) {
        const capMoves = this.findLibertyGainingCaptures(targetIdx);
        const candidates = capMoves.concat(libsArr);
        for (const m of candidates) {
          if (!this.isLegal(m, defColor)) continue;
          const rec = this.play(m, defColor);
          budget.nodes++;
          const captured = recurse(false, depth + 1);
          this.undo(m, rec);
          if (!captured) return false; // Defender escaped
        }
        return true; // All defender replies fail
      } else {
        // Attacker has 2 liberties
        let m0 = libsArr[0];
        let m1 = libsArr[1];
        if (m0 === undefined || m1 === undefined) return true;

        const imm0 = this.countImmediateLiberties(m0);
        const imm1 = this.countImmediateLiberties(m1);
        const adj =
          Math.abs((m0 % this.size) - (m1 % this.size)) +
            Math.abs(Math.floor(m0 / this.size) - Math.floor(m1 / this.size)) ===
          1;
        if (!adj) {
          if (imm0 >= 3 && imm1 >= 3) return false;
        }
        // Try tighter move first
        if (imm1 < imm0) {
          const tmp = m0;
          m0 = m1;
          m1 = tmp;
        }
        const order = !adj && imm0 >= 3 ? [m1] : !adj && imm1 >= 3 ? [m0] : [m0, m1];
        for (const m of order) {
          if (!this.isLegal(m, attColor)) continue;
          const rec = this.play(m, attColor);
          budget.nodes++;
          const captured = recurse(true, depth + 1);
          this.undo(m, rec);
          if (captured) return true; // Attacker succeeds
        }
        return false;
      }
    };

    const res = recurse(defenderFirst, 0);
    this.koIdx = savedKo;
    return res;
  }

  public searchIsLadderCapturedAttackerFirst2Libs(targetIdx: number): number[] {
    const working: number[] = [];
    const defColor = this.board[targetIdx];
    if (defColor !== 1 && defColor !== 2) return working;
    const attColor: 1 | 2 = defColor === 1 ? 2 : 1;
    const libsArr: number[] = [];
    const info = this.getChainInfo(targetIdx, libsArr);
    if (info.libs !== 2) return working;

    for (const m of libsArr) {
      if (!this.isLegal(m, attColor)) continue;
      const rec = this.play(m, attColor);
      const works = this.searchIsLadderCaptured(targetIdx, true);
      this.undo(m, rec);
      if (works) working.push(m);
    }
    return working;
  }
}

/**
 * Mark ladder features (planes 14/15/16 for laddered chains, plane 17 for attacker working moves on current board).
 */
function markLadderFeatures(
  board: Uint8Array,
  pla: 1 | 2,
  s: FeatureScratch,
  binInputs: Float32Array,
  symBase: number,
  planeOffset: number,
  markWorkingOnPlane17: boolean
): void {
  const { area, neighbors, symTable, visited, stack, chainHead, chainNext, chainLibs } = s;
  computeChains(board, s);

  const mb = new MiniBoard(s.size, neighbors, board);
  const solvedHead = new Map<number, boolean>();
  const opp: 1 | 2 = pla === 1 ? 2 : 1;

  for (let i = 0; i < area; i++) {
    const color = board[i];
    if (color === 0) continue;
    const libs = chainLibs[i];
    if (libs !== 1 && libs !== 2) continue;
    const head = chainHead[i];
    if (solvedHead.has(head)) continue;

    let laddered = false;
    let workingMoves: number[] = [];
    if (libs === 1) {
      laddered = mb.searchIsLadderCaptured(i, true);
    } else {
      workingMoves = mb.searchIsLadderCapturedAttackerFirst2Libs(i);
      laddered = workingMoves.length > 0;
    }
    solvedHead.set(head, laddered);

    if (laddered) {
      const planeBase = planeOffset * area;
      let cur = head;
      while (cur !== -1) {
        binInputs[planeBase + symTable[symBase + cur]] = 1.0;
        cur = chainNext[cur];
      }
      if (markWorkingOnPlane17 && color === opp) {
        const p17Base = 17 * area;
        for (const wm of workingMoves) {
          binInputs[p17Base + symTable[symBase + wm]] = 1.0;
        }
      }
    }
  }
  void visited;
  void stack;
}

/**
 * Compute KataGo `calculateArea(..., nonPassAliveStones=true, safeBigTerritories=true, unsafeBigTerritories=true)`
 * for Chinese area scoring (planes 18 and 19).
 */
function computeChineseArea(board: Uint8Array, s: FeatureScratch): void {
  const { area, neighbors, areaOwner, stack, visited } = s;
  areaOwner.fill(0);

  // Pass 1: Benson's pass-alive stones & small vital regions for each color
  for (let color = 1 as 1 | 2; color <= 2; color = (color + 1) as 1 | 2) {
    const opp = color === 1 ? 2 : 1;
    computeChains(board, s);

    const chains: number[] = [];
    const chainToIdx = new Map<number, number>();
    for (let i = 0; i < area; i++) {
      if (board[i] === color) {
        const h = s.chainHead[i];
        if (!chainToIdx.has(h)) {
          chainToIdx.set(h, chains.length);
          chains.push(h);
        }
      }
    }
    if (chains.length === 0) continue;

    // Identify connected empty-or-opp regions
    const regionId = s.bensonRegionId;
    regionId.fill(-1);
    const regions: number[][] = [];
    const regionAdjacentChains: Set<number>[] = [];
    const regionVitalChains: number[][] = [];

    const vs = nextStamp(s);
    for (let i = 0; i < area; i++) {
      if (board[i] === color || visited[i] === vs) continue;
      const rId = regions.length;
      const cells: number[] = [];
      const adjChains = new Set<number>();
      let sp = 0;
      stack[sp++] = i;
      visited[i] = vs;

      while (sp > 0) {
        const idx = stack[--sp];
        regionId[idx] = rId;
        cells.push(idx);
        const nb = idx * 4;
        for (let k = 0; k < 4; k++) {
          const n = neighbors[nb + k];
          if (n < 0) break;
          if (board[n] === color) {
            adjChains.add(chainToIdx.get(s.chainHead[n])!);
          } else if (visited[n] !== vs) {
            visited[n] = vs;
            stack[sp++] = n;
          }
        }
      }

      // Check which adjacent chains are vital to this region:
      // a chain C is vital to region R if every empty cell in R is adjacent to C.
      const vitalChains: number[] = [];
      for (const cIdx of adjChains) {
        const cHead = chains[cIdx];
        let allEmptyAdj = true;
        for (const cell of cells) {
          if (board[cell] !== 0) continue;
          let touchesC = false;
          const nb = cell * 4;
          for (let k = 0; k < 4; k++) {
            const n = neighbors[nb + k];
            if (n < 0) break;
            if (board[n] === color && s.chainHead[n] === cHead) {
              touchesC = true;
              break;
            }
          }
          if (!touchesC) {
            allEmptyAdj = false;
            break;
          }
        }
        if (allEmptyAdj && cells.some((cell) => board[cell] === 0)) {
          vitalChains.push(cIdx);
        }
      }

      regions.push(cells);
      regionAdjacentChains.push(adjChains);
      regionVitalChains.push(vitalChains);
    }

    const chainElim = new Uint8Array(chains.length);
    const regionElim = new Uint8Array(regions.length);
    const vitalCounts = new Int16Array(chains.length);

    for (let r = 0; r < regions.length; r++) {
      for (const cIdx of regionVitalChains[r]) {
        vitalCounts[cIdx]++;
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (let c = 0; c < chains.length; c++) {
        if (!chainElim[c] && vitalCounts[c] < 2) {
          chainElim[c] = 1;
          changed = true;
          // Any region adjacent to an eliminated chain is eliminated
          for (let r = 0; r < regions.length; r++) {
            if (!regionElim[r] && regionAdjacentChains[r].has(c)) {
              regionElim[r] = 1;
              for (const vc of regionVitalChains[r]) {
                vitalCounts[vc]--;
              }
            }
          }
        }
      }
    }

    // Mark pass-alive chains and pass-alive regions
    for (let c = 0; c < chains.length; c++) {
      if (!chainElim[c]) {
        let cur = chains[c];
        while (cur !== -1) {
          areaOwner[cur] = color;
          cur = s.chainNext[cur];
        }
      }
    }
    for (let r = 0; r < regions.length; r++) {
      if (!regionElim[r]) {
        for (const cell of regions[r]) {
          areaOwner[cell] = color;
        }
      }
    }

    // Pass 2: safeBigTerritories & unsafeBigTerritories (empty regions bordered only by `color`)
    const es = nextStamp(s);
    for (let i = 0; i < area; i++) {
      if (board[i] !== 0 || visited[i] === es) continue;
      let sp = 0;
      const comp: number[] = [];
      let touchesColor = false;
      let touchesOpp = false;
      stack[sp++] = i;
      visited[i] = es;

      while (sp > 0) {
        const idx = stack[--sp];
        comp.push(idx);
        const nb = idx * 4;
        for (let k = 0; k < 4; k++) {
          const n = neighbors[nb + k];
          if (n < 0) break;
          const nc = board[n];
          if (nc === 0) {
            if (visited[n] !== es) {
              visited[n] = es;
              stack[sp++] = n;
            }
          } else if (nc === color) {
            touchesColor = true;
          } else if (nc === opp) {
            touchesOpp = true;
          }
        }
      }

      if (touchesColor && !touchesOpp) {
        for (const cell of comp) {
          if (areaOwner[cell] === 0) {
            areaOwner[cell] = color;
          }
        }
      }
    }
  }

  // nonPassAliveStones = true: any stone not yet claimed belongs to its own color
  for (let i = 0; i < area; i++) {
    if (areaOwner[i] === 0 && board[i] !== 0) {
      areaOwner[i] = board[i];
    }
  }
}

/**
 * Reconstruct `prevBoard1` and `prevBoard2` if `moveHistory` cleanly reproduces `pos.board`.
 */
function resolveRecentBoards(
  pos: KataGoInputPosition,
  s: FeatureScratch
): { hasPrev1: boolean; hasPrev2: boolean } {
  const history = pos.moveHistory;
  if (!history || history.length === 0) {
    return { hasPrev1: false, hasPrev2: false };
  }

  const mb = new MiniBoard(pos.size, s.neighbors);
  const n = history.length;
  for (let i = 0; i < n; i++) {
    if (i === n - 1) s.prevBoard1.set(mb.board);
    if (i === n - 2) s.prevBoard2.set(mb.board);
    const mv = history[i];
    if (mv.coord !== null) {
      const idx = mv.coord.y * pos.size + mv.coord.x;
      if (idx >= 0 && idx < s.area && mb.board[idx] === 0) {
        mb.play(idx, mv.color);
      } else {
        return { hasPrev1: false, hasPrev2: false };
      }
    } else {
      mb.koIdx = -1;
    }
  }

  // Verify exact match with current board
  for (let i = 0; i < s.area; i++) {
    if (mb.board[i] !== pos.board[i]) {
      return { hasPrev1: false, hasPrev2: false };
    }
  }
  return { hasPrev1: n >= 1, hasPrev2: n >= 2 };
}

/**
 * Encode KataGo V7 inputs into caller-provided `binInputs` and `globalInputs` buffers.
 * `binInputs` layout is planar CHW: `[22 * size * size]`.
 */
export function encodeKataGoV7InputsInto(
  pos: KataGoInputPosition,
  symmetry: number,
  binInputs: Float32Array,
  globalInputs: Float32Array
): void {
  const size = pos.size;
  const area = size * size;
  const sym = ((symmetry % 8) + 8) % 8;
  const s = getScratch(size);
  const symBase = sym * area;
  const { symTable } = s;

  binInputs.fill(0);
  globalInputs.fill(0);

  const pla = pos.pla;
  const opp: 1 | 2 = pla === 1 ? 2 : 1;

  // Compute chains and liberties on current board
  computeChains(pos.board, s);

  const p0 = 0;
  const p1 = area;
  const p2 = 2 * area;
  const p3 = 3 * area;
  const p4 = 4 * area;
  const p5 = 5 * area;

  for (let i = 0; i < area; i++) {
    const dstIdx = symTable[symBase + i];
    // Plane 0: on-board indicator
    binInputs[p0 + dstIdx] = 1.0;

    const stone = pos.board[i];
    if (stone === pla) {
      binInputs[p1 + dstIdx] = 1.0;
    } else if (stone === opp) {
      binInputs[p2 + dstIdx] = 1.0;
    }

    if (stone !== 0) {
      const libs = s.chainLibs[i];
      if (libs === 1) binInputs[p3 + dstIdx] = 1.0;
      else if (libs === 2) binInputs[p4 + dstIdx] = 1.0;
      else if (libs === 3) binInputs[p5 + dstIdx] = 1.0;
    }
  }

  // Plane 6: ko-ban point
  if (pos.koPoint !== null) {
    const kIdx = pos.koPoint.y * size + pos.koPoint.x;
    if (kIdx >= 0 && kIdx < area) {
      binInputs[6 * area + symTable[symBase + kIdx]] = 1.0;
    }
  }

  // Planes 9..13 & Global 0..4: recent up to 5 moves
  let numHistoryIncluded = 0;
  if (pos.moveHistory && pos.moveHistory.length > 0) {
    const h = pos.moveHistory;
    for (let k = 0; k < 5 && k < h.length; k++) {
      const mv = h[h.length - 1 - k];
      const expectedColor: 1 | 2 = k % 2 === 0 ? opp : pla;
      if (mv.color !== expectedColor) break;
      numHistoryIncluded++;
      if (mv.coord === null) {
        globalInputs[k] = 1.0;
      } else {
        const mIdx = mv.coord.y * size + mv.coord.x;
        if (mIdx >= 0 && mIdx < area) {
          binInputs[(9 + k) * area + symTable[symBase + mIdx]] = 1.0;
        }
      }
    }
  } else if (pos.opponentPassed) {
    globalInputs[0] = 1.0;
    numHistoryIncluded = 1;
  } else if (pos.lastMove !== null) {
    const mIdx = pos.lastMove.y * size + pos.lastMove.x;
    if (mIdx >= 0 && mIdx < area) {
      binInputs[9 * area + symTable[symBase + mIdx]] = 1.0;
      numHistoryIncluded = 1;
    }
  }

  // Planes 14..17: ladder features on current, prev1, prev2 boards
  markLadderFeatures(pos.board, pla, s, binInputs, symBase, 14, true);

  const recent = numHistoryIncluded >= 1 ? resolveRecentBoards(pos, s) : { hasPrev1: false, hasPrev2: false };
  const prevBoard1 = recent.hasPrev1 ? s.prevBoard1 : pos.board;
  markLadderFeatures(prevBoard1, pla, s, binInputs, symBase, 15, false);

  const prevBoard2 =
    numHistoryIncluded >= 2 && recent.hasPrev2 ? s.prevBoard2 : prevBoard1;
  markLadderFeatures(prevBoard2, pla, s, binInputs, symBase, 16, false);

  // Planes 18..19: Chinese area features (omitted during normal play under Korean territory rules)
  if (pos.ruleset === 'chinese') {
    computeChineseArea(pos.board, s);
    const p18 = 18 * area;
    const p19 = 19 * area;
    for (let i = 0; i < area; i++) {
      const owner = s.areaOwner[i];
      if (owner === pla) {
        binInputs[p18 + symTable[symBase + i]] = 1.0;
      } else if (owner === opp) {
        binInputs[p19 + symTable[symBase + i]] = 1.0;
      }
    }
  }

  // Global 5: selfKomi / 20.0
  let selfKomi = pla === 2 ? pos.komi : -pos.komi;
  const maxKomi = area + 20.0;
  if (selfKomi > maxKomi) selfKomi = maxKomi;
  if (selfKomi < -maxKomi) selfKomi = -maxKomi;
  globalInputs[5] = selfKomi / 20.0;

  // Global 6..8: koRule = KO_SIMPLE (0, 0), multiStoneSuicideLegal = false (0)
  // Global 9..11: scoring & tax rules
  if (pos.ruleset === 'korean') {
    globalInputs[9] = 1.0; // SCORING_TERRITORY
    globalInputs[10] = 1.0; // TAX_SEKI
  }

  // Global 14: passWouldEndPhase (opponent passed immediately prior)
  const prevWasPass =
    pos.moveHistory && pos.moveHistory.length > 0
      ? pos.moveHistory[pos.moveHistory.length - 1].color === opp &&
        pos.moveHistory[pos.moveHistory.length - 1].coord === null
      : pos.opponentPassed;
  globalInputs[14] = prevWasPass ? 1.0 : 0.0;

  // Global 18: komi parity triangle wave (only for SCORING_AREA in normal play)
  if (pos.ruleset === 'chinese') {
    const drawableKomisAreEven = area % 2 === 0;
    const komiFloor = drawableKomisAreEven
      ? Math.floor(selfKomi / 2.0) * 2.0
      : Math.floor((selfKomi - 1.0) / 2.0) * 2.0 + 1.0;
    let delta = selfKomi - komiFloor;
    if (delta < 0.0) delta = 0.0;
    if (delta > 2.0) delta = 2.0;

    let wave = 0.0;
    if (delta < 0.5) wave = delta;
    else if (delta < 1.5) wave = 1.0 - delta;
    else wave = delta - 2.0;

    globalInputs[18] = wave;
  }
}

/**
 * Encode KataGo Model v8 (V7 inputs) spatial and global feature tensors.
 */
export function encodeKataGoV7Inputs(
  pos: KataGoInputPosition,
  symmetry = 0
): { binInputs: Float32Array; globalInputs: Float32Array } {
  const binInputs = new Float32Array(NUM_KATAGO_SPATIAL_FEATURES * pos.size * pos.size);
  const globalInputs = new Float32Array(NUM_KATAGO_GLOBAL_FEATURES);
  encodeKataGoV7InputsInto(pos, symmetry, binInputs, globalInputs);
  return { binInputs, globalInputs };
}
