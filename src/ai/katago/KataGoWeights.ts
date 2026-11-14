export type KataGoActivationKind = 0 | 1 | 2 | 3; // 0=IDENTITY, 1=RELU, 2=MISH, 3=SILU

export interface KataGoConvLayer {
  ky: number;
  kx: number;
  dilY: number;
  dilX: number;
  inChannels: number;
  outChannels: number;
  /** Layout: [outChannels, inChannels * ky * kx] */
  weights: Float32Array;
}

export interface KataGoMatMulLayer {
  inChannels: number;
  outChannels: number;
  /** Layout: [outChannels, inChannels] for fast row dot products */
  weights: Float32Array;
}

export interface KataGoFoldedBNLayer {
  numChannels: number;
  activation: KataGoActivationKind;
  mergedScale: Float32Array;
  mergedBias: Float32Array;
}

export type KataGoTrunkBlock =
  | {
      kind: 0; // ordinary_block
      preBN: KataGoFoldedBNLayer;
      regularConv: KataGoConvLayer;
      midBN: KataGoFoldedBNLayer;
      finalConv: KataGoConvLayer;
    }
  | {
      kind: 2; // gpool_block
      preBN: KataGoFoldedBNLayer;
      regularConv: KataGoConvLayer;
      gpoolConv: KataGoConvLayer;
      gpoolBN: KataGoFoldedBNLayer;
      gpoolToBiasMul: KataGoMatMulLayer;
      midBN: KataGoFoldedBNLayer;
      finalConv: KataGoConvLayer;
    };

export interface KataGoLoadedModel {
  modelName: string;
  version: number;
  numInputChannels: number;
  numInputGlobalChannels: number;
  numBlocks: number;
  trunkChannels: number;
  midChannels: number;
  regularChannels: number;
  gpoolChannels: number;
  policyChannels: number;
  valueChannels: number;
  valueHiddenChannels: number;
  initialConv: KataGoConvLayer;
  initialMatMul: KataGoMatMulLayer;
  blocks: KataGoTrunkBlock[];
  trunkTipBN: KataGoFoldedBNLayer;
  p1Conv: KataGoConvLayer;
  g1Conv: KataGoConvLayer;
  g1BN: KataGoFoldedBNLayer;
  gpoolToBiasMul: KataGoMatMulLayer;
  p1BN: KataGoFoldedBNLayer;
  p2Conv: KataGoConvLayer;
  gpoolToPassMul: KataGoMatMulLayer;
  v1Conv: KataGoConvLayer;
  v1BN: KataGoFoldedBNLayer;
  v2Mul: KataGoMatMulLayer;
  v2Bias: Float32Array;
  v2Activation: KataGoActivationKind;
  v3Mul: KataGoMatMulLayer;
  v3Bias: Float32Array;
  sv3Mul: KataGoMatMulLayer;
  sv3Bias: Float32Array;
  vOwnershipConv: KataGoConvLayer;
}

interface NodeBuiltinProcess {
  getBuiltinModule?: (id: string) => unknown;
  cwd?: () => string;
}

interface NodeFsModule {
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
}

interface NodeZlibModule {
  gunzipSync(buf: Uint8Array): Uint8Array;
}

interface NodePathModule {
  resolve(...paths: string[]): string;
}

function getNodeBuiltins(): {
  proc?: NodeBuiltinProcess;
  fs?: NodeFsModule;
  zlib?: NodeZlibModule;
  path?: NodePathModule;
} {
  const proc = (globalThis as { process?: NodeBuiltinProcess }).process;
  if (!proc || typeof proc.getBuiltinModule !== 'function') {
    return {};
  }
  const fs = proc.getBuiltinModule('node:fs') as NodeFsModule | undefined;
  const zlib = proc.getBuiltinModule('node:zlib') as NodeZlibModule | undefined;
  const path = proc.getBuiltinModule('node:path') as NodePathModule | undefined;
  return { proc, fs, zlib, path };
}

// IEEE-754 Float16 -> Float32 lookup table (built lazily once)
let f16Lut: Float32Array | null = null;

function getFloat16Lut(): Float32Array {
  if (f16Lut) return f16Lut;
  const lut = new Float32Array(65536);
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (let h = 0; h < 65536; h++) {
    const s = (h & 0x8000) << 16;
    const e = (h & 0x7c00) >>> 10;
    const m = h & 0x03ff;
    if (e === 0) {
      if (m === 0) {
        u32[0] = s;
        lut[h] = f32[0];
      } else {
        // Subnormal
        let val = m / 1024;
        val *= 2 ** -14;
        lut[h] = s ? -val : val;
      }
    } else if (e === 31) {
      u32[0] = s | 0x7f800000 | (m << 13);
      lut[h] = f32[0];
    } else {
      u32[0] = s | ((e - 15 + 127) << 23) | (m << 13);
      lut[h] = f32[0];
    }
  }
  f16Lut = lut;
  return lut;
}

function isGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gunzipBrowser(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is unavailable in this environment');
  }
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

class BinaryReader {
  private readonly u8: Uint8Array;
  private readonly view: DataView;
  private offset = 0;
  private readonly lut: Float32Array;

  constructor(bytes: Uint8Array) {
    this.u8 = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.lut = getFloat16Lut();
  }

  readU8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  readU32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readI32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  align4(): void {
    const rem = this.offset & 3;
    if (rem !== 0) {
      this.offset += 4 - rem;
    }
  }

  readString(byteLen: number): string {
    const slice = this.u8.subarray(this.offset, this.offset + byteLen);
    this.offset += byteLen;
    this.align4();
    return new TextDecoder('utf-8').decode(slice);
  }

  readF32Array(count: number): Float32Array {
    this.align4();
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = this.view.getFloat32(this.offset, true);
      this.offset += 4;
    }
    return out;
  }

  readF16ArrayAsF32(count: number): Float32Array {
    const out = new Float32Array(count);
    const lut = this.lut;
    for (let i = 0; i < count; i++) {
      const h = this.view.getUint16(this.offset, true);
      out[i] = lut[h];
      this.offset += 2;
    }
    this.align4();
    return out;
  }

  readConv(): KataGoConvLayer {
    const ky = this.readU8();
    const kx = this.readU8();
    const dilY = this.readU8();
    const dilX = this.readU8();
    const inChannels = this.readU32();
    const outChannels = this.readU32();
    const weights = this.readF16ArrayAsF32(outChannels * inChannels * ky * kx);
    return { ky, kx, dilY, dilX, inChannels, outChannels, weights };
  }

  readMatMul(): KataGoMatMulLayer {
    const inChannels = this.readU32();
    const outChannels = this.readU32();
    const weights = this.readF16ArrayAsF32(outChannels * inChannels);
    return { inChannels, outChannels, weights };
  }

  readFoldedBN(): KataGoFoldedBNLayer {
    const numChannels = this.readU32();
    const activation = this.readU32() as KataGoActivationKind;
    const mergedScale = this.readF32Array(numChannels);
    const mergedBias = this.readF32Array(numChannels);
    return { numChannels, activation, mergedScale, mergedBias };
  }

  readBias(): Float32Array {
    const numChannels = this.readU32();
    return this.readF32Array(numChannels);
  }
}

let cachedModel: KataGoLoadedModel | null = null;
let inFlightLoad: Promise<KataGoLoadedModel | null> | null = null;

/**
 * Hydrate a `KataGoLoadedModel` from raw `'KTGM'` bytes or gzipped `.ktg` bytes.
 * Note: In browser environments without Node's `zlib`, pass already-gunzipped `'KTGM'` bytes
 * or use `ensureKataGoModelLoaded()`.
 */
export function hydrateKataGoModelFromBytes(rawOrGzipped: Uint8Array): KataGoLoadedModel {
  let raw = rawOrGzipped;
  if (isGzipped(raw)) {
    const { zlib } = getNodeBuiltins();
    if (!zlib) {
      throw new Error('Cannot synchronously gunzip KataGo model outside Node.js');
    }
    raw = zlib.gunzipSync(raw);
  }

  if (
    raw.length < 56 ||
    raw[0] !== 0x4b ||
    raw[1] !== 0x54 ||
    raw[2] !== 0x47 ||
    raw[3] !== 0x4d
  ) {
    throw new Error('Invalid KataGo binary model header (expected KTGM)');
  }

  const r = new BinaryReader(raw);
  r.readU32(); // magic 'KTGM'
  const formatVersion = r.readU32();
  if (formatVersion !== 1) {
    throw new Error(`Unsupported KTGM format version: ${formatVersion}`);
  }

  const version = r.readI32();
  const numInputChannels = r.readI32();
  const numInputGlobalChannels = r.readI32();
  const numBlocks = r.readI32();
  const trunkChannels = r.readI32();
  const midChannels = r.readI32();
  const regularChannels = r.readI32();
  const gpoolChannels = r.readI32();
  const policyChannels = r.readI32();
  const valueChannels = r.readI32();
  const valueHiddenChannels = r.readI32();
  const nameLen = r.readU32();
  const modelName = r.readString(nameLen);

  const initialConv = r.readConv();
  const initialMatMul = r.readMatMul();

  const blocks: KataGoTrunkBlock[] = [];
  for (let b = 0; b < numBlocks; b++) {
    const kind = r.readU32();
    if (kind === 0) {
      const preBN = r.readFoldedBN();
      const regularConv = r.readConv();
      const midBN = r.readFoldedBN();
      const finalConv = r.readConv();
      blocks.push({ kind: 0, preBN, regularConv, midBN, finalConv });
    } else if (kind === 2) {
      const preBN = r.readFoldedBN();
      const regularConv = r.readConv();
      const gpoolConv = r.readConv();
      const gpoolBN = r.readFoldedBN();
      const gpoolToBiasMul = r.readMatMul();
      const midBN = r.readFoldedBN();
      const finalConv = r.readConv();
      blocks.push({
        kind: 2,
        preBN,
        regularConv,
        gpoolConv,
        gpoolBN,
        gpoolToBiasMul,
        midBN,
        finalConv,
      });
    } else {
      throw new Error(`Unsupported KataGo trunk block kind: ${kind}`);
    }
  }

  const trunkTipBN = r.readFoldedBN();

  const p1Conv = r.readConv();
  const g1Conv = r.readConv();
  const g1BN = r.readFoldedBN();
  const gpoolToBiasMul = r.readMatMul();
  const p1BN = r.readFoldedBN();
  const p2Conv = r.readConv();
  const gpoolToPassMul = r.readMatMul();

  const v1Conv = r.readConv();
  const v1BN = r.readFoldedBN();
  const v2Mul = r.readMatMul();
  const v2Bias = r.readBias();
  const v2Activation = r.readU32() as KataGoActivationKind;
  const v3Mul = r.readMatMul();
  const v3Bias = r.readBias();
  const sv3Mul = r.readMatMul();
  const sv3Bias = r.readBias();
  const vOwnershipConv = r.readConv();

  const model: KataGoLoadedModel = {
    modelName,
    version,
    numInputChannels,
    numInputGlobalChannels,
    numBlocks,
    trunkChannels,
    midChannels,
    regularChannels,
    gpoolChannels,
    policyChannels,
    valueChannels,
    valueHiddenChannels,
    initialConv,
    initialMatMul,
    blocks,
    trunkTipBN,
    p1Conv,
    g1Conv,
    g1BN,
    gpoolToBiasMul,
    p1BN,
    p2Conv,
    gpoolToPassMul,
    v1Conv,
    v1BN,
    v2Mul,
    v2Bias,
    v2Activation,
    v3Mul,
    v3Bias,
    sv3Mul,
    sv3Bias,
    vOwnershipConv,
  };

  cachedModel = model;
  return model;
}

/**
 * Synchronously return the loaded KataGo model (or load from disk in Node.js / Vitest).
 * Returns `null` in browser environments if `ensureKataGoModelLoaded()` has not completed yet.
 */
export function getKataGoModelSync(): KataGoLoadedModel | null {
  if (cachedModel) return cachedModel;

  const { proc, fs, path } = getNodeBuiltins();
  if (!proc || !fs || !path || typeof proc.cwd !== 'function') {
    return null;
  }

  const cwd = proc.cwd();
  const candidates = [
    path.resolve(cwd, 'public', 'models', 'katago-b6c96.ktg'),
    path.resolve(cwd, 'dist', 'models', 'katago-b6c96.ktg'),
    path.resolve(cwd, 'models', 'katago-b6c96.ktg'),
  ];

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        const bytes = fs.readFileSync(filePath);
        return hydrateKataGoModelFromBytes(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      }
    } catch {
      // Try next candidate
    }
  }

  return null;
}

/**
 * Asynchronously ensure the KataGo model is loaded in Node.js, Web Worker, Browser, or Electron.
 */
export function ensureKataGoModelLoaded(): Promise<KataGoLoadedModel | null> {
  if (cachedModel) return Promise.resolve(cachedModel);
  const syncModel = getKataGoModelSync();
  if (syncModel) return Promise.resolve(syncModel);

  if (inFlightLoad) return inFlightLoad;

  inFlightLoad = (async () => {
    try {
      const candidateUrls: string[] = [];
      try {
        candidateUrls.push(new URL('../../../models/katago-b6c96.ktg', import.meta.url).href);
      } catch {
        // Ignore invalid URL relative resolution
      }
      try {
        candidateUrls.push(new URL('../models/katago-b6c96.ktg', import.meta.url).href);
      } catch {
        // Ignore invalid URL relative resolution
      }
      candidateUrls.push('./models/katago-b6c96.ktg', '/models/katago-b6c96.ktg');

      if (typeof fetch === 'function') {
        for (const url of candidateUrls) {
          try {
            const res = await fetch(url);
            if (!res.ok) continue;
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (bytes.length < 16) continue;
            if (isGzipped(bytes)) {
              const raw = await gunzipBrowser(bytes);
              return hydrateKataGoModelFromBytes(raw);
            }
            if (bytes[0] === 0x4b && bytes[1] === 0x54 && bytes[2] === 0x47 && bytes[3] === 0x4d) {
              return hydrateKataGoModelFromBytes(bytes);
            }
          } catch {
            // Try next URL
          }
        }
      }

      const api = (globalThis as { electronAPI?: { readKataGoWeights?: () => Promise<Uint8Array | ArrayBuffer | null> } }).electronAPI;
      if (api && typeof api.readKataGoWeights === 'function') {
        try {
          const data = await api.readKataGoWeights();
          if (data) {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            if (isGzipped(bytes)) {
              const raw = await gunzipBrowser(bytes);
              return hydrateKataGoModelFromBytes(raw);
            }
            return hydrateKataGoModelFromBytes(bytes);
          }
        } catch {
          // Ignore IPC read failure
        }
      }

      return null;
    } finally {
      inFlightLoad = null;
    }
  })();

  return inFlightLoad;
}
