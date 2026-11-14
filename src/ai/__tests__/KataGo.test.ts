import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { describe, it, expect, afterAll } from 'vitest';
import {
  getKataGoModelSync,
  hydrateKataGoModelFromBytes,
} from '../katago/KataGoWeights';
import {
  encodeKataGoV7Inputs,
  NUM_KATAGO_GLOBAL_FEATURES,
  NUM_KATAGO_SPATIAL_FEATURES,
  type KataGoInputPosition,
} from '../katago/KataGoFeatures';
import { evaluateKataGoPosition } from '../katago/KataGoNet';
import {
  encodeKataOmokInputs,
  evaluateKataOmokPosition,
  KATA_OMOK_GLOBAL_FEATURES,
  KATA_OMOK_INPUT_PLANES,
} from '../katago/KataOmokNet';
import { MctsEngine } from '../MctsEngine';
import { GomokuAI } from '../GomokuAI';
import { checkRenjuForbidden } from '../../rules/GomokuEngine';
import { BLACK, WHITE, EMPTY } from '../../rules/types';

const KTG_PATH = path.resolve(process.cwd(), 'public', 'models', 'katago-b6c96.ktg');
const VENDOR_KATAGO_DIR = path.resolve(process.cwd(), 'vendor', 'katago');
const VENDOR_KATAGO_EXE = path.join(VENDOR_KATAGO_DIR, 'katago.exe');
const VENDOR_KATAGO_MODEL = path.join(VENDOR_KATAGO_DIR, 'kata1-b6c96.txt.gz');
const VENDOR_KATAGO_CFG = path.join(VENDOR_KATAGO_DIR, 'analysis.cfg');
const HAS_NATIVE_KATAGO =
  fs.existsSync(VENDOR_KATAGO_EXE) &&
  fs.existsSync(VENDOR_KATAGO_MODEL) &&
  fs.existsSync(VENDOR_KATAGO_CFG);

const GO_LETTERS = 'ABCDEFGHJKLMNOPQRST';

function gtpToCoord(gtp: string, size: number): { x: number; y: number } | null {
  const trimmed = gtp.trim().toUpperCase();
  if (trimmed === 'PASS' || trimmed === 'RESIGN') return null;
  const x = GO_LETTERS.indexOf(trimmed[0]);
  const row = parseInt(trimmed.slice(1), 10);
  const y = size - row;
  if (x < 0 || x >= size || !Number.isInteger(row) || y < 0 || y >= size) return null;
  return { x, y };
}

function coordToGtp(coord: { x: number; y: number }, size: number): string {
  return `${GO_LETTERS[coord.x]}${size - coord.y}`;
}

interface NativeAnalysisResponse {
  id: string;
  rootInfo?: {
    winrate?: number;
    scoreLead?: number;
    currentPlayer?: string;
    visits?: number;
  };
  moveInfos?: Array<{
    move: string;
    prior?: number;
    winrate?: number;
    visits?: number;
  }>;
  policy?: number[];
  error?: string;
}

async function queryNativeKataGoOnce(query: Record<string, unknown>): Promise<NativeAnalysisResponse> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      VENDOR_KATAGO_EXE,
      [
        'analysis',
        '-model',
        VENDOR_KATAGO_MODEL,
        '-config',
        VENDOR_KATAGO_CFG,
        '-override-config',
        'nnRandomize=false,ignorePreRootHistory=false',
      ],
      {
        cwd: VENDOR_KATAGO_DIR,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    let buffer = '';
    let settled = false;
    const cleanup = () => {
      try {
        proc.stdin.end();
      } catch {
        // ignore
      }
      try {
        proc.kill();
      } catch {
        // ignore
      }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('Native KataGo parity query timed out'));
      }
    }, 20_000);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          try {
            const msg = JSON.parse(line) as NativeAnalysisResponse & {
              isDuringSearch?: boolean;
              warning?: string;
            };
            if (msg.id === query.id && !msg.isDuringSearch && !(msg.warning && !msg.moveInfos && !msg.error)) {
              settled = true;
              clearTimeout(timer);
              cleanup();
              resolve(msg);
              return;
            }
          } catch {
            // ignore non-json lines
          }
        }
        nl = buffer.indexOf('\n');
      }
    });

    proc.stderr.on('data', () => {
      // drain stderr
    });

    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(err);
      }
    });

    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Native KataGo exited early with code ${code}`));
      }
    });

    proc.stdin.write(`${JSON.stringify(query)}\n`);
  });
}

describe('KataGo & KataOmok Neural Engine Integration', () => {
  afterAll(() => {
    if (HAS_NATIVE_KATAGO) {
      const require = createRequire(import.meta.url);
      const bridge = require('../../../electron/katago-bridge.cjs') as {
        shutdownKataGo: () => void;
      };
      bridge.shutdownKataGo();
    }
  });

  it('loads official b6c96-s175395328-d26788732 and hydrates both gzipped .ktg and raw KTGM bytes', () => {
    const model = getKataGoModelSync();
    expect(model).not.toBeNull();
    expect(model!.modelName).toBe('b6c96-s175395328-d26788732');
    expect(model!.version).toBe(8);
    expect(model!.numBlocks).toBe(6);
    expect(model!.trunkChannels).toBe(96);

    const gzBytes = fs.readFileSync(KTG_PATH);
    expect(gzBytes[0]).toBe(0x1f);
    expect(gzBytes[1]).toBe(0x8b);

    const fromGz = hydrateKataGoModelFromBytes(new Uint8Array(gzBytes));
    expect(fromGz.modelName).toBe('b6c96-s175395328-d26788732');
    expect(fromGz.version).toBe(8);
    expect(fromGz.numBlocks).toBe(6);
    expect(fromGz.trunkChannels).toBe(96);

    const rawBytes = zlib.gunzipSync(gzBytes);
    expect(String.fromCharCode(rawBytes[0], rawBytes[1], rawBytes[2], rawBytes[3])).toBe('KTGM');
    const fromRaw = hydrateKataGoModelFromBytes(new Uint8Array(rawBytes));
    expect(fromRaw.modelName).toBe('b6c96-s175395328-d26788732');
    expect(fromRaw.version).toBe(8);
    expect(fromRaw.numBlocks).toBe(6);
    expect(fromRaw.trunkChannels).toBe(96);
  });

  it('encodes V7 inputs and evaluates 9x9 and 19x19 positions with valid masked policy, winrate, scoreLead, and ownership', () => {
    for (const size of [9, 19] as const) {
      const area = size * size;
      const board = new Uint8Array(area);
      board[2 * size + 2] = BLACK;
      board[2 * size + (size - 3)] = WHITE;
      board[(size - 3) * size + 2] = BLACK;

      const legalMask = new Uint8Array(area).fill(1);
      const maskedIdx = 0;
      legalMask[maskedIdx] = 0;

      const pos: KataGoInputPosition = {
        board,
        size,
        pla: WHITE,
        ruleset: size === 9 ? 'korean' : 'chinese',
        komi: size === 9 ? 6.5 : 7.5,
        koPoint: null,
        moveHistory: [
          { color: BLACK, coord: { x: 2, y: 2 } },
          { color: WHITE, coord: { x: size - 3, y: 2 } },
          { color: BLACK, coord: { x: 2, y: size - 3 } },
        ],
        lastMove: { x: 2, y: size - 3 },
        opponentPassed: false,
      };

      const { binInputs, globalInputs } = encodeKataGoV7Inputs(pos, 0);
      expect(binInputs.length).toBe(NUM_KATAGO_SPATIAL_FEATURES * area);
      expect(globalInputs.length).toBe(NUM_KATAGO_GLOBAL_FEATURES);

      const out = evaluateKataGoPosition(pos, legalMask, 0);
      expect(out).not.toBeNull();
      expect(out!.policyProbs.length).toBe(area + 1);

      let policySum = 0;
      for (let i = 0; i <= area; i++) {
        const p = out!.policyProbs[i];
        expect(Number.isFinite(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(0);
        policySum += p;
      }
      expect(policySum).toBeCloseTo(1.0, 4);

      expect(out!.policyProbs[2 * size + 2]).toBe(0);
      expect(out!.policyProbs[2 * size + (size - 3)]).toBe(0);
      expect(out!.policyProbs[(size - 3) * size + 2]).toBe(0);
      expect(out!.policyProbs[maskedIdx]).toBe(0);

      expect(Number.isFinite(out!.winrate)).toBe(true);
      expect(out!.winrate).toBeGreaterThanOrEqual(0);
      expect(out!.winrate).toBeLessThanOrEqual(1);
      expect(Number.isFinite(out!.scoreLead)).toBe(true);

      expect(out!.ownership.length).toBe(area);
      for (let i = 0; i < area; i++) {
        expect(Number.isFinite(out!.ownership[i])).toBe(true);
        expect(out!.ownership[i]).toBeGreaterThanOrEqual(-1);
        expect(out!.ownership[i]).toBeLessThanOrEqual(1);
      }
    }
  });

  it.runIf(HAS_NATIVE_KATAGO)(
    'matches vendor/katago/katago.exe analysis NN evaluation within tolerance',
    async () => {
      const size = 9;
      const area = size * size;
      const board = new Uint8Array(area);
      const history: Array<{ color: 1 | 2; coord: { x: number; y: number } }> = [
        { color: BLACK, coord: { x: 4, y: 4 } },
        { color: WHITE, coord: { x: 2, y: 2 } },
        { color: BLACK, coord: { x: 6, y: 6 } },
      ];
      for (const mv of history) {
        board[mv.coord.y * size + mv.coord.x] = mv.color;
      }

      const tsOut = evaluateKataGoPosition({
        board,
        size,
        pla: WHITE,
        ruleset: 'korean',
        komi: 6.5,
        koPoint: null,
        moveHistory: history,
        lastMove: history[history.length - 1].coord,
        opponentPassed: false,
      });
      expect(tsOut).not.toBeNull();

      const nativeRes = await queryNativeKataGoOnce({
        id: 'parity_9x9',
        boardXSize: size,
        boardYSize: size,
        rules: 'korean',
        komi: 6.5,
        initialPlayer: 'B',
        moves: history.map((m) => [m.color === BLACK ? 'B' : 'W', coordToGtp(m.coord, size)]),
        maxVisits: 1,
        includePolicy: true,
        overrideSettings: {
          nnRandomize: false,
          reportAnalysisWinratesAs: 'SIDETOMOVE',
        },
      });

      expect(nativeRes.error).toBeUndefined();
      expect(nativeRes.rootInfo?.winrate).toBeTypeOf('number');
      expect(Math.abs(tsOut!.winrate - nativeRes.rootInfo!.winrate!)).toBeLessThanOrEqual(0.05);

      const tsTop5 = Array.from({ length: area }, (_, idx) => ({ idx, p: tsOut!.policyProbs[idx] }))
        .sort((a, b) => b.p - a.p)
        .slice(0, 5)
        .map((e) => e.idx);

      let nativeTopIndices: number[] = [];
      if (Array.isArray(nativeRes.policy) && nativeRes.policy.length >= area) {
        nativeTopIndices = Array.from({ length: area }, (_, idx) => ({
          idx,
          p: nativeRes.policy![idx],
        }))
          .sort((a, b) => b.p - a.p)
          .slice(0, 5)
          .map((e) => e.idx);
      } else if (Array.isArray(nativeRes.moveInfos)) {
        nativeTopIndices = nativeRes.moveInfos
          .map((m) => gtpToCoord(m.move, size))
          .filter((c): c is { x: number; y: number } => c !== null)
          .slice(0, 5)
          .map((c) => c.y * size + c.x);
      }

      expect(nativeTopIndices.length).toBeGreaterThan(0);
      const overlap = tsTop5.filter((idx) => nativeTopIndices.includes(idx));
      expect(overlap.length).toBeGreaterThanOrEqual(3);
    },
    30_000
  );

  it('validates KataOmokNet policy/Renju-forbidden masking and MctsEngine/GomokuAI backend contracts', () => {
    const size = 15;
    const area = size * size;

    // 1) Renju 3-3 forbidden point at (7,7)
    const board33 = new Uint8Array(area);
    board33[7 * size + 5] = BLACK;
    board33[7 * size + 6] = BLACK;
    board33[5 * size + 7] = BLACK;
    board33[6 * size + 7] = BLACK;
    board33[1 * size + 1] = WHITE;
    board33[1 * size + 2] = WHITE;
    expect(checkRenjuForbidden(board33, size, 7, 7).reason).toBe('DOUBLE_THREE');

    const enc33 = encodeKataOmokInputs(board33, size, BLACK, 'renju', { x: 2, y: 1 });
    expect(enc33.binInputs.length).toBe(KATA_OMOK_INPUT_PLANES * area);
    expect(enc33.globalInputs.length).toBe(KATA_OMOK_GLOBAL_FEATURES);
    expect(enc33.forbiddenMask[7 * size + 7]).toBe(1);

    const eval33 = evaluateKataOmokPosition(board33, size, BLACK, 'renju', { x: 2, y: 1 });
    expect(eval33.policyProbs[7 * size + 7]).toBe(0);
    expect(eval33.policyProbs[7 * size + 5]).toBe(0);
    expect(eval33.policyProbs[1 * size + 1]).toBe(0);
    let sum33 = 0;
    for (let i = 0; i < area; i++) {
      expect(eval33.policyProbs[i]).toBeGreaterThanOrEqual(0);
      expect(eval33.ownership[i]).toBeGreaterThanOrEqual(-1);
      expect(eval33.ownership[i]).toBeLessThanOrEqual(1);
      sum33 += eval33.policyProbs[i];
    }
    expect(sum33).toBeCloseTo(1.0, 4);
    expect(eval33.winrate).toBeGreaterThanOrEqual(0);
    expect(eval33.winrate).toBeLessThanOrEqual(1);

    // 2) Renju 4-4 forbidden point at (7,7)
    const board44 = new Uint8Array(area);
    board44[7 * size + 5] = BLACK;
    board44[7 * size + 6] = BLACK;
    board44[7 * size + 8] = BLACK;
    board44[5 * size + 7] = BLACK;
    board44[6 * size + 7] = BLACK;
    board44[8 * size + 7] = BLACK;
    board44[0 * size + 0] = WHITE;
    expect(checkRenjuForbidden(board44, size, 7, 7).reason).toBe('DOUBLE_FOUR');
    const eval44 = evaluateKataOmokPosition(board44, size, BLACK, 'renju', { x: 0, y: 0 });
    expect(eval44.policyProbs[7 * size + 7]).toBe(0);

    // 3) Renju overline (6-in-a-row) forbidden point at (7,7)
    const boardOverline = new Uint8Array(area);
    boardOverline[7 * size + 4] = BLACK;
    boardOverline[7 * size + 5] = BLACK;
    boardOverline[7 * size + 6] = BLACK;
    boardOverline[7 * size + 8] = BLACK;
    boardOverline[7 * size + 9] = BLACK;
    boardOverline[0 * size + 0] = WHITE;
    expect(checkRenjuForbidden(boardOverline, size, 7, 7).reason).toBe('OVERLINE');
    const evalOverline = evaluateKataOmokPosition(boardOverline, size, BLACK, 'renju', { x: 0, y: 0 });
    expect(evalOverline.policyProbs[7 * size + 7]).toBe(0);

    // 4) Engine backend contracts
    const badukAi = new MctsEngine();
    const goBoard = new Uint8Array(9 * 9);
    goBoard[4 * 9 + 4] = BLACK;
    const goRes = badukAi.chooseMove({
      board: goBoard,
      size: 9,
      color: WHITE,
      ruleset: 'korean',
      komi: 6.5,
      koPoint: null,
      captures: { black: 0, white: 0 },
      lastMove: { x: 4, y: 4 },
      opponentPassed: false,
      moveCount: 1,
      positionHashes: [],
      difficulty: 3,
      gameType: 'baduk',
    });
    expect(goRes.engineBackend).toBe('katago-neural');
    expect(Number.isFinite(goRes.scoreLead)).toBe(true);

    const omokAi = new GomokuAI();
    const omokRes = omokAi.chooseMove({
      board: board33,
      size: 15,
      color: BLACK,
      ruleset: 'korean',
      komi: 0,
      koPoint: null,
      captures: { black: 0, white: 0 },
      lastMove: { x: 2, y: 1 },
      opponentPassed: false,
      moveCount: 6,
      positionHashes: [],
      difficulty: 3,
      gameType: 'omok',
      omokRuleset: 'renju',
    });
    expect(omokRes.engineBackend).toBe('katago-omok-puct');
    expect(omokRes.coord).not.toEqual({ x: 7, y: 7 });
    expect(omokRes.coord).not.toBeNull();
  });

  it.runIf(HAS_NATIVE_KATAGO)(
    'integrates electron/katago-bridge.cjs on 9x9 Korean & 19x19 Chinese rules and shuts down cleanly',
    async () => {
      const require = createRequire(import.meta.url);
      const bridge = require('../../../electron/katago-bridge.cjs') as {
        getKataGoStatus: () => { nativeAvailable: boolean; modelName: string };
        analyzeBadukMove: (payload: Record<string, unknown>) => Promise<{
          available: boolean;
          result?: {
            coord: { x: number; y: number } | null;
            winrate: number;
            simulations: number;
            elapsedMs: number;
            topSuggestions?: Array<{ coord: { x: number; y: number }; winrate: number; visits: number }>;
            engineBackend?: string;
            scoreLead?: number;
          };
        }>;
        readBundledWebWeights: () => Promise<Uint8Array | null>;
        shutdownKataGo: () => void;
      };

      try {
        const status = bridge.getKataGoStatus();
        expect(status.nativeAvailable).toBe(true);
        expect(status.modelName).toContain('KataGo');

        // 9x9 Korean rules with dominant White group to check side-to-move winrate orientation
        const board9 = new Uint8Array(9 * 9);
        const initialStones9 = [
          { color: WHITE, coord: { x: 2, y: 2 } },
          { color: WHITE, coord: { x: 6, y: 2 } },
          { color: WHITE, coord: { x: 2, y: 6 } },
          { color: WHITE, coord: { x: 6, y: 6 } },
          { color: WHITE, coord: { x: 4, y: 4 } },
          { color: WHITE, coord: { x: 4, y: 2 } },
          { color: BLACK, coord: { x: 0, y: 0 } },
        ];
        for (const st of initialStones9) {
          board9[st.coord.y * 9 + st.coord.x] = st.color;
        }

        const resWhite = await bridge.analyzeBadukMove({
          gameType: 'baduk',
          board: board9,
          size: 9,
          color: WHITE,
          ruleset: 'korean',
          komi: 6.5,
          koPoint: null,
          difficulty: 4,
          initialStones: initialStones9,
        });
        expect(resWhite.available).toBe(true);
        expect(resWhite.result?.engineBackend).toBe('katago-native');
        expect(resWhite.result?.topSuggestions?.length).toBeGreaterThan(0);
        expect(resWhite.result!.winrate).toBeGreaterThan(0.8);

        const resBlack = await bridge.analyzeBadukMove({
          gameType: 'baduk',
          board: board9,
          size: 9,
          color: BLACK,
          ruleset: 'korean',
          komi: 6.5,
          koPoint: null,
          difficulty: 4,
          initialStones: initialStones9,
        });
        expect(resBlack.available).toBe(true);
        expect(resBlack.result?.engineBackend).toBe('katago-native');
        expect(resBlack.result!.winrate).toBeLessThan(0.2);

        // 19x19 Chinese rules
        const board19 = new Uint8Array(19 * 19);
        board19[3 * 19 + 15] = BLACK;
        const res19 = await bridge.analyzeBadukMove({
          gameType: 'baduk',
          board: board19,
          size: 19,
          color: WHITE,
          ruleset: 'chinese',
          komi: 7.5,
          koPoint: null,
          difficulty: 4,
          moveHistory: [{ color: BLACK, coord: { x: 15, y: 3 } }],
        });
        expect(res19.available).toBe(true);
        expect(res19.result?.engineBackend).toBe('katago-native');
        expect(res19.result?.coord).not.toBeNull();
        expect(res19.result?.topSuggestions?.length).toBeGreaterThan(0);
        expect(board19[res19.result!.coord!.y * 19 + res19.result!.coord!.x]).toBe(EMPTY);

        const webWeights = await bridge.readBundledWebWeights();
        expect(webWeights).not.toBeNull();
        expect(webWeights!.length).toBeGreaterThan(1_000_000);
      } finally {
        bridge.shutdownKataGo();
      }
    },
    30_000
  );
});
