import {
  BLACK,
  BoardSize,
  Coord,
  EMPTY,
  OmokRulesetType,
  opponentColor,
  PlayerColor,
  WHITE,
} from '../../rules/types';
import { checkRenjuForbidden, checkWinAt } from '../../rules/GomokuEngine';

export const KATA_OMOK_INPUT_PLANES = 18;
export const KATA_OMOK_GLOBAL_FEATURES = 8;
const TRUNK_CHANNELS = 32;
const MAX_BOARD_SIZE = 19;
const MAX_AREA = MAX_BOARD_SIZE * MAX_BOARD_SIZE;

const AXES: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

export interface KataOmokEncodedInputs {
  binInputs: Float32Array;
  globalInputs: Float32Array;
  forbiddenMask: Uint8Array;
}

export interface KataOmokEval {
  policyProbs: Float32Array;
  policyLogits: Float32Array;
  winrate: number;
  utility: number;
  ownership: Float32Array;
  forbiddenMask: Uint8Array;
}

interface AxisPatternInfo {
  win: boolean;
  overline: boolean;
  open4: boolean;
  fourThreats: number;
  open3: boolean;
  split3: boolean;
}

interface SparseStemEntry {
  c: number;
  p: number;
  w: number;
}

interface SparseMixEntry {
  oc: number;
  ic: number;
  w: number;
}

interface SparseGpoolEntry {
  c: number;
  f: number;
  w: number;
}

interface SparseValueEntry {
  f: number;
  w0: number;
  w1: number;
  w2: number;
}

/**
 * Deterministic KataGo / KataGomo-style weights for 15x15 (up to 19x19) Omok & Renju:
 * - Input stem: 18 spatial planes + 8 global features -> 32 trunk channels
 * - 2 Residual blocks: KataGo gpool conditioning + 3x3 depthwise spatial conv + 1x1 channel mix
 * - Policy head, [Win, Loss, Draw] Value head, and cell Ownership head
 */
interface KataOmokWeights {
  stemW: Float32Array; // [32 * 18]
  stemGlobalW: Float32Array; // [32 * 8]
  stemB: Float32Array; // [32]
  stemNonZero: SparseStemEntry[];
  stemGlobalNonZero: SparseGpoolEntry[];

  res1GpoolW: Float32Array; // [32 * (32*3 + 8)]
  res1SpatialW: Float32Array; // [32 * 9]
  res1MixW: Float32Array; // [32 * 32]
  res1B: Float32Array; // [32]
  res1GpoolNonZero: SparseGpoolEntry[];
  res1SpatialChannels: number[];
  res1IdentityChannels: number[];
  res1MixNonZero: SparseMixEntry[];

  res2GpoolW: Float32Array; // [32 * (32*3 + 8)]
  res2SpatialW: Float32Array; // [32 * 9]
  res2MixW: Float32Array; // [32 * 32]
  res2B: Float32Array; // [32]
  res2GpoolNonZero: SparseGpoolEntry[];
  res2SpatialChannels: number[];
  res2IdentityChannels: number[];
  res2MixNonZero: SparseMixEntry[];

  policyW: Float32Array; // [32]
  policyGlobalW: Float32Array; // [8]
  policyActiveChannels: number[];
  valueW: Float32Array; // [3 * (32*3 + 8)] -> [Win, Loss, Draw]
  valueB: Float32Array; // [3]
  valueNonZero: SparseValueEntry[];
  ownershipW: Float32Array; // [32]
  ownershipB: number;
  ownershipActiveChannels: number[];
}

interface KataOmokWorkspace {
  binInputs: Float32Array;
  globalInputs: Float32Array;
  forbiddenMask: Uint8Array;
  nearMask: Uint8Array;
  trunkA: Float32Array;
  trunkB: Float32Array;
  spatialScratch: Float32Array;
  gpoolFeatures: Float32Array; // [32*3 + 8 = 104]
  gpoolBias: Float32Array; // [32]
}

const WORKSPACE: KataOmokWorkspace = {
  binInputs: new Float32Array(KATA_OMOK_INPUT_PLANES * MAX_AREA),
  globalInputs: new Float32Array(KATA_OMOK_GLOBAL_FEATURES),
  forbiddenMask: new Uint8Array(MAX_AREA),
  nearMask: new Uint8Array(MAX_AREA),
  trunkA: new Float32Array(TRUNK_CHANNELS * MAX_AREA),
  trunkB: new Float32Array(TRUNK_CHANNELS * MAX_AREA),
  spatialScratch: new Float32Array(TRUNK_CHANNELS * MAX_AREA),
  gpoolFeatures: new Float32Array(TRUNK_CHANNELS * 3 + KATA_OMOK_GLOBAL_FEATURES),
  gpoolBias: new Float32Array(TRUNK_CHANNELS),
};

function buildCalibratedWeights(): KataOmokWeights {
  const C = TRUNK_CHANNELS;
  const P = KATA_OMOK_INPUT_PLANES;
  const G = KATA_OMOK_GLOBAL_FEATURES;
  const GPOOL_DIM = C * 3 + G; // 104

  const stemW = new Float32Array(C * P);
  const stemGlobalW = new Float32Array(C * G);
  const stemB = new Float32Array(C);

  for (let i = 0; i < P; i++) {
    stemW[i * P + i] = 1.0;
  }

  stemW[18 * P + 1] = 1.0;
  stemW[19 * P + 2] = 1.0;
  stemW[20 * P + 3] = 2.0;

  stemW[21 * P + 5] = 4.0;
  stemW[21 * P + 6] = 3.5;
  stemW[21 * P + 7] = 2.5;
  stemW[21 * P + 8] = 2.0;

  stemW[22 * P + 5] = 3.0;
  stemW[22 * P + 7] = 2.4;
  stemW[22 * P + 9] = 1.1;
  stemW[22 * P + 11] = 1.0;
  stemW[22 * P + 13] = 0.85;
  stemW[22 * P + 15] = 1.9;

  stemW[23 * P + 6] = 2.8;
  stemW[23 * P + 8] = 2.1;
  stemW[23 * P + 10] = 0.85;
  stemW[23 * P + 12] = 1.05;
  stemW[23 * P + 14] = 0.88;
  stemW[23 * P + 16] = 1.75;

  stemW[24 * P + 11] = 0.6;
  stemW[24 * P + 13] = 0.5;
  stemW[24 * P + 15] = 2.2;
  stemW[24 * P + 16] = 1.8;

  stemW[25 * P + 17] = 1.0;

  stemW[26 * P + 4] = 1.2;
  stemGlobalW[26 * G + 0] = 0.15;
  stemGlobalW[26 * G + 1] = -0.35;

  stemW[27 * P + 9] = 0.7;
  stemW[27 * P + 11] = 0.8;
  stemW[27 * P + 12] = 0.8;
  stemW[27 * P + 13] = 0.6;
  stemW[27 * P + 14] = 0.6;
  stemW[27 * P + 15] = 1.1;
  stemW[27 * P + 16] = 1.0;

  stemGlobalW[28 * G + 4] = 2.2;
  stemGlobalW[28 * G + 6] = 0.9;
  stemGlobalW[28 * G + 3] = -2.2;

  stemGlobalW[29 * G + 3] = 2.5;
  stemGlobalW[29 * G + 5] = 1.4;
  stemGlobalW[29 * G + 4] = -1.2;

  stemW[30 * P + 1] = 2.0;
  stemW[30 * P + 5] = 0.9;
  stemW[30 * P + 7] = 0.75;
  stemW[30 * P + 11] = 0.45;
  stemW[30 * P + 15] = 0.65;

  stemW[31 * P + 2] = 2.0;
  stemW[31 * P + 6] = 0.9;
  stemW[31 * P + 8] = 0.75;
  stemW[31 * P + 12] = 0.45;
  stemW[31 * P + 16] = 0.65;

  const setIdentity3x3 = (arr: Float32Array, ch: number, centerW: number, orthoW: number, diagW: number) => {
    const base = ch * 9;
    arr[base + 0] = diagW;
    arr[base + 1] = orthoW;
    arr[base + 2] = diagW;
    arr[base + 3] = orthoW;
    arr[base + 4] = centerW;
    arr[base + 5] = orthoW;
    arr[base + 6] = diagW;
    arr[base + 7] = orthoW;
    arr[base + 8] = diagW;
  };

  const makeResSpatial = (): Float32Array => {
    const w = new Float32Array(C * 9);
    for (let c = 0; c < C; c++) {
      setIdentity3x3(w, c, 0.25, 0.0, 0.0);
    }
    setIdentity3x3(w, 18, 0.4, 0.24, 0.2);
    setIdentity3x3(w, 19, 0.4, 0.24, 0.2);
    setIdentity3x3(w, 20, 0.5, 0.35, 0.28);
    setIdentity3x3(w, 22, 0.6, 0.14, 0.12);
    setIdentity3x3(w, 23, 0.6, 0.14, 0.12);
    setIdentity3x3(w, 24, 0.6, 0.16, 0.14);
    setIdentity3x3(w, 26, 0.45, 0.15, 0.12);
    setIdentity3x3(w, 27, 0.6, 0.18, 0.15);
    setIdentity3x3(w, 30, 0.45, 0.2, 0.16);
    setIdentity3x3(w, 31, 0.45, 0.2, 0.16);
    return w;
  };

  const makeResMix = (scale: number): Float32Array => {
    const w = new Float32Array(C * C);
    w[24 * C + 22] = 0.22 * scale;
    w[24 * C + 23] = 0.14 * scale;
    w[27 * C + 18] = 0.25 * scale;
    w[27 * C + 19] = 0.25 * scale;
    w[27 * C + 20] = 0.28 * scale;
    w[27 * C + 22] = 0.3 * scale;
    w[27 * C + 23] = 0.3 * scale;
    w[27 * C + 25] = 0.18 * scale;
    w[30 * C + 18] = 0.35 * scale;
    w[30 * C + 22] = 0.22 * scale;
    w[31 * C + 19] = 0.35 * scale;
    w[31 * C + 23] = 0.22 * scale;
    return w;
  };

  const res1SpatialW = makeResSpatial();
  const res2SpatialW = makeResSpatial();
  const res1MixW = makeResMix(0.55);
  const res2MixW = makeResMix(0.45);

  const res1GpoolW = new Float32Array(C * GPOOL_DIM);
  const res2GpoolW = new Float32Array(C * GPOOL_DIM);
  res1GpoolW[27 * GPOOL_DIM + (C * 3 + 4)] = -0.35;
  res1GpoolW[27 * GPOOL_DIM + (C * 3 + 3)] = -0.35;
  res1GpoolW[22 * GPOOL_DIM + (C * 3 + 7)] = 0.18;
  res1GpoolW[23 * GPOOL_DIM + (C * 3 + 7)] = -0.18;
  res2GpoolW[27 * GPOOL_DIM + (C * 3 + 6)] = -0.2;

  const res1B = new Float32Array(C);
  const res2B = new Float32Array(C);

  // Policy Head weights over final 32 channels (scaled for 2x residual identity accumulation)
  const policyW = new Float32Array(C);
  policyW[5] = 9.5;
  policyW[6] = 7.8;
  policyW[7] = 6.2;
  policyW[8] = 4.9;
  policyW[15] = 4.7;
  policyW[16] = 4.0;
  policyW[9] = 3.0;
  policyW[12] = 3.0;
  policyW[11] = 2.85;
  policyW[14] = 2.55;
  policyW[13] = 2.45;
  policyW[10] = 1.9;
  policyW[17] = 0.85;
  policyW[18] = 0.35;
  policyW[19] = 0.3;
  policyW[20] = 0.25;
  policyW[24] = 0.32;
  policyW[25] = 0.28;
  policyW[26] = 0.15;
  policyW[27] = 0.45;
  policyW[28] = -1.1;

  const policyGlobalW = new Float32Array(G);

  const valueW = new Float32Array(3 * GPOOL_DIM);
  const valueB = new Float32Array([0.05, -0.05, -1.1]);
  const WIN_ROW = 0 * GPOOL_DIM;
  const LOSS_ROW = 1 * GPOOL_DIM;
  const DRAW_ROW = 2 * GPOOL_DIM;

  valueW[WIN_ROW + C * 3 + 3] = 4.8;
  valueW[LOSS_ROW + C * 3 + 3] = -3.8;
  valueW[DRAW_ROW + C * 3 + 3] = -1.8;

  valueW[WIN_ROW + C * 3 + 4] = -1.3;
  valueW[LOSS_ROW + C * 3 + 4] = 1.3;
  valueW[DRAW_ROW + C * 3 + 4] = -0.8;

  valueW[LOSS_ROW + 6] = 180.0;
  valueW[WIN_ROW + 6] = -140.0;

  valueW[WIN_ROW + C * 3 + 5] = 3.2;
  valueW[LOSS_ROW + C * 3 + 5] = -2.4;
  valueW[DRAW_ROW + C * 3 + 5] = -1.2;

  valueW[WIN_ROW + C * 3 + 6] = -1.1;
  valueW[LOSS_ROW + C * 3 + 6] = 1.05;

  valueW[WIN_ROW + C * 3 + 7] = 1.35;
  valueW[LOSS_ROW + C * 3 + 7] = -1.35;
  valueW[WIN_ROW + C * 3 + 1] = 0.08;
  valueW[WIN_ROW + C * 3 + 0] = -0.04;

  valueW[WIN_ROW + 22] = 1.8;
  valueW[LOSS_ROW + 22] = -1.2;
  valueW[WIN_ROW + 23] = -1.4;
  valueW[LOSS_ROW + 23] = 1.9;

  valueW[WIN_ROW + C * 2 + 15] = 0.55;
  valueW[LOSS_ROW + C * 2 + 15] = -0.45;
  valueW[WIN_ROW + C * 2 + 16] = -0.4;
  valueW[LOSS_ROW + C * 2 + 16] = 0.5;

  valueW[WIN_ROW + 30] = 0.35;
  valueW[LOSS_ROW + 30] = -0.25;
  valueW[WIN_ROW + 31] = -0.25;
  valueW[LOSS_ROW + 31] = 0.35;

  valueW[DRAW_ROW + C * 3 + 2] = -0.8;

  const ownershipW = new Float32Array(C);
  ownershipW[1] = 0.45;
  ownershipW[2] = -0.45;
  ownershipW[18] = 0.25;
  ownershipW[19] = -0.25;
  ownershipW[30] = 0.35;
  ownershipW[31] = -0.35;

  // Build sparse index tables for fast inference
  const stemNonZero: SparseStemEntry[] = [];
  for (let c = 0; c < C; c++) {
    for (let p = 0; p < P; p++) {
      const w = stemW[c * P + p];
      if (w !== 0) stemNonZero.push({ c, p, w });
    }
  }
  const stemGlobalNonZero: SparseGpoolEntry[] = [];
  for (let c = 0; c < C; c++) {
    for (let g = 0; g < G; g++) {
      const w = stemGlobalW[c * G + g];
      if (w !== 0) stemGlobalNonZero.push({ c, f: g, w });
    }
  }

  const indexSpatial = (sw: Float32Array) => {
    const spatialChannels: number[] = [];
    const identityChannels: number[] = [];
    for (let c = 0; c < C; c++) {
      const k = c * 9;
      if (
        sw[k] === 0 &&
        sw[k + 1] === 0 &&
        sw[k + 2] === 0 &&
        sw[k + 3] === 0 &&
        sw[k + 5] === 0 &&
        sw[k + 6] === 0 &&
        sw[k + 7] === 0 &&
        sw[k + 8] === 0
      ) {
        identityChannels.push(c);
      } else {
        spatialChannels.push(c);
      }
    }
    return { spatialChannels, identityChannels };
  };

  const indexMix = (mw: Float32Array): SparseMixEntry[] => {
    const list: SparseMixEntry[] = [];
    for (let oc = 0; oc < C; oc++) {
      for (let ic = 0; ic < C; ic++) {
        const w = mw[oc * C + ic];
        if (w !== 0) list.push({ oc, ic, w });
      }
    }
    return list;
  };

  const indexGpool = (gw: Float32Array): SparseGpoolEntry[] => {
    const list: SparseGpoolEntry[] = [];
    for (let c = 0; c < C; c++) {
      for (let f = 0; f < GPOOL_DIM; f++) {
        const w = gw[c * GPOOL_DIM + f];
        if (w !== 0) list.push({ c, f, w });
      }
    }
    return list;
  };

  const r1Sp = indexSpatial(res1SpatialW);
  const r2Sp = indexSpatial(res2SpatialW);

  const policyActiveChannels: number[] = [];
  for (let c = 0; c < C; c++) {
    if (policyW[c] !== 0) policyActiveChannels.push(c);
  }

  const valueNonZero: SparseValueEntry[] = [];
  for (let f = 0; f < GPOOL_DIM; f++) {
    const w0 = valueW[WIN_ROW + f];
    const w1 = valueW[LOSS_ROW + f];
    const w2 = valueW[DRAW_ROW + f];
    if (w0 !== 0 || w1 !== 0 || w2 !== 0) {
      valueNonZero.push({ f, w0, w1, w2 });
    }
  }

  const ownershipActiveChannels: number[] = [];
  for (let c = 0; c < C; c++) {
    if (ownershipW[c] !== 0) ownershipActiveChannels.push(c);
  }

  return {
    stemW,
    stemGlobalW,
    stemB,
    stemNonZero,
    stemGlobalNonZero,
    res1GpoolW,
    res1SpatialW,
    res1MixW,
    res1B,
    res1GpoolNonZero: indexGpool(res1GpoolW),
    res1SpatialChannels: r1Sp.spatialChannels,
    res1IdentityChannels: r1Sp.identityChannels,
    res1MixNonZero: indexMix(res1MixW),
    res2GpoolW,
    res2SpatialW,
    res2MixW,
    res2B,
    res2GpoolNonZero: indexGpool(res2GpoolW),
    res2SpatialChannels: r2Sp.spatialChannels,
    res2IdentityChannels: r2Sp.identityChannels,
    res2MixNonZero: indexMix(res2MixW),
    policyW,
    policyGlobalW,
    policyActiveChannels,
    valueW,
    valueB,
    valueNonZero,
    ownershipW,
    ownershipB: 0.0,
    ownershipActiveChannels,
  };
}

const WEIGHTS = buildCalibratedWeights();

function inBounds(size: number, x: number, y: number): boolean {
  return x >= 0 && x < size && y >= 0 && y < size;
}

function inspectAxisAtEmptyCell(
  board: Uint8Array,
  size: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: PlayerColor,
  ruleset: OmokRulesetType,
  out: AxisPatternInfo
): void {
  out.win = false;
  out.overline = false;
  out.open4 = false;
  out.fourThreats = 0;
  out.open3 = false;
  out.split3 = false;

  const isBlackRenju = color === BLACK && ruleset === 'renju';

  let posContig = 0;
  let cx = x + dx;
  let cy = y + dy;
  while (inBounds(size, cx, cy) && board[cy * size + cx] === color) {
    posContig++;
    cx += dx;
    cy += dy;
  }
  const posEnd1Empty = inBounds(size, cx, cy) && board[cy * size + cx] === EMPTY;
  let posGap1Contig = 0;
  let posEnd2Empty = false;
  let posEnd2NotBlack = true;
  if (posEnd1Empty) {
    let gx = cx + dx;
    let gy = cy + dy;
    while (inBounds(size, gx, gy) && board[gy * size + gx] === color) {
      posGap1Contig++;
      gx += dx;
      gy += dy;
    }
    if (inBounds(size, gx, gy)) {
      const cell = board[gy * size + gx];
      posEnd2Empty = cell === EMPTY;
      posEnd2NotBlack = cell !== BLACK;
    }
  }

  let negContig = 0;
  cx = x - dx;
  cy = y - dy;
  while (inBounds(size, cx, cy) && board[cy * size + cx] === color) {
    negContig++;
    cx -= dx;
    cy -= dy;
  }
  const negEnd1Empty = inBounds(size, cx, cy) && board[cy * size + cx] === EMPTY;
  let negGap1Contig = 0;
  let negEnd2Empty = false;
  let negEnd2NotBlack = true;
  if (negEnd1Empty) {
    let gx = cx - dx;
    let gy = cy - dy;
    while (inBounds(size, gx, gy) && board[gy * size + gx] === color) {
      negGap1Contig++;
      gx -= dx;
      gy -= dy;
    }
    if (inBounds(size, gx, gy)) {
      const cell = board[gy * size + gx];
      negEnd2Empty = cell === EMPTY;
      negEnd2NotBlack = cell !== BLACK;
    }
  }

  const totalContig = 1 + posContig + negContig;

  if (totalContig === 5 || (totalContig >= 6 && !isBlackRenju)) {
    out.win = true;
    return;
  }
  if (totalContig >= 6 && isBlackRenju) {
    out.overline = true;
    return;
  }

  if (totalContig === 4) {
    const posValid = posEnd1Empty && (!isBlackRenju || posGap1Contig === 0);
    const negValid = negEnd1Empty && (!isBlackRenju || negGap1Contig === 0);
    if (posValid && negValid) {
      out.open4 = true;
      out.fourThreats = 1;
    } else if (posValid || negValid) {
      out.fourThreats = 1;
    }
    return;
  }

  if (posEnd1Empty && posGap1Contig > 0) {
    const combinedPos = totalContig + posGap1Contig;
    if (combinedPos === 4 || (combinedPos >= 4 && !isBlackRenju)) {
      out.fourThreats++;
    }
  }
  if (negEnd1Empty && negGap1Contig > 0) {
    const combinedNeg = totalContig + negGap1Contig;
    if (combinedNeg === 4 || (combinedNeg >= 4 && !isBlackRenju)) {
      out.fourThreats++;
    }
  }

  if (totalContig === 3 && posEnd1Empty && negEnd1Empty && posGap1Contig === 0 && negGap1Contig === 0) {
    const posExtends = posEnd2Empty && (!isBlackRenju || negEnd2NotBlack);
    const negExtends = negEnd2Empty && (!isBlackRenju || posEnd2NotBlack);
    if (posExtends || negExtends) {
      out.open3 = true;
    }
    return;
  }

  if (posEnd1Empty && negEnd1Empty && posGap1Contig > 0 && negGap1Contig === 0) {
    if (totalContig + posGap1Contig === 3 && posEnd2Empty) {
      if (!isBlackRenju) {
        out.split3 = true;
      } else {
        const afterGapX = x + dx * (posContig + 2 + posGap1Contig + 1);
        const afterGapY = y + dy * (posContig + 2 + posGap1Contig + 1);
        const afterOk = !inBounds(size, afterGapX, afterGapY) || board[afterGapY * size + afterGapX] !== BLACK;
        if (afterOk && negEnd2NotBlack) {
          out.split3 = true;
        }
      }
    }
  } else if (negEnd1Empty && posEnd1Empty && negGap1Contig > 0 && posGap1Contig === 0) {
    if (totalContig + negGap1Contig === 3 && negEnd2Empty) {
      if (!isBlackRenju) {
        out.split3 = true;
      } else {
        const afterGapX = x - dx * (negContig + 2 + negGap1Contig + 1);
        const afterGapY = y - dy * (negContig + 2 + negGap1Contig + 1);
        const afterOk = !inBounds(size, afterGapX, afterGapY) || board[afterGapY * size + afterGapX] !== BLACK;
        if (afterOk && posEnd2NotBlack) {
          out.split3 = true;
        }
      }
    }
  }
}

const AXIS_SCRATCH: AxisPatternInfo = {
  win: false,
  overline: false,
  open4: false,
  fourThreats: 0,
  open3: false,
  split3: false,
};

function encodeKataOmokInputsInto(
  board: Uint8Array,
  size: number,
  pla: PlayerColor,
  ruleset: OmokRulesetType,
  lastMove: Coord | null,
  binInputs: Float32Array,
  globalInputs: Float32Array,
  forbiddenMask: Uint8Array,
  nearMask: Uint8Array
): void {
  const area = size * size;
  const opp = opponentColor(pla);
  const center = (size - 1) * 0.5;
  const maxManh = Math.max(1, size - 1);

  binInputs.fill(0, 0, KATA_OMOK_INPUT_PLANES * area);
  forbiddenMask.fill(0, 0, area);
  nearMask.fill(0, 0, area);

  let stoneCount = 0;

  for (let y = 0; y < size; y++) {
    const rowOff = y * size;
    for (let x = 0; x < size; x++) {
      const idx = rowOff + x;
      binInputs[idx] = 1.0;

      const cell = board[idx];
      if (cell === pla) {
        binInputs[area + idx] = 1.0;
        stoneCount++;
      } else if (cell === opp) {
        binInputs[2 * area + idx] = 1.0;
        stoneCount++;
      }

      if (cell !== EMPTY) {
        for (let a = 0; a < 4; a++) {
          const dx = AXES[a][0];
          const dy = AXES[a][1];
          for (let k = -4; k <= 4; k++) {
            if (k === 0) continue;
            const nx = x + dx * k;
            const ny = y + dy * k;
            if (inBounds(size, nx, ny)) {
              const nIdx = ny * size + nx;
              if (board[nIdx] === EMPTY) {
                nearMask[nIdx] = 1;
              }
            }
          }
        }
      } else {
        const distCenter = (Math.abs(x - center) + Math.abs(y - center)) / maxManh;
        const star =
          (x === 3 || x === size - 4 || x === Math.floor(size / 2)) &&
          (y === 3 || y === size - 4 || y === Math.floor(size / 2))
            ? 0.14
            : 0.0;
        binInputs[17 * area + idx] = Math.max(0.02, 0.72 * (1.0 - distCenter) + star);
      }
    }
  }

  if (lastMove && inBounds(size, lastMove.x, lastMove.y)) {
    binInputs[3 * area + lastMove.y * size + lastMove.x] = 1.0;
  }

  let selfWinCount = 0;
  let oppWinCount = 0;
  let selfOpen4Count = 0;
  let oppOpen4Count = 0;
  let selfForkStrength = 0;
  let oppForkStrength = 0;

  const inspectColorAt = (x: number, y: number, color: PlayerColor) => {
    let win = false;
    let overline = false;
    let open4 = false;
    let totalFours = 0;
    let open3Count = 0;
    let split3Count = 0;

    for (let a = 0; a < 4; a++) {
      inspectAxisAtEmptyCell(board, size, x, y, AXES[a][0], AXES[a][1], color, ruleset, AXIS_SCRATCH);
      if (AXIS_SCRATCH.win) win = true;
      if (AXIS_SCRATCH.overline) overline = true;
      if (AXIS_SCRATCH.open4) open4 = true;
      totalFours += AXIS_SCRATCH.fourThreats;
      if (AXIS_SCRATCH.open3) open3Count++;
      if (AXIS_SCRATCH.split3) split3Count++;
    }

    const totalThrees = open3Count + split3Count;
    const isBlackRenju = color === BLACK && ruleset === 'renju';
    const fork =
      (totalFours >= 1 && totalThrees >= 1) ||
      (!isBlackRenju && (totalFours >= 2 || totalThrees >= 2));

    return {
      win,
      overline,
      open4,
      closedOrSplit4: !open4 && totalFours > 0,
      open3: open3Count > 0,
      split3: split3Count > 0,
      fork,
      mightBeBlackForbidden: isBlackRenju && !win && (overline || totalFours >= 2 || totalThrees >= 2),
      linePotential: totalFours * 0.28 + open3Count * 0.22 + split3Count * 0.16,
    };
  };

  for (let idx = 0; idx < area; idx++) {
    if (nearMask[idx] === 0 || board[idx] !== EMPTY) continue;
    const x = idx % size;
    const y = (idx - x) / size;

    const blackInfo = inspectColorAt(x, y, BLACK);
    let isBlackForbidden = false;
    if (ruleset === 'renju' && blackInfo.mightBeBlackForbidden) {
      isBlackForbidden = checkRenjuForbidden(board, size, x, y).forbidden;
      if (isBlackForbidden) {
        forbiddenMask[idx] = 1;
        binInputs[4 * area + idx] = 1.0;
      }
    }

    const sInfo = pla === BLACK ? blackInfo : inspectColorAt(x, y, pla);
    if (pla === BLACK && isBlackForbidden) {
      if (sInfo.win) {
        binInputs[5 * area + idx] = 1.0;
        selfWinCount++;
      }
    } else {
      if (sInfo.win) {
        binInputs[5 * area + idx] = 1.0;
        selfWinCount++;
      }
      if (sInfo.open4) {
        binInputs[7 * area + idx] = 1.0;
        selfOpen4Count++;
      }
      if (sInfo.closedOrSplit4) binInputs[9 * area + idx] = 1.0;
      if (sInfo.open3) {
        binInputs[11 * area + idx] = 1.0;
        selfForkStrength += 0.35;
      }
      if (sInfo.split3) {
        binInputs[13 * area + idx] = 1.0;
        selfForkStrength += 0.22;
      }
      if (sInfo.fork) {
        binInputs[15 * area + idx] = 1.0;
        selfForkStrength += 1.0;
      }
      binInputs[17 * area + idx] = Math.min(1.5, binInputs[17 * area + idx] + sInfo.linePotential);
    }

    const oInfo = opp === BLACK ? blackInfo : inspectColorAt(x, y, opp);
    if (opp === BLACK && isBlackForbidden) {
      if (oInfo.win) {
        binInputs[6 * area + idx] = 1.0;
        oppWinCount++;
      }
    } else {
      if (oInfo.win) {
        binInputs[6 * area + idx] = 1.0;
        oppWinCount++;
      }
      if (oInfo.open4) {
        binInputs[8 * area + idx] = 1.0;
        oppOpen4Count++;
      }
      if (oInfo.closedOrSplit4) binInputs[10 * area + idx] = 1.0;
      if (oInfo.open3) {
        binInputs[12 * area + idx] = 1.0;
        oppForkStrength += 0.35;
      }
      if (oInfo.split3) {
        binInputs[14 * area + idx] = 1.0;
        oppForkStrength += 0.22;
      }
      if (oInfo.fork) {
        binInputs[16 * area + idx] = 1.0;
        oppForkStrength += 1.0;
      }
      binInputs[17 * area + idx] = Math.min(1.5, binInputs[17 * area + idx] + oInfo.linePotential * 0.85);
    }
  }

  globalInputs[0] = ruleset === 'renju' ? 1.0 : 0.0;
  globalInputs[1] = pla === BLACK ? 1.0 : 0.0;
  globalInputs[2] = stoneCount / area;
  globalInputs[3] = selfWinCount > 0 ? 1.0 : 0.0;
  globalInputs[4] = oppWinCount > 0 ? 1.0 : 0.0;
  globalInputs[5] = selfOpen4Count > 0 ? 1.0 : 0.0;
  globalInputs[6] = oppOpen4Count > 0 ? 1.0 : 0.0;
  globalInputs[7] = Math.tanh((selfForkStrength - oppForkStrength) * 0.45);
}

/**
 * Encodes a 15x15 (or general size <= 19) Omok/Renju board state into
 * KataGo / KataGomo-compatible 18 spatial input planes + 8 global features + Renju forbidden mask.
 */
export function encodeKataOmokInputs(
  board: Uint8Array,
  size: BoardSize | number,
  pla: PlayerColor,
  ruleset: OmokRulesetType,
  lastMove: Coord | null
): KataOmokEncodedInputs {
  const area = size * size;
  const binInputs = new Float32Array(KATA_OMOK_INPUT_PLANES * area);
  const globalInputs = new Float32Array(KATA_OMOK_GLOBAL_FEATURES);
  const forbiddenMask = new Uint8Array(area);
  const nearMask = WORKSPACE.nearMask;

  encodeKataOmokInputsInto(
    board,
    size,
    pla,
    ruleset,
    lastMove,
    binInputs,
    globalInputs,
    forbiddenMask,
    nearMask
  );

  return { binInputs, globalInputs, forbiddenMask };
}

function computeGpoolFeatures(
  trunk: Float32Array,
  area: number,
  globalInputs: Float32Array,
  outFeatures: Float32Array
): void {
  const C = TRUNK_CHANNELS;
  const invArea = 1.0 / area;
  const areaScale = (Math.sqrt(area) - 14.0) * 0.1;

  for (let c = 0; c < C; c++) {
    const off = c * area;
    let sum = 0.0;
    let maxVal = -Infinity;
    for (let i = 0; i < area; i++) {
      const v = trunk[off + i];
      sum += v;
      if (v > maxVal) maxVal = v;
    }
    const mean = sum * invArea;
    outFeatures[c] = mean;
    outFeatures[C + c] = mean * areaScale;
    outFeatures[C * 2 + c] = maxVal;
  }
  const gOff = C * 3;
  for (let g = 0; g < KATA_OMOK_GLOBAL_FEATURES; g++) {
    outFeatures[gOff + g] = globalInputs[g];
  }
}

function runResidualBlock(
  x: Float32Array,
  size: number,
  area: number,
  globalInputs: Float32Array,
  gpoolNonZero: SparseGpoolEntry[],
  spatialW: Float32Array,
  spatialChannels: number[],
  identityChannels: number[],
  mixNonZero: SparseMixEntry[],
  bias: Float32Array,
  gpoolFeatures: Float32Array,
  gpoolBias: Float32Array,
  spatialScratch: Float32Array,
  out: Float32Array
): void {
  const C = TRUNK_CHANNELS;

  // 1. KataGo global pooling conditioning
  computeGpoolFeatures(x, area, globalInputs, gpoolFeatures);
  gpoolBias.set(bias);
  for (let k = 0; k < gpoolNonZero.length; k++) {
    const e = gpoolNonZero[k];
    gpoolBias[e.c] += e.w * gpoolFeatures[e.f];
  }

  // 2a. Identity-only channels (ReLU + center scale)
  for (let ci = 0; ci < identityChannels.length; ci++) {
    const c = identityChannels[ci];
    const cOff = c * area;
    const k4 = spatialW[c * 9 + 4];
    const gb = gpoolBias[c];
    for (let i = 0; i < area; i++) {
      const v = x[cOff + i] + gb;
      spatialScratch[cOff + i] = v > 0 ? v * k4 : 0;
    }
  }

  // 2b. 3x3 depthwise spatial convolution channels
  for (let ci = 0; ci < spatialChannels.length; ci++) {
    const c = spatialChannels[ci];
    const cOff = c * area;
    const kOff = c * 9;
    const k0 = spatialW[kOff + 0];
    const k1 = spatialW[kOff + 1];
    const k2 = spatialW[kOff + 2];
    const k3 = spatialW[kOff + 3];
    const k4 = spatialW[kOff + 4];
    const k5 = spatialW[kOff + 5];
    const k6 = spatialW[kOff + 6];
    const k7 = spatialW[kOff + 7];
    const k8 = spatialW[kOff + 8];
    const gb = gpoolBias[c];

    for (let y = 0; y < size; y++) {
      const yOff = y * size;
      const hasUp = y > 0;
      const hasDown = y + 1 < size;
      for (let xPos = 0; xPos < size; xPos++) {
        const idx = yOff + xPos;
        const hasLeft = xPos > 0;
        const hasRight = xPos + 1 < size;

        let sum = 0;
        const v4 = x[cOff + idx] + gb;
        if (v4 > 0) sum += v4 * k4;

        if (hasUp) {
          const upOff = cOff + idx - size;
          const v1 = x[upOff] + gb;
          if (v1 > 0) sum += v1 * k1;
          if (hasLeft) {
            const v0 = x[upOff - 1] + gb;
            if (v0 > 0) sum += v0 * k0;
          }
          if (hasRight) {
            const v2 = x[upOff + 1] + gb;
            if (v2 > 0) sum += v2 * k2;
          }
        }
        if (hasLeft) {
          const v3 = x[cOff + idx - 1] + gb;
          if (v3 > 0) sum += v3 * k3;
        }
        if (hasRight) {
          const v5 = x[cOff + idx + 1] + gb;
          if (v5 > 0) sum += v5 * k5;
        }
        if (hasDown) {
          const dnOff = cOff + idx + size;
          const v7 = x[dnOff] + gb;
          if (v7 > 0) sum += v7 * k7;
          if (hasLeft) {
            const v6 = x[dnOff - 1] + gb;
            if (v6 > 0) sum += v6 * k6;
          }
          if (hasRight) {
            const v8 = x[dnOff + 1] + gb;
            if (v8 > 0) sum += v8 * k8;
          }
        }
        spatialScratch[cOff + idx] = sum;
      }
    }
  }

  // 3. Residual skip + sparse 1x1 channel mixing (zero allocations)
  const totalElems = C * area;
  for (let i = 0; i < totalElems; i++) {
    out[i] = x[i] + spatialScratch[i];
  }
  for (let k = 0; k < mixNonZero.length; k++) {
    const m = mixNonZero[k];
    const outOff = m.oc * area;
    const inOff = m.ic * area;
    const w = m.w;
    for (let i = 0; i < area; i++) {
      out[outOff + i] += w * spatialScratch[inOff + i];
    }
  }
}

/**
 * Evaluates a board position using the KataGo / KataGomo Policy-Value-Ownership neural network.
 * Pre-allocated workspace buffers and sparse weight indexing ensure < 0.5ms inference with zero GC churn.
 */
export function evaluateKataOmokPosition(
  board: Uint8Array,
  size: BoardSize | number,
  pla: PlayerColor,
  ruleset: OmokRulesetType,
  lastMove: Coord | null
): KataOmokEval {
  const area = size * size;
  const ws = WORKSPACE;
  const W = WEIGHTS;
  const C = TRUNK_CHANNELS;
  const G = KATA_OMOK_GLOBAL_FEATURES;

  // 1. Encode spatial [18, H, W] and global [8] inputs into pre-allocated workspace
  encodeKataOmokInputsInto(
    board,
    size,
    pla,
    ruleset,
    lastMove,
    ws.binInputs,
    ws.globalInputs,
    ws.forbiddenMask,
    ws.nearMask
  );

  // 2. Input stem (18 -> 32) + global context bias
  for (let c = 0; c < C; c++) {
    ws.gpoolBias[c] = W.stemB[c];
  }
  for (let k = 0; k < W.stemGlobalNonZero.length; k++) {
    const e = W.stemGlobalNonZero[k];
    ws.gpoolBias[e.c] += e.w * ws.globalInputs[e.f];
  }
  for (let c = 0; c < C; c++) {
    const outOff = c * area;
    ws.trunkA.fill(ws.gpoolBias[c], outOff, outOff + area);
  }
  for (let k = 0; k < W.stemNonZero.length; k++) {
    const e = W.stemNonZero[k];
    const outOff = e.c * area;
    const pOff = e.p * area;
    const w = e.w;
    for (let i = 0; i < area; i++) {
      ws.trunkA[outOff + i] += w * ws.binInputs[pOff + i];
    }
  }

  // 3. Residual Block 1 -> trunkB
  runResidualBlock(
    ws.trunkA,
    size,
    area,
    ws.globalInputs,
    W.res1GpoolNonZero,
    W.res1SpatialW,
    W.res1SpatialChannels,
    W.res1IdentityChannels,
    W.res1MixNonZero,
    W.res1B,
    ws.gpoolFeatures,
    ws.gpoolBias,
    ws.spatialScratch,
    ws.trunkB
  );

  // 4. Residual Block 2 -> trunkA
  runResidualBlock(
    ws.trunkB,
    size,
    area,
    ws.globalInputs,
    W.res2GpoolNonZero,
    W.res2SpatialW,
    W.res2SpatialChannels,
    W.res2IdentityChannels,
    W.res2MixNonZero,
    W.res2B,
    ws.gpoolFeatures,
    ws.gpoolBias,
    ws.spatialScratch,
    ws.trunkA
  );

  // 5. Final Global Pooling for Value Head ([Win, Loss, Draw])
  computeGpoolFeatures(ws.trunkA, area, ws.globalInputs, ws.gpoolFeatures);
  let winLogit = W.valueB[0];
  let lossLogit = W.valueB[1];
  let drawLogit = W.valueB[2];

  for (let k = 0; k < W.valueNonZero.length; k++) {
    const e = W.valueNonZero[k];
    const feat = ws.gpoolFeatures[e.f];
    if (feat === 0) continue;
    winLogit += e.w0 * feat;
    lossLogit += e.w1 * feat;
    drawLogit += e.w2 * feat;
  }

  const maxVLogit = Math.max(winLogit, lossLogit, drawLogit);
  const eWin = Math.exp(winLogit - maxVLogit);
  const eLoss = Math.exp(lossLogit - maxVLogit);
  const eDraw = Math.exp(drawLogit - maxVLogit);
  const vSum = eWin + eLoss + eDraw;
  const pWin = eWin / vSum;
  const pLoss = eLoss / vSum;
  const pDraw = eDraw / vSum;

  const winrate = Math.max(0.005, Math.min(0.995, pWin + 0.5 * pDraw));
  const utility = Math.max(-1.0, Math.min(1.0, pWin - pLoss));

  // 6. Policy Head with strict legality & Black Renju-forbidden masking
  const policyLogits = new Float32Array(area);
  const policyProbs = new Float32Array(area);
  const maskBlackRenju = pla === BLACK && ruleset === 'renju';

  let policyGlobalOffset = 0;
  for (let g = 0; g < G; g++) {
    policyGlobalOffset += W.policyGlobalW[g] * ws.globalInputs[g];
  }

  let maxPolicyLogit = -Infinity;
  let legalCount = 0;
  const pChans = W.policyActiveChannels;
  for (let i = 0; i < area; i++) {
    if (board[i] !== EMPTY || (maskBlackRenju && ws.forbiddenMask[i] !== 0)) {
      policyLogits[i] = -Infinity;
      continue;
    }
    let logit = policyGlobalOffset;
    for (let ci = 0; ci < pChans.length; ci++) {
      const c = pChans[ci];
      const act = ws.trunkA[c * area + i];
      if (act > 0 || c >= 18) {
        logit += W.policyW[c] * act;
      }
    }
    policyLogits[i] = logit;
    if (logit > maxPolicyLogit) maxPolicyLogit = logit;
    legalCount++;
  }

  if (legalCount > 0 && maxPolicyLogit > -Infinity) {
    let sumExp = 0.0;
    for (let i = 0; i < area; i++) {
      const l = policyLogits[i];
      if (l === -Infinity) {
        policyProbs[i] = 0.0;
      } else {
        const e = Math.exp(l - maxPolicyLogit);
        policyProbs[i] = e;
        sumExp += e;
      }
    }
    if (sumExp > 0) {
      const invSum = 1.0 / sumExp;
      for (let i = 0; i < area; i++) {
        policyProbs[i] *= invSum;
      }
    }
  }

  // 7. Ownership Head ([-1..+1] per cell)
  const ownership = new Float32Array(area);
  const oChans = W.ownershipActiveChannels;
  for (let i = 0; i < area; i++) {
    let raw = W.ownershipB;
    for (let ci = 0; ci < oChans.length; ci++) {
      const c = oChans[ci];
      raw += W.ownershipW[c] * ws.trunkA[c * area + i];
    }
    ownership[i] = Math.tanh(raw);
  }

  const forbiddenMask = new Uint8Array(ws.forbiddenMask.subarray(0, area));

  return {
    policyProbs,
    policyLogits,
    winrate,
    utility,
    ownership,
    forbiddenMask,
  };
}
