import {
  encodeKataGoV7InputsInto,
  KataGoInputPosition,
  NUM_KATAGO_GLOBAL_FEATURES,
  NUM_KATAGO_SPATIAL_FEATURES,
} from './KataGoFeatures';
import {
  getKataGoModelSync,
  KataGoActivationKind,
  KataGoConvLayer,
  KataGoFoldedBNLayer,
  KataGoLoadedModel,
  KataGoMatMulLayer,
} from './KataGoWeights';

export interface KataGoNetOutput {
  policyProbs: Float32Array; // length size*size + 1 (index size*size = PASS), softmax over legal moves
  winrate: number;           // [0..1] win probability for `pos.pla`
  scoreLead: number;         // expected score lead in points for `pos.pla`
  ownership: Float32Array;   // length size*size, [-1..+1] (+1 = `pos.pla`, -1 = opponent)
}

interface NetWorkspace {
  size: number;
  area: number;
  numTilesX: number;
  numTilesY: number;
  numTiles: number;
  heapBuffer: ArrayBufferLike;
  binInputs: Float32Array;
  globalInputs: Float32Array;
  trunkA: Float32Array;
  trunkB: Float32Array;
  midA: Float32Array;
  midB: Float32Array;
  gpoolOut: Float32Array;
  gpoolAct: Float32Array;
  gpoolConcat: Float32Array;
  gpoolBias: Float32Array;
  initGlobalBias: Float32Array;
  p1Out: Float32Array;
  p1Act: Float32Array;
  g1Out: Float32Array;
  g1Act: Float32Array;
  g1Concat: Float32Array;
  g1Bias: Float32Array;
  policyRaw: Float32Array;
  policyPass: Float32Array;
  v1Out: Float32Array;
  v1Act: Float32Array;
  v1Pool: Float32Array;
  v2Out: Float32Array;
  v3Out: Float32Array;
  sv3Out: Float32Array;
  ownershipRaw: Float32Array;
  colBuf: Float32Array;
  winogradIn: Float32Array;
  winogradOut: Float32Array;
  winogradTile: Float32Array;
  symTable: Int16Array;
}

const WORKSPACE_CACHE = new Map<string, NetWorkspace>();
const WINOGRAD_WEIGHT_CACHE = new WeakMap<KataGoConvLayer, Float32Array>();
const HEAP_WEIGHT_OFFSETS = new WeakMap<Float32Array, number>();

// Shared linear memory for zero-copy JS <-> WebAssembly SIMD GEMM.
// Layout: [0 .. WASM_WS_BYTES) = active evaluation workspace, [WASM_WS_BYTES ..) = cached layer weights.
const WASM_WS_BYTES = 4 * 1024 * 1024;
const WASM_PAGE_BYTES = 65536;
const INITIAL_WASM_PAGES = 512; // 32 MB virtual arena

type WasmGemmFn = (
  wPtr: number,
  bPtr: number,
  outPtr: number,
  oc: number,
  k: number,
  n: number,
  accum: number
) => void;

function buildGemmSimdWasmBytes(): Uint8Array {
  const bytes: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const pushUleb = (arr: number[], v: number) => {
    let val = v >>> 0;
    while (val >= 0x80) {
      arr.push((val & 0x7f) | 0x80);
      val >>>= 7;
    }
    arr.push(val);
  };
  const pushSleb = (arr: number[], v: number) => {
    let val = v;
    let more = true;
    while (more) {
      let b = val & 0x7f;
      val >>= 7;
      if ((val === 0 && (b & 0x40) === 0) || (val === -1 && (b & 0x40) !== 0)) {
        more = false;
      } else {
        b |= 0x80;
      }
      arr.push(b);
    }
  };
  const pushStr = (arr: number[], s: string) => {
    pushUleb(arr, s.length);
    for (let i = 0; i < s.length; i++) arr.push(s.charCodeAt(i));
  };
  const pushSection = (id: number, fn: (sub: number[]) => void) => {
    const sub: number[] = [];
    fn(sub);
    bytes.push(id);
    pushUleb(bytes, sub.length);
    for (let i = 0; i < sub.length; i++) bytes.push(sub[i]);
  };

  const I32 = 0x7f;
  const V128 = 0x7b;
  const F32 = 0x7d;

  // Type section: (7 x i32) -> void
  pushSection(1, (s) => {
    pushUleb(s, 1);
    s.push(0x60);
    pushUleb(s, 7);
    for (let i = 0; i < 7; i++) s.push(I32);
    pushUleb(s, 0);
  });

  // Import section: env.mem
  pushSection(2, (s) => {
    pushUleb(s, 1);
    pushStr(s, 'env');
    pushStr(s, 'mem');
    s.push(0x02, 0x00);
    pushUleb(s, 1);
  });

  // Function section: 1 func of type 0
  pushSection(3, (s) => {
    pushUleb(s, 1);
    pushUleb(s, 0);
  });

  // Export section: gemm -> func 0
  pushSection(7, (s) => {
    pushUleb(s, 1);
    pushStr(s, 'gemm');
    s.push(0x00);
    pushUleb(s, 0);
  });

  // Code section: 4x8 + 4x4 + 4x1 SIMD f32x4 GEMM + scalar OC tail
  pushSection(10, (s) => {
    pushUleb(s, 1);
    const fn: number[] = [];
    pushUleb(fn, 3);
    pushUleb(fn, 15);
    fn.push(I32);
    pushUleb(fn, 11);
    fn.push(V128);
    pushUleb(fn, 4);
    fn.push(F32);

    const BLOCK = 0x02;
    const LOOP = 0x03;
    const IF = 0x04;
    const ELSE = 0x05;
    const END = 0x0b;
    const BR = 0x0c;
    const BR_IF = 0x0d;
    const GET = 0x20;
    const SET = 0x21;
    const TEE = 0x22;
    const FLOAD = 0x2a;
    const FSTORE = 0x38;
    const I32_C = 0x41;
    const F32_C = 0x43;
    const I32_LT_S = 0x48;
    const I32_GE_S = 0x4e;
    const I32_ADD = 0x6a;
    const I32_MUL = 0x6c;
    const I32_SHL = 0x74;
    const F32_ADD = 0x92;
    const F32_MUL = 0x94;

    const simd = (op: number) => {
      fn.push(0xfd);
      pushUleb(fn, op);
    };
    const VLOAD = 0x00;
    const VSTORE = 0x0b;
    const F32X4_SPLAT = 0x13;
    const F32X4_ADD = 0xe4;
    const F32X4_MUL = 0xe6;

    const get = (i: number) => {
      fn.push(GET);
      pushUleb(fn, i);
    };
    const set = (i: number) => {
      fn.push(SET);
      pushUleb(fn, i);
    };
    const tee = (i: number) => {
      fn.push(TEE);
      pushUleb(fn, i);
    };
    const i32c = (v: number) => {
      fn.push(I32_C);
      pushSleb(fn, v);
    };
    const fzero = () => fn.push(F32_C, 0, 0, 0, 0);
    const vzero = () => {
      fzero();
      simd(F32X4_SPLAT);
    };
    const vload = (off = 0) => {
      simd(VLOAD);
      pushUleb(fn, 2);
      pushUleb(fn, off);
    };
    const vstore = (off = 0) => {
      simd(VSTORE);
      pushUleb(fn, 2);
      pushUleb(fn, off);
    };
    const fload = (off = 0) => {
      fn.push(FLOAD);
      pushUleb(fn, 2);
      pushUleb(fn, off);
    };
    const fstore = (off = 0) => {
      fn.push(FSTORE);
      pushUleb(fn, 2);
      pushUleb(fn, off);
    };

    // wRowBytes = K << 2; nBytes = N << 2; oc = 0
    get(4); i32c(2); fn.push(I32_SHL); set(10);
    get(5); i32c(2); fn.push(I32_SHL); set(11);
    i32c(0); set(7);

    // while (oc + 3 < OC)
    fn.push(BLOCK, 0x40, LOOP, 0x40);
    get(7); i32c(3); fn.push(I32_ADD); get(3); fn.push(I32_GE_S);
    fn.push(BR_IF); pushUleb(fn, 1);

    get(0); get(7); get(10); fn.push(I32_MUL, I32_ADD); tee(12);
    get(10); fn.push(I32_ADD); tee(13);
    get(10); fn.push(I32_ADD); tee(14);
    get(10); fn.push(I32_ADD); set(15);

    get(2); get(7); get(11); fn.push(I32_MUL, I32_ADD); tee(16);
    get(11); fn.push(I32_ADD); tee(17);
    get(11); fn.push(I32_ADD); tee(18);
    get(11); fn.push(I32_ADD); set(19);

    i32c(0); set(8);

    // 8-col SIMD loop: while (p + 7 < N)
    fn.push(BLOCK, 0x40, LOOP, 0x40);
    get(8); i32c(7); fn.push(I32_ADD); get(5); fn.push(I32_GE_S);
    fn.push(BR_IF); pushUleb(fn, 1);

    get(6);
    fn.push(IF, 0x40);
    get(8); i32c(2); fn.push(I32_SHL); set(20);
    for (let r = 0; r < 4; r++) {
      get(16 + r); get(20); fn.push(I32_ADD); tee(21); vload(0); set(22 + r * 2);
      get(21); vload(16); set(23 + r * 2);
    }
    fn.push(ELSE);
    for (let i = 22; i <= 29; i++) {
      vzero();
      set(i);
    }
    fn.push(END);

    i32c(0); set(9);
    get(1); get(8); i32c(2); fn.push(I32_SHL, I32_ADD); set(20);
    fn.push(BLOCK, 0x40, LOOP, 0x40);
    get(9); get(10); fn.push(I32_GE_S);
    fn.push(BR_IF); pushUleb(fn, 1);
    get(20); vload(0); set(30);
    get(20); vload(16); set(31);
    for (let r = 0; r < 4; r++) {
      get(12 + r); get(9); fn.push(I32_ADD); fload(0); simd(F32X4_SPLAT); set(32);
      get(22 + r * 2); get(32); get(30); simd(F32X4_MUL); simd(F32X4_ADD); set(22 + r * 2);
      get(23 + r * 2); get(32); get(31); simd(F32X4_MUL); simd(F32X4_ADD); set(23 + r * 2);
    }
    get(20); get(11); fn.push(I32_ADD); set(20);
    get(9); i32c(4); fn.push(I32_ADD); set(9);
    fn.push(BR); pushUleb(fn, 0);
    fn.push(END, END);

    get(8); i32c(2); fn.push(I32_SHL); set(20);
    for (let r = 0; r < 4; r++) {
      get(16 + r); get(20); fn.push(I32_ADD); tee(21); get(22 + r * 2); vstore(0);
      get(21); get(23 + r * 2); vstore(16);
    }
    get(8); i32c(8); fn.push(I32_ADD); set(8);
    fn.push(BR); pushUleb(fn, 0);
    fn.push(END, END);

    // 4-col SIMD tail: if (p + 3 < N)
    get(8); i32c(3); fn.push(I32_ADD); get(5); fn.push(I32_LT_S);
    fn.push(IF, 0x40);
    get(6);
    fn.push(IF, 0x40);
    get(8); i32c(2); fn.push(I32_SHL); set(20);
    for (let r = 0; r < 4; r++) {
      get(16 + r); get(20); fn.push(I32_ADD); vload(0); set(22 + r * 2);
    }
    fn.push(ELSE);
    for (let r = 0; r < 4; r++) {
      vzero();
      set(22 + r * 2);
    }
    fn.push(END);

    i32c(0); set(9);
    get(1); get(8); i32c(2); fn.push(I32_SHL, I32_ADD); set(20);
    fn.push(BLOCK, 0x40, LOOP, 0x40);
    get(9); get(10); fn.push(I32_GE_S);
    fn.push(BR_IF); pushUleb(fn, 1);
    get(20); vload(0); set(30);
    for (let r = 0; r < 4; r++) {
      get(12 + r); get(9); fn.push(I32_ADD); fload(0); simd(F32X4_SPLAT); set(32);
      get(22 + r * 2); get(32); get(30); simd(F32X4_MUL); simd(F32X4_ADD); set(22 + r * 2);
    }
    get(20); get(11); fn.push(I32_ADD); set(20);
    get(9); i32c(4); fn.push(I32_ADD); set(9);
    fn.push(BR); pushUleb(fn, 0);
    fn.push(END, END);

    get(8); i32c(2); fn.push(I32_SHL); set(20);
    for (let r = 0; r < 4; r++) {
      get(16 + r); get(20); fn.push(I32_ADD); get(22 + r * 2); vstore(0);
    }
    get(8); i32c(4); fn.push(I32_ADD); set(8);
    fn.push(END);

    // Scalar col tail: while (p < N)
    fn.push(BLOCK, 0x40, LOOP, 0x40);
    get(8); get(5); fn.push(I32_GE_S);
    fn.push(BR_IF); pushUleb(fn, 1);

    get(6);
    fn.push(IF, 0x40);
    get(8); i32c(2); fn.push(I32_SHL); set(20);
    for (let r = 0; r < 4; r++) {
      get(16 + r); get(20); fn.push(I32_ADD); fload(0); set(33 + r);
    }
    fn.push(ELSE);
    for (let r = 0; r < 4; r++) {
      fzero();
      set(33 + r);
    }
    fn.push(END);

    i32c(0); set(9);
    get(1); get(8); i32c(2); fn.push(I32_SHL, I32_ADD); set(20);
    fn.push(BLOCK, 0x40, LOOP, 0x40);
    get(9); get(10); fn.push(I32_GE_S);
    fn.push(BR_IF); pushUleb(fn, 1);
    for (let r = 0; r < 4; r++) {
      get(33 + r);
      get(12 + r); get(9); fn.push(I32_ADD); fload(0);
      get(20); fload(0);
      fn.push(F32_MUL, F32_ADD); set(33 + r);
    }
    get(20); get(11); fn.push(I32_ADD); set(20);
    get(9); i32c(4); fn.push(I32_ADD); set(9);
    fn.push(BR); pushUleb(fn, 0);
    fn.push(END, END);

    get(8); i32c(2); fn.push(I32_SHL); set(20);
    for (let r = 0; r < 4; r++) {
      get(16 + r); get(20); fn.push(I32_ADD); get(33 + r); fstore(0);
    }
    get(8); i32c(1); fn.push(I32_ADD); set(8);
    fn.push(BR); pushUleb(fn, 0);
    fn.push(END, END);

    get(7); i32c(4); fn.push(I32_ADD); set(7);
    fn.push(BR); pushUleb(fn, 0);
    fn.push(END, END);

    // Remaining OC rows (< 4): while (oc < OC)
    fn.push(BLOCK, 0x40, LOOP, 0x40);
    get(7); get(3); fn.push(I32_GE_S);
    fn.push(BR_IF); pushUleb(fn, 1);

    get(0); get(7); get(10); fn.push(I32_MUL, I32_ADD); set(12);
    get(2); get(7); get(11); fn.push(I32_MUL, I32_ADD); set(16);

    i32c(0); set(8);
    fn.push(BLOCK, 0x40, LOOP, 0x40);
    get(8); get(5); fn.push(I32_GE_S);
    fn.push(BR_IF); pushUleb(fn, 1);

    get(6);
    fn.push(IF, 0x40);
    get(16); get(8); i32c(2); fn.push(I32_SHL, I32_ADD); fload(0); set(33);
    fn.push(ELSE);
    fzero(); set(33);
    fn.push(END);

    i32c(0); set(9);
    get(1); get(8); i32c(2); fn.push(I32_SHL, I32_ADD); set(20);
    fn.push(BLOCK, 0x40, LOOP, 0x40);
    get(9); get(10); fn.push(I32_GE_S);
    fn.push(BR_IF); pushUleb(fn, 1);
    get(33);
    get(12); get(9); fn.push(I32_ADD); fload(0);
    get(20); fload(0);
    fn.push(F32_MUL, F32_ADD); set(33);
    get(20); get(11); fn.push(I32_ADD); set(20);
    get(9); i32c(4); fn.push(I32_ADD); set(9);
    fn.push(BR); pushUleb(fn, 0);
    fn.push(END, END);

    get(16); get(8); i32c(2); fn.push(I32_SHL, I32_ADD); get(33); fstore(0);
    get(8); i32c(1); fn.push(I32_ADD); set(8);
    fn.push(BR); pushUleb(fn, 0);
    fn.push(END, END);

    get(7); i32c(1); fn.push(I32_ADD); set(7);
    fn.push(BR); pushUleb(fn, 0);
    fn.push(END, END);

    fn.push(END);
    pushUleb(s, fn.length);
    for (let i = 0; i < fn.length; i++) s.push(fn[i]);
  });

  return new Uint8Array(bytes);
}

let wasmMem: WebAssembly.Memory | null = null;
let wasmGemm: WasmGemmFn | null = null;
let heapF32: Float32Array = new Float32Array(WASM_WS_BYTES >>> 2);
let weightCursorBytes = WASM_WS_BYTES;
const PREWARMED_MODELS = new WeakSet<KataGoLoadedModel>();

function initSharedHeapAndWasm(): void {
  if (typeof WebAssembly !== 'undefined') {
    try {
      const bytes = buildGemmSimdWasmBytes();
      if (WebAssembly.validate(bytes as BufferSource)) {
        const mem = new WebAssembly.Memory({ initial: INITIAL_WASM_PAGES });
        const mod = new WebAssembly.Module(bytes as BufferSource);
        const inst = new WebAssembly.Instance(mod, { env: { mem } });
        wasmMem = mem;
        wasmGemm = inst.exports.gemm as WasmGemmFn;
        heapF32 = new Float32Array(mem.buffer);
        return;
      }
    } catch {
      // Fallback cleanly to pure JS gemm4x2
    }
  }
  heapF32 = new Float32Array(WASM_WS_BYTES >>> 2);
}

initSharedHeapAndWasm();

function ensureHeapBytes(neededBytes: number): void {
  if (!wasmMem) return;
  const curBytes = wasmMem.buffer.byteLength;
  if (neededBytes <= curBytes) return;
  const extraPages = Math.ceil((neededBytes - curBytes) / WASM_PAGE_BYTES);
  wasmMem.grow(extraPages);
  heapF32 = new Float32Array(wasmMem.buffer);
}

function getHeapWeightOffset(weights: Float32Array): number {
  const existing = HEAP_WEIGHT_OFFSETS.get(weights);
  if (existing !== undefined) return existing;
  if (!wasmGemm) return -1;

  const offset = (weightCursorBytes + 15) & ~15;
  const bytes = weights.byteLength;
  ensureHeapBytes(offset + bytes);
  heapF32.set(weights, offset >>> 2);
  weightCursorBytes = offset + bytes;
  HEAP_WEIGHT_OFFSETS.set(weights, offset);
  return offset;
}

function prewarmConvLayer(conv: KataGoConvLayer): void {
  if (conv.ky === 3 && conv.kx === 3 && conv.dilY === 1 && conv.dilX === 1) {
    getHeapWeightOffset(getWinograd3x3Weights(conv));
  } else {
    getHeapWeightOffset(conv.weights);
  }
}

function ensureModelWeightsInHeap(model: KataGoLoadedModel): void {
  if (!wasmGemm || PREWARMED_MODELS.has(model)) return;
  prewarmConvLayer(model.initialConv);
  for (const blk of model.blocks) {
    prewarmConvLayer(blk.regularConv);
    if (blk.kind === 2) prewarmConvLayer(blk.gpoolConv);
    prewarmConvLayer(blk.finalConv);
  }
  prewarmConvLayer(model.p1Conv);
  prewarmConvLayer(model.g1Conv);
  prewarmConvLayer(model.p2Conv);
  prewarmConvLayer(model.v1Conv);
  prewarmConvLayer(model.vOwnershipConv);
  PREWARMED_MODELS.add(model);
}

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

/**
 * Pre-transform 3x3 convolution weights for Winograd F(4x4, 3x3).
 * Output layout: `[36, outChannels, inChannels]`.
 */
function getWinograd3x3Weights(conv: KataGoConvLayer): Float32Array {
  const cached = WINOGRAD_WEIGHT_CACHE.get(conv);
  if (cached) return cached;

  const OC = conv.outChannels;
  const IC = conv.inChannels;
  const W = conv.weights;
  const out = new Float32Array(36 * OC * IC);
  const tmp = new Float32Array(36);

  const transformVec = (idx0: number, stride: number) => {
    const z0 = tmp[idx0];
    const z1 = tmp[idx0 + stride];
    const z2 = tmp[idx0 + stride * 2];
    tmp[idx0] = 0.25 * z0;
    tmp[idx0 + stride] = (1.0 / 6.0) * (-z0 - z1 - z2);
    tmp[idx0 + stride * 2] = (1.0 / 6.0) * (-z0 + z1 - z2);
    tmp[idx0 + stride * 3] = (1.0 / 24.0) * (z0 + 2.0 * z1 + 4.0 * z2);
    tmp[idx0 + stride * 4] = (1.0 / 24.0) * (z0 - 2.0 * z1 + 4.0 * z2);
    tmp[idx0 + stride * 5] = z2;
  };

  for (let oc = 0; oc < OC; oc++) {
    for (let ic = 0; ic < IC; ic++) {
      const wBase = (oc * IC + ic) * 9;
      tmp.fill(0);
      for (let y = 0; y < 3; y++) {
        tmp[y * 6] = W[wBase + y * 3];
        tmp[y * 6 + 1] = W[wBase + y * 3 + 1];
        tmp[y * 6 + 2] = W[wBase + y * 3 + 2];
        transformVec(y * 6, 1);
      }
      for (let x = 0; x < 6; x++) {
        transformVec(x, 6);
      }
      for (let s = 0; s < 36; s++) {
        out[(s * OC + oc) * IC + ic] = tmp[s];
      }
    }
  }

  WINOGRAD_WEIGHT_CACHE.set(conv, out);
  return out;
}

function getWorkspace(model: KataGoLoadedModel, size: number): NetWorkspace {
  ensureModelWeightsInHeap(model);

  const key = `${model.modelName}:${size}`;
  const existing = WORKSPACE_CACHE.get(key);
  if (existing && existing.heapBuffer === heapF32.buffer) return existing;

  const area = size * size;
  const trunkC = model.trunkChannels;
  const midC = Math.max(model.midChannels, model.regularChannels, trunkC);
  const gpoolC = Math.max(model.gpoolChannels, model.policyChannels, model.valueChannels);

  const numTilesX = Math.ceil(size / 4);
  const numTilesY = Math.ceil(size / 4);
  const numTiles = numTilesX * numTilesY;
  const maxWinogradC = Math.max(trunkC, midC, gpoolC);

  let maxConvK = model.initialConv.inChannels * model.initialConv.ky * model.initialConv.kx;
  for (const blk of model.blocks) {
    maxConvK = Math.max(
      maxConvK,
      blk.regularConv.inChannels * blk.regularConv.ky * blk.regularConv.kx,
      blk.finalConv.inChannels * blk.finalConv.ky * blk.finalConv.kx
    );
    if (blk.kind === 2) {
      maxConvK = Math.max(
        maxConvK,
        blk.gpoolConv.inChannels * blk.gpoolConv.ky * blk.gpoolConv.kx
      );
    }
  }

  let heapCursorFloats = 0;
  const align4 = (n: number) => (n + 3) & ~3;
  const totalArenaFloats = WASM_WS_BYTES >>> 2;

  const allocF32 = (len: number): Float32Array => {
    const start = align4(heapCursorFloats);
    const end = start + len;
    if (wasmGemm && end <= totalArenaFloats) {
      heapCursorFloats = end;
      return heapF32.subarray(start, end);
    }
    return new Float32Array(len);
  };

  const ws: NetWorkspace = {
    size,
    area,
    numTilesX,
    numTilesY,
    numTiles,
    heapBuffer: heapF32.buffer,
    binInputs: allocF32(NUM_KATAGO_SPATIAL_FEATURES * area),
    globalInputs: new Float32Array(NUM_KATAGO_GLOBAL_FEATURES),
    trunkA: allocF32(trunkC * area),
    trunkB: allocF32(trunkC * area),
    midA: allocF32(midC * area),
    midB: allocF32(midC * area),
    gpoolOut: allocF32(gpoolC * area),
    gpoolAct: allocF32(gpoolC * area),
    gpoolConcat: new Float32Array(gpoolC * 3),
    gpoolBias: new Float32Array(midC),
    initGlobalBias: new Float32Array(trunkC),
    p1Out: allocF32(model.policyChannels * area),
    p1Act: allocF32(model.policyChannels * area),
    g1Out: allocF32(model.g1Conv.outChannels * area),
    g1Act: allocF32(model.g1Conv.outChannels * area),
    g1Concat: new Float32Array(model.g1Conv.outChannels * 3),
    g1Bias: new Float32Array(model.policyChannels),
    policyRaw: allocF32(area),
    policyPass: new Float32Array(1),
    v1Out: allocF32(model.valueChannels * area),
    v1Act: allocF32(model.valueChannels * area),
    v1Pool: new Float32Array(model.valueChannels * 3),
    v2Out: new Float32Array(model.valueHiddenChannels),
    v3Out: new Float32Array(3),
    sv3Out: new Float32Array(model.sv3Mul.outChannels),
    ownershipRaw: allocF32(area),
    colBuf: allocF32(maxConvK * area),
    winogradIn: allocF32(36 * maxWinogradC * numTiles),
    winogradOut: allocF32(36 * maxWinogradC * numTiles),
    winogradTile: new Float32Array(36),
    symTable: existing ? existing.symTable : buildSymTable(size),
  };

  WORKSPACE_CACHE.set(key, ws);
  return ws;
}

function applyActivationScalar(v: number, act: KataGoActivationKind): number {
  if (act === 1) return v > 0 ? v : 0; // RELU
  if (act === 0) return v; // IDENTITY
  if (act === 2) {
    const sp = v < 20.0 ? Math.log1p(Math.exp(v)) : v;
    return v * Math.tanh(sp);
  }
  return v / (1.0 + Math.exp(-v));
}

function applyFoldedBN(
  bn: KataGoFoldedBNLayer,
  input: Float32Array,
  output: Float32Array,
  area: number
): void {
  const C = bn.numChannels;
  const scales = bn.mergedScale;
  const biases = bn.mergedBias;
  const act = bn.activation;

  if (act === 1) {
    for (let c = 0; c < C; c++) {
      const s = scales[c];
      const b = biases[c];
      const base = c * area;
      for (let i = 0; i < area; i++) {
        const v = input[base + i] * s + b;
        output[base + i] = v > 0 ? v : 0;
      }
    }
    return;
  }

  for (let c = 0; c < C; c++) {
    const s = scales[c];
    const b = biases[c];
    const base = c * area;
    for (let i = 0; i < area; i++) {
      output[base + i] = applyActivationScalar(input[base + i] * s + b, act);
    }
  }
}

function matMul(layer: KataGoMatMulLayer, input: Float32Array, output: Float32Array): void {
  const IC = layer.inChannels;
  const OC = layer.outChannels;
  const W = layer.weights;
  for (let oc = 0; oc < OC; oc++) {
    const wBase = oc * IC;
    let sum = 0;
    let ic = 0;
    for (; ic + 3 < IC; ic += 4) {
      sum +=
        W[wBase + ic] * input[ic] +
        W[wBase + ic + 1] * input[ic + 1] +
        W[wBase + ic + 2] * input[ic + 2] +
        W[wBase + ic + 3] * input[ic + 3];
    }
    for (; ic < IC; ic++) {
      sum += W[wBase + ic] * input[ic];
    }
    output[oc] = sum;
  }
}

function addChannelBiasInplace(buf: Float32Array, bias: Float32Array, channels: number, area: number): void {
  for (let c = 0; c < channels; c++) {
    const b = bias[c];
    const base = c * area;
    for (let i = 0; i < area; i++) {
      buf[base + i] += b;
    }
  }
}

/**
 * General im2col for non-Winograd convolutions (5x5 initialConv, dilated 3x3).
 */
function im2col(
  input: Float32Array,
  size: number,
  icCount: number,
  ky: number,
  kx: number,
  dilY: number,
  dilX: number,
  col: Float32Array
): void {
  const area = size * size;
  const kArea = ky * kx;
  const padY = ((ky - 1) >> 1) * dilY;
  const padX = ((kx - 1) >> 1) * dilX;

  for (let ic = 0; ic < icCount; ic++) {
    const inBase = ic * area;
    const colIcBase = ic * kArea * area;
    for (let dy = 0; dy < ky; dy++) {
      const yOff = dy * dilY - padY;
      for (let dx = 0; dx < kx; dx++) {
        const xOff = dx * dilX - padX;
        const colRowBase = colIcBase + (dy * kx + dx) * area;
        col.fill(0, colRowBase, colRowBase + area);

        for (let y = 0; y < size; y++) {
          const sy = y + yOff;
          if (sy < 0 || sy >= size) continue;
          const srcRow = inBase + sy * size;
          const dstRow = colRowBase + y * size;
          for (let x = 0; x < size; x++) {
            const sx = x + xOff;
            if (sx < 0 || sx >= size) continue;
            col[dstRow + x] = input[srcRow + sx];
          }
        }
      }
    }
  }
}

/**
 * Register-fit 4x2 tiled GEMM (8 accumulators -> zero XMM register spills in V8 x64):
 * `out[outOff + oc, p] (+)= W[wOff + oc, k] * B[bOff + k, p]`.
 */
function gemm4x2(
  W: Float32Array,
  wOff: number,
  B: Float32Array,
  bOff: number,
  out: Float32Array,
  outOff: number,
  OC: number,
  K: number,
  N: number,
  accumulate: boolean
): void {
  let oc = 0;
  for (; oc + 3 < OC; oc += 4) {
    const w0Base = wOff + oc * K;
    const w1Base = w0Base + K;
    const w2Base = w1Base + K;
    const w3Base = w2Base + K;
    const o0Base = outOff + oc * N;
    const o1Base = o0Base + N;
    const o2Base = o1Base + N;
    const o3Base = o2Base + N;

    let p = 0;
    for (; p + 1 < N; p += 2) {
      let c00 = accumulate ? out[o0Base + p] : 0;
      let c01 = accumulate ? out[o0Base + p + 1] : 0;
      let c10 = accumulate ? out[o1Base + p] : 0;
      let c11 = accumulate ? out[o1Base + p + 1] : 0;
      let c20 = accumulate ? out[o2Base + p] : 0;
      let c21 = accumulate ? out[o2Base + p + 1] : 0;
      let c30 = accumulate ? out[o3Base + p] : 0;
      let c31 = accumulate ? out[o3Base + p + 1] : 0;

      for (let k = 0; k < K; k++) {
        const bBase = bOff + k * N + p;
        const b0 = B[bBase];
        const b1 = B[bBase + 1];
        const w0 = W[w0Base + k];
        const w1 = W[w1Base + k];
        const w2 = W[w2Base + k];
        const w3 = W[w3Base + k];
        c00 += w0 * b0;
        c01 += w0 * b1;
        c10 += w1 * b0;
        c11 += w1 * b1;
        c20 += w2 * b0;
        c21 += w2 * b1;
        c30 += w3 * b0;
        c31 += w3 * b1;
      }

      out[o0Base + p] = c00;
      out[o0Base + p + 1] = c01;
      out[o1Base + p] = c10;
      out[o1Base + p + 1] = c11;
      out[o2Base + p] = c20;
      out[o2Base + p + 1] = c21;
      out[o3Base + p] = c30;
      out[o3Base + p + 1] = c31;
    }

    for (; p < N; p++) {
      let c0 = accumulate ? out[o0Base + p] : 0;
      let c1 = accumulate ? out[o1Base + p] : 0;
      let c2 = accumulate ? out[o2Base + p] : 0;
      let c3 = accumulate ? out[o3Base + p] : 0;
      for (let k = 0; k < K; k++) {
        const b = B[bOff + k * N + p];
        c0 += W[w0Base + k] * b;
        c1 += W[w1Base + k] * b;
        c2 += W[w2Base + k] * b;
        c3 += W[w3Base + k] * b;
      }
      out[o0Base + p] = c0;
      out[o1Base + p] = c1;
      out[o2Base + p] = c2;
      out[o3Base + p] = c3;
    }
  }

  for (; oc < OC; oc++) {
    const wBase = wOff + oc * K;
    const oBase = outOff + oc * N;
    for (let p = 0; p < N; p++) {
      let c = accumulate ? out[oBase + p] : 0;
      for (let k = 0; k < K; k++) {
        c += W[wBase + k] * B[bOff + k * N + p];
      }
      out[oBase + p] = c;
    }
  }
}

/**
 * Winograd F(4x4, 3x3) forward pass matching KataGo EigenBackend (`eigenbackend.cpp`).
 */
function applyConv3x3Winograd(
  conv: KataGoConvLayer,
  input: Float32Array,
  output: Float32Array,
  ws: NetWorkspace,
  accumulate: boolean
): void {
  const size = ws.size;
  const area = ws.area;
  const numTilesX = ws.numTilesX;
  const numTilesY = ws.numTilesY;
  const numTiles = ws.numTiles;
  const IC = conv.inChannels;
  const OC = conv.outChannels;

  const winIn = ws.winogradIn;
  const winOut = ws.winogradOut;
  const tile = ws.winogradTile;
  const winW = getWinograd3x3Weights(conv);

  // 1. Input transform: `[IC, size, size]` -> `winIn[36, IC, numTiles]`
  const inSliceStride = IC * numTiles;
  for (let ic = 0; ic < IC; ic++) {
    const inBase = ic * area;
    const icTileBase = ic * numTiles;
    for (let yTile = 0; yTile < numTilesY; yTile++) {
      const y0 = yTile * 4 - 1;
      for (let xTile = 0; xTile < numTilesX; xTile++) {
        const x0 = xTile * 4 - 1;
        const tileIdx = yTile * numTilesX + xTile;

        // Load 6x6 patch with zero padding and transform rows
        for (let dy = 0; dy < 6; dy++) {
          const y = y0 + dy;
          const rowBase = dy * 6;
          if (y < 0 || y >= size) {
            tile[rowBase] = 0;
            tile[rowBase + 1] = 0;
            tile[rowBase + 2] = 0;
            tile[rowBase + 3] = 0;
            tile[rowBase + 4] = 0;
            tile[rowBase + 5] = 0;
          } else {
            const imgRow = inBase + y * size;
            const z0 = x0 >= 0 && x0 < size ? input[imgRow + x0] : 0;
            const z1 = x0 + 1 >= 0 && x0 + 1 < size ? input[imgRow + x0 + 1] : 0;
            const z2 = x0 + 2 >= 0 && x0 + 2 < size ? input[imgRow + x0 + 2] : 0;
            const z3 = x0 + 3 >= 0 && x0 + 3 < size ? input[imgRow + x0 + 3] : 0;
            const z4 = x0 + 4 >= 0 && x0 + 4 < size ? input[imgRow + x0 + 4] : 0;
            const z5 = x0 + 5 >= 0 && x0 + 5 < size ? input[imgRow + x0 + 5] : 0;

            tile[rowBase] = 4.0 * z0 - 5.0 * z2 + z4;
            tile[rowBase + 1] = -4.0 * z1 - 4.0 * z2 + z3 + z4;
            tile[rowBase + 2] = 4.0 * z1 - 4.0 * z2 - z3 + z4;
            tile[rowBase + 3] = -2.0 * z1 - z2 + 2.0 * z3 + z4;
            tile[rowBase + 4] = 2.0 * z1 - z2 - 2.0 * z3 + z4;
            tile[rowBase + 5] = 4.0 * z1 - 5.0 * z3 + z5;
          }
        }

        // Transform columns and scatter into 36 frequency slices
        const dstBase = icTileBase + tileIdx;
        for (let dx = 0; dx < 6; dx++) {
          const z0 = tile[dx];
          const z1 = tile[6 + dx];
          const z2 = tile[12 + dx];
          const z3 = tile[18 + dx];
          const z4 = tile[24 + dx];
          const z5 = tile[30 + dx];

          winIn[(0 * 6 + dx) * inSliceStride + dstBase] = 4.0 * z0 - 5.0 * z2 + z4;
          winIn[(1 * 6 + dx) * inSliceStride + dstBase] = -4.0 * z1 - 4.0 * z2 + z3 + z4;
          winIn[(2 * 6 + dx) * inSliceStride + dstBase] = 4.0 * z1 - 4.0 * z2 - z3 + z4;
          winIn[(3 * 6 + dx) * inSliceStride + dstBase] = -2.0 * z1 - z2 + 2.0 * z3 + z4;
          winIn[(4 * 6 + dx) * inSliceStride + dstBase] = 2.0 * z1 - z2 - 2.0 * z3 + z4;
          winIn[(5 * 6 + dx) * inSliceStride + dstBase] = 4.0 * z1 - 5.0 * z3 + z5;
        }
      }
    }
  }

  // 2. 36 batched small GEMMs: `[OC, IC] * [IC, numTiles]` -> `[OC, numTiles]`
  const wSliceStride = OC * IC;
  const outSliceStride = OC * numTiles;
  const wHeapOff = wasmGemm ? getHeapWeightOffset(winW) : -1;
  if (
    wasmGemm &&
    wHeapOff >= 0 &&
    winIn.buffer === heapF32.buffer &&
    winOut.buffer === heapF32.buffer
  ) {
    const winInBase = winIn.byteOffset;
    const winOutBase = winOut.byteOffset;
    const wSliceBytes = wSliceStride * 4;
    const inSliceBytes = inSliceStride * 4;
    const outSliceBytes = outSliceStride * 4;
    for (let s = 0; s < 36; s++) {
      wasmGemm(
        wHeapOff + s * wSliceBytes,
        winInBase + s * inSliceBytes,
        winOutBase + s * outSliceBytes,
        OC,
        IC,
        numTiles,
        0
      );
    }
  } else {
    for (let s = 0; s < 36; s++) {
      gemm4x2(
        winW,
        s * wSliceStride,
        winIn,
        s * inSliceStride,
        winOut,
        s * outSliceStride,
        OC,
        IC,
        numTiles,
        false
      );
    }
  }

  // 3. Output inverse transform: `winOut[36, OC, numTiles]` -> `output[OC, size, size]`
  for (let oc = 0; oc < OC; oc++) {
    const outBase = oc * area;
    const ocTileBase = oc * numTiles;
    for (let yTile = 0; yTile < numTilesY; yTile++) {
      const yOutBase = yTile * 4;
      const dyLimit = Math.min(4, size - yOutBase);
      for (let xTile = 0; xTile < numTilesX; xTile++) {
        const xOutBase = xTile * 4;
        const dxLimit = Math.min(4, size - xOutBase);
        const srcBase = ocTileBase + yTile * numTilesX + xTile;

        // Gather 6x6 and inverse-transform rows -> 6x4
        for (let dy = 0; dy < 6; dy++) {
          const s0 = dy * 6;
          const z0 = winOut[s0 * outSliceStride + srcBase];
          const z1 = winOut[(s0 + 1) * outSliceStride + srcBase];
          const z2 = winOut[(s0 + 2) * outSliceStride + srcBase];
          const z3 = winOut[(s0 + 3) * outSliceStride + srcBase];
          const z4 = winOut[(s0 + 4) * outSliceStride + srcBase];
          const z5 = winOut[(s0 + 5) * outSliceStride + srcBase];

          const rowOff = dy * 4;
          tile[rowOff] = z0 + z1 + z2 + z3 + z4;
          tile[rowOff + 1] = z1 - z2 + 2.0 * (z3 - z4);
          tile[rowOff + 2] = z1 + z2 + 4.0 * (z3 + z4);
          tile[rowOff + 3] = z1 - z2 + 8.0 * (z3 - z4) + z5;
        }

        // Inverse-transform columns -> 4x4 and store
        for (let dx = 0; dx < dxLimit; dx++) {
          const z0 = tile[dx];
          const z1 = tile[4 + dx];
          const z2 = tile[8 + dx];
          const z3 = tile[12 + dx];
          const z4 = tile[16 + dx];
          const z5 = tile[20 + dx];

          const o0 = z0 + z1 + z2 + z3 + z4;
          const o1 = z1 - z2 + 2.0 * (z3 - z4);
          const o2 = z1 + z2 + 4.0 * (z3 + z4);
          const o3 = z1 - z2 + 8.0 * (z3 - z4) + z5;

          const colX = xOutBase + dx;
          if (accumulate) {
            output[outBase + yOutBase * size + colX] += o0;
            if (dyLimit > 1) output[outBase + (yOutBase + 1) * size + colX] += o1;
            if (dyLimit > 2) output[outBase + (yOutBase + 2) * size + colX] += o2;
            if (dyLimit > 3) output[outBase + (yOutBase + 3) * size + colX] += o3;
          } else {
            output[outBase + yOutBase * size + colX] = o0;
            if (dyLimit > 1) output[outBase + (yOutBase + 1) * size + colX] = o1;
            if (dyLimit > 2) output[outBase + (yOutBase + 2) * size + colX] = o2;
            if (dyLimit > 3) output[outBase + (yOutBase + 3) * size + colX] = o3;
          }
        }
      }
    }
  }
}

function applyConv(
  conv: KataGoConvLayer,
  input: Float32Array,
  output: Float32Array,
  ws: NetWorkspace,
  accumulate: boolean
): void {
  const N = ws.area;
  const accumFlag = accumulate ? 1 : 0;
  if (conv.ky === 1 && conv.kx === 1) {
    const wOff = wasmGemm ? getHeapWeightOffset(conv.weights) : -1;
    if (
      wasmGemm &&
      wOff >= 0 &&
      input.buffer === heapF32.buffer &&
      output.buffer === heapF32.buffer
    ) {
      wasmGemm(wOff, input.byteOffset, output.byteOffset, conv.outChannels, conv.inChannels, N, accumFlag);
    } else {
      gemm4x2(conv.weights, 0, input, 0, output, 0, conv.outChannels, conv.inChannels, N, accumulate);
    }
    return;
  }
  if (conv.ky === 3 && conv.kx === 3 && conv.dilY === 1 && conv.dilX === 1) {
    applyConv3x3Winograd(conv, input, output, ws, accumulate);
    return;
  }
  const K = conv.inChannels * conv.ky * conv.kx;
  im2col(input, ws.size, conv.inChannels, conv.ky, conv.kx, conv.dilY, conv.dilX, ws.colBuf);
  const wOff = wasmGemm ? getHeapWeightOffset(conv.weights) : -1;
  if (
    wasmGemm &&
    wOff >= 0 &&
    ws.colBuf.buffer === heapF32.buffer &&
    output.buffer === heapF32.buffer
  ) {
    wasmGemm(wOff, ws.colBuf.byteOffset, output.byteOffset, conv.outChannels, K, N, accumFlag);
  } else {
    gemm4x2(conv.weights, 0, ws.colBuf, 0, output, 0, conv.outChannels, K, N, accumulate);
  }
}

/**
 * KataGo Global Pooling (`poolRowsGPool` in `eigenbackend.cpp`):
 * [mean, mean * (sqrt(area) - 14) * 0.1, max]
 */
function poolRowsGPool(
  input: Float32Array,
  out: Float32Array,
  channels: number,
  area: number
): void {
  const areaScale = (Math.sqrt(area) - 14.0) * 0.1;
  const invArea = 1.0 / area;
  for (let c = 0; c < channels; c++) {
    const base = c * area;
    let sum = 0;
    let maxVal = -1.0;
    for (let i = 0; i < area; i++) {
      const v = input[base + i];
      sum += v;
      if (v > maxVal) maxVal = v;
    }
    const mean = sum * invArea;
    out[c] = mean;
    out[c + channels] = mean * areaScale;
    out[c + channels * 2] = maxVal;
  }
}

/**
 * KataGo Value Head Pooling (`poolRowsValueHead` in `eigenbackend.cpp`):
 * [mean, mean * (sqrt(area) - 14) * 0.1, mean * ((sqrt(area) - 14)^2 * 0.01 - 0.1)]
 */
function poolRowsValueHead(
  input: Float32Array,
  out: Float32Array,
  channels: number,
  area: number
): void {
  const d = Math.sqrt(area) - 14.0;
  const scale1 = d * 0.1;
  const scale2 = d * d * 0.01 - 0.1;
  const invArea = 1.0 / area;
  for (let c = 0; c < channels; c++) {
    const base = c * area;
    let sum = 0;
    for (let i = 0; i < area; i++) {
      sum += input[base + i];
    }
    const mean = sum * invArea;
    out[c] = mean;
    out[c + channels] = mean * scale1;
    out[c + channels * 2] = mean * scale2;
  }
}

/**
 * Evaluate a Go board position using the loaded pure-TypeScript KataGo Model v8 evaluator.
 * Returns `null` if the model has not been loaded yet (e.g. in Browser before `ensureKataGoModelLoaded()` resolves).
 */
export function evaluateKataGoPosition(
  pos: KataGoInputPosition,
  legalMask?: Uint8Array,
  symmetry = 0
): KataGoNetOutput | null {
  const model = getKataGoModelSync();
  if (!model) return null;

  const size = pos.size;
  const area = size * size;
  const sym = ((symmetry % 8) + 8) % 8;
  const ws = getWorkspace(model, size);

  // 1. Encode V7 features into workspace buffers
  encodeKataGoV7InputsInto(pos, sym, ws.binInputs, ws.globalInputs);

  // 2. Trunk initial conv + global linear bias
  applyConv(model.initialConv, ws.binInputs, ws.trunkA, ws, false);
  matMul(model.initialMatMul, ws.globalInputs, ws.initGlobalBias);
  addChannelBiasInplace(ws.trunkA, ws.initGlobalBias, model.trunkChannels, area);

  // 3. Residual block stack
  for (let b = 0; b < model.blocks.length; b++) {
    const blk = model.blocks[b];
    if (blk.kind === 0) {
      applyFoldedBN(blk.preBN, ws.trunkA, ws.trunkB, area);
      applyConv(blk.regularConv, ws.trunkB, ws.midA, ws, false);
      applyFoldedBN(blk.midBN, ws.midA, ws.midB, area);
      applyConv(blk.finalConv, ws.midB, ws.trunkA, ws, true);
    } else {
      applyFoldedBN(blk.preBN, ws.trunkA, ws.trunkB, area);
      applyConv(blk.regularConv, ws.trunkB, ws.midA, ws, false);
      applyConv(blk.gpoolConv, ws.trunkB, ws.gpoolOut, ws, false);
      applyFoldedBN(blk.gpoolBN, ws.gpoolOut, ws.gpoolAct, area);
      poolRowsGPool(ws.gpoolAct, ws.gpoolConcat, blk.gpoolConv.outChannels, area);
      matMul(blk.gpoolToBiasMul, ws.gpoolConcat, ws.gpoolBias);
      addChannelBiasInplace(ws.midA, ws.gpoolBias, blk.regularConv.outChannels, area);
      applyFoldedBN(blk.midBN, ws.midA, ws.midB, area);
      applyConv(blk.finalConv, ws.midB, ws.trunkA, ws, true);
    }
  }

  // Trunk tip BN + activation -> trunkB
  applyFoldedBN(model.trunkTipBN, ws.trunkA, ws.trunkB, area);

  // 4. Policy Head
  applyConv(model.p1Conv, ws.trunkB, ws.p1Out, ws, false);
  applyConv(model.g1Conv, ws.trunkB, ws.g1Out, ws, false);
  applyFoldedBN(model.g1BN, ws.g1Out, ws.g1Act, area);
  poolRowsGPool(ws.g1Act, ws.g1Concat, model.g1Conv.outChannels, area);
  matMul(model.gpoolToBiasMul, ws.g1Concat, ws.g1Bias);
  addChannelBiasInplace(ws.p1Out, ws.g1Bias, model.p1Conv.outChannels, area);
  applyFoldedBN(model.p1BN, ws.p1Out, ws.p1Act, area);
  applyConv(model.p2Conv, ws.p1Act, ws.policyRaw, ws, false);
  matMul(model.gpoolToPassMul, ws.g1Concat, ws.policyPass);

  // Un-transform policy logits back to original coordinates, mask illegals, and softmax
  const policyProbs = new Float32Array(area + 1);
  const symBase = sym * area;
  const symTable = ws.symTable;
  let maxLogit = -Infinity;

  for (let i = 0; i < area; i++) {
    if (pos.board[i] !== 0 || (legalMask && legalMask[i] === 0)) {
      policyProbs[i] = -Infinity;
    } else {
      const logit = ws.policyRaw[symTable[symBase + i]];
      policyProbs[i] = logit;
      if (logit > maxLogit) maxLogit = logit;
    }
  }
  const passLogit = ws.policyPass[0];
  policyProbs[area] = passLogit;
  if (passLogit > maxLogit) maxLogit = passLogit;

  let probSum = 0;
  for (let i = 0; i <= area; i++) {
    const v = policyProbs[i];
    if (v === -Infinity) {
      policyProbs[i] = 0;
    } else {
      const e = Math.exp(v - maxLogit);
      policyProbs[i] = e;
      probSum += e;
    }
  }
  if (probSum > 0) {
    const invSum = 1.0 / probSum;
    for (let i = 0; i <= area; i++) {
      policyProbs[i] *= invSum;
    }
  } else {
    policyProbs[area] = 1.0;
  }

  // 5. Value Head
  applyConv(model.v1Conv, ws.trunkB, ws.v1Out, ws, false);
  applyFoldedBN(model.v1BN, ws.v1Out, ws.v1Act, area);
  poolRowsValueHead(ws.v1Act, ws.v1Pool, model.v1Conv.outChannels, area);

  matMul(model.v2Mul, ws.v1Pool, ws.v2Out);
  for (let i = 0; i < ws.v2Out.length; i++) {
    ws.v2Out[i] = applyActivationScalar(ws.v2Out[i] + model.v2Bias[i], model.v2Activation);
  }

  matMul(model.v3Mul, ws.v2Out, ws.v3Out);
  const winLogit = ws.v3Out[0] + model.v3Bias[0];
  const lossLogit = ws.v3Out[1] + model.v3Bias[1];
  const noResultLogit = ws.v3Out[2] + model.v3Bias[2];

  const maxVLogit = Math.max(winLogit, lossLogit, noResultLogit);
  const wExp = Math.exp(winLogit - maxVLogit);
  const lExp = Math.exp(lossLogit - maxVLogit);
  const nExp = Math.exp(noResultLogit - maxVLogit);
  const vSum = wExp + lExp + nExp;
  const winProb = wExp / vSum;
  const noResultProb = nExp / vSum;
  const winrate = winProb + 0.5 * noResultProb;

  matMul(model.sv3Mul, ws.v2Out, ws.sv3Out);
  const leadPreScaled = ws.sv3Out[2] + model.sv3Bias[2];
  const scoreLead = leadPreScaled * 20.0 * (1.0 - noResultProb);

  // Ownership map (tanh, +1 = pos.pla, -1 = opponent)
  applyConv(model.vOwnershipConv, ws.v1Act, ws.ownershipRaw, ws, false);
  const ownership = new Float32Array(area);
  for (let i = 0; i < area; i++) {
    ownership[i] = Math.tanh(ws.ownershipRaw[symTable[symBase + i]]);
  }

  return {
    policyProbs,
    winrate,
    scoreLead,
    ownership,
  };
}
