const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawn } = require('child_process');

let electronApp = null;
try {
  electronApp = require('electron').app || null;
} catch {
  electronApp = null;
}

const GO_LETTERS = 'ABCDEFGHJKLMNOPQRST';
const MODEL_DISPLAY_NAME = 'KataGo v1.18 Native Eigen (b6c96)';
const DEFAULT_QUERY_TIMEOUT_MS = 18000;

const DIFFICULTY_SETTINGS = {
  1: { maxVisits: 2, rootPolicyTemperature: 2.4, wideRootNoise: 0.20 },
  2: { maxVisits: 5, rootPolicyTemperature: 1.75, wideRootNoise: 0.12 },
  3: { maxVisits: 12, rootPolicyTemperature: 1.35, wideRootNoise: 0.06 },
  4: { maxVisits: 80, rootPolicyTemperature: 1.0, wideRootNoise: 0.0 },
  5: { maxVisits: 220, rootPolicyTemperature: 1.0, wideRootNoise: 0.0 },
};

let katagoProc = null;
let stdoutBuffer = '';
let queryCounter = 0;
let activeQueryId = null;
let permanentUnavailable = false;
const pendingQueries = new Map();

function coordToGtp(coord, size) {
  if (!coord) return 'pass';
  const col = GO_LETTERS[coord.x];
  if (!col) return 'pass';
  const row = size - coord.y;
  return `${col}${row}`;
}

function gtpToCoord(gtp, size) {
  if (!gtp || typeof gtp !== 'string') return null;
  const trimmed = gtp.trim().toUpperCase();
  if (trimmed === 'PASS' || trimmed === 'RESIGN') return null;
  const x = GO_LETTERS.indexOf(trimmed[0]);
  const row = parseInt(trimmed.slice(1), 10);
  const y = size - row;
  if (x < 0 || x >= size || !Number.isInteger(row) || y < 0 || y >= size) {
    return null;
  }
  return { x, y };
}

function resolveKataGoPaths() {
  const candidates = [];
  if (electronApp && electronApp.isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'katago'));
  }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'katago'));
  }
  candidates.push(path.join(__dirname, '../vendor/katago'));
  candidates.push(path.join(process.cwd(), 'vendor', 'katago'));

  for (const dir of candidates) {
    if (!dir) continue;
    const exePath = path.join(dir, 'katago.exe');
    const modelPath = path.join(dir, 'kata1-b6c96.txt.gz');
    const configPath = path.join(dir, 'analysis.cfg');
    if (
      fsSync.existsSync(exePath) &&
      fsSync.existsSync(modelPath) &&
      fsSync.existsSync(configPath)
    ) {
      return { dir, exePath, modelPath, configPath };
    }
  }
  return null;
}

function getKataGoStatus() {
  const paths = resolveKataGoPaths();
  return {
    nativeAvailable: Boolean(paths) && !permanentUnavailable,
    modelName: MODEL_DISPLAY_NAME,
  };
}

function settlePending(id, value) {
  const entry = pendingQueries.get(id);
  if (!entry) return;
  pendingQueries.delete(id);
  if (entry.timer) clearTimeout(entry.timer);
  if (activeQueryId === id) activeQueryId = null;
  entry.resolve(value);
}

function failAllPending(reason) {
  for (const id of Array.from(pendingQueries.keys())) {
    settlePending(id, { available: false, reason });
  }
}

function handleStdoutLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  const id = msg.id;
  if (!id || !pendingQueries.has(id)) return;
  // Ignore intermediate progress reports or field warnings
  if (msg.isDuringSearch) return;
  if (msg.warning && !msg.moveInfos && !msg.error) return;
  settlePending(id, { available: true, raw: msg });
}

function ensureKataGoProcess() {
  if (permanentUnavailable) return null;
  if (katagoProc && !katagoProc.killed && katagoProc.exitCode === null) {
    return katagoProc;
  }

  const paths = resolveKataGoPaths();
  if (!paths) return null;

  try {
    stdoutBuffer = '';
    const proc = spawn(
      paths.exePath,
      ['analysis', '-model', paths.modelPath, '-config', paths.configPath],
      {
        cwd: paths.dir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let nlIdx = stdoutBuffer.indexOf('\n');
      while (nlIdx !== -1) {
        const line = stdoutBuffer.slice(0, nlIdx);
        stdoutBuffer = stdoutBuffer.slice(nlIdx + 1);
        handleStdoutLine(line);
        nlIdx = stdoutBuffer.indexOf('\n');
      }
    });

    proc.stderr.on('data', () => {
      // Drain stderr to prevent pipe backpressure stalls
    });

    proc.on('error', () => {
      if (katagoProc === proc) katagoProc = null;
      failAllPending('process-error');
    });

    proc.on('exit', () => {
      if (katagoProc === proc) katagoProc = null;
      failAllPending('process-exit');
    });

    katagoProc = proc;
    return proc;
  } catch {
    permanentUnavailable = true;
    return null;
  }
}

function sendTerminate(id) {
  if (!id || !katagoProc || katagoProc.killed || katagoProc.exitCode !== null) return;
  try {
    katagoProc.stdin.write(`${JSON.stringify({ id, action: 'terminate' })}\n`);
  } catch {
    // Ignore pipe errors during cancellation
  }
}

function cancelActiveAnalysis() {
  if (activeQueryId) {
    const id = activeQueryId;
    sendTerminate(id);
    settlePending(id, { available: false, canceled: true });
  }
}

function shutdownKataGo() {
  failAllPending('shutdown');
  if (katagoProc) {
    const proc = katagoProc;
    katagoProc = null;
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
  }
}

function isLegalBoardMove(board, size, koPoint, coord) {
  if (!coord) return true; // pass
  if (coord.x < 0 || coord.x >= size || coord.y < 0 || coord.y >= size) return false;
  if (board[coord.y * size + coord.x] !== 0) return false;
  if (koPoint && koPoint.x === coord.x && koPoint.y === coord.y) return false;
  return true;
}

function sampleWeighted(items) {
  if (items.length === 0) return null;
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += Math.max(0, items[i].weight);
  }
  if (total <= 0) return items[0];
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, items[i].weight);
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function selectSoftenedCasualMove(raw, board, size, koPoint, difficulty) {
  const moveInfos = Array.isArray(raw.moveInfos) ? raw.moveInfos : [];
  const policy = Array.isArray(raw.policy) ? raw.policy : null;

  // Respect pass when KataGo's best move is pass
  if (moveInfos.length > 0 && String(moveInfos[0].move).toUpperCase() === 'PASS') {
    return null;
  }

  // Build candidate pool from legal board moves in moveInfos + top policy moves
  const seen = new Set();
  const candidates = [];

  for (let i = 0; i < moveInfos.length; i++) {
    const info = moveInfos[i];
    const coord = gtpToCoord(info.move, size);
    if (!coord || !isLegalBoardMove(board, size, koPoint, coord)) continue;
    const idx = coord.y * size + coord.x;
    if (seen.has(idx)) continue;
    seen.add(idx);
    candidates.push({
      coord,
      prior: Number(info.prior) || 0.01,
      visits: Number(info.visits) || 1,
      winrate: typeof info.winrate === 'number' ? info.winrate : 0.5,
      rank: i,
    });
  }

  if (policy && policy.length >= size * size) {
    const policyEntries = [];
    for (let idx = 0; idx < size * size; idx++) {
      const p = policy[idx];
      if (!(p > 0)) continue;
      const x = idx % size;
      const y = (idx - x) / size;
      if (!isLegalBoardMove(board, size, koPoint, { x, y })) continue;
      policyEntries.push({ idx, x, y, p });
    }
    policyEntries.sort((a, b) => b.p - a.p);
    const limit = difficulty === 1 ? 18 : difficulty === 2 ? 12 : 8;
    for (let i = 0; i < Math.min(limit, policyEntries.length); i++) {
      const e = policyEntries[i];
      if (seen.has(e.idx)) continue;
      seen.add(e.idx);
      candidates.push({
        coord: { x: e.x, y: e.y },
        prior: e.p,
        visits: 0,
        winrate: 0.5,
        rank: candidates.length,
      });
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].coord;

  // Calibrated softening so native Lv.1-Lv.3 remain approachable for casual players
  if (difficulty === 1) {
    const pool = candidates.slice(0, Math.min(16, candidates.length));
    const weighted = pool.map((c, idx) => ({
      coord: c.coord,
      weight: Math.pow(Math.max(0.005, c.prior), 0.45) + (idx >= 2 ? 0.08 : 0.02),
    }));
    return sampleWeighted(weighted)?.coord ?? candidates[0].coord;
  }

  if (difficulty === 2) {
    const pool = candidates.slice(0, Math.min(10, candidates.length));
    // 30% chance to pick a secondary move (ranks 2..8)
    if (pool.length >= 3 && Math.random() < 0.30) {
      const sub = pool.slice(2, Math.min(8, pool.length));
      const weighted = sub.map((c) => ({
        coord: c.coord,
        weight: Math.pow(Math.max(0.005, c.prior), 0.7) + 0.03,
      }));
      return sampleWeighted(weighted)?.coord ?? pool[0].coord;
    }
    const weighted = pool.map((c) => ({
      coord: c.coord,
      weight: Math.pow(Math.max(0.005, c.prior), 0.75) + c.visits * 0.04,
    }));
    return sampleWeighted(weighted)?.coord ?? pool[0].coord;
  }

  // Lv.3: natural shapes, ~24% chance to take rank 1..5 secondary move
  const pool = candidates.slice(0, Math.min(7, candidates.length));
  if (pool.length >= 3 && Math.random() < 0.24) {
    const sub = pool.slice(1, Math.min(6, pool.length));
    const weighted = sub.map((c) => ({
      coord: c.coord,
      weight: Math.pow(Math.max(0.005, c.prior), 0.9) + c.visits * 0.08,
    }));
    return sampleWeighted(weighted)?.coord ?? pool[0].coord;
  }
  const weighted = pool.slice(0, 4).map((c) => ({
    coord: c.coord,
    weight: Math.pow(Math.max(0.005, c.prior), 1.0) + c.visits * 0.15,
  }));
  return sampleWeighted(weighted)?.coord ?? pool[0].coord;
}

function buildKataGoQuery(id, reqPayload) {
  const size = Number(reqPayload.size) || 19;
  const color = reqPayload.color === 2 ? 2 : 1;
  const board = reqPayload.board || [];
  const ruleset = reqPayload.ruleset === 'chinese' ? 'chinese' : 'korean';
  const komi = Number.isFinite(Number(reqPayload.komi)) ? Number(reqPayload.komi) : 6.5;
  const difficulty = Math.min(5, Math.max(1, Number(reqPayload.difficulty) || 3));
  const isHint = Boolean(reqPayload.includeHints);
  const effectiveDiff = isHint ? Math.max(4, difficulty) : difficulty;
  const profile = DIFFICULTY_SETTINGS[effectiveDiff] || DIFFICULTY_SETTINGS[3];

  const initialStones = [];
  const moves = [];
  let initialPlayer = color === 1 ? 'B' : 'W';

  const hasHistory = Array.isArray(reqPayload.moveHistory) && reqPayload.moveHistory.length > 0;
  const hasExplicitInitialStones =
    Array.isArray(reqPayload.initialStones) && reqPayload.initialStones.length > 0;

  if (hasHistory) {
    if (hasExplicitInitialStones) {
      for (const st of reqPayload.initialStones) {
        if (st && st.coord) {
          initialStones.push([st.color === 2 ? 'W' : 'B', coordToGtp(st.coord, size)]);
        }
      }
    }
    for (const mv of reqPayload.moveHistory) {
      moves.push([mv.color === 2 ? 'W' : 'B', coordToGtp(mv.coord, size)]);
    }
    initialPlayer = reqPayload.moveHistory[0].color === 2 ? 'W' : 'B';
  } else if (hasExplicitInitialStones) {
    for (const st of reqPayload.initialStones) {
      if (st && st.coord) {
        initialStones.push([st.color === 2 ? 'W' : 'B', coordToGtp(st.coord, size)]);
      }
    }
    initialPlayer = color === 1 ? 'B' : 'W';
  } else {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = board[y * size + x];
        if (v === 1) initialStones.push(['B', coordToGtp({ x, y }, size)]);
        else if (v === 2) initialStones.push(['W', coordToGtp({ x, y }, size)]);
      }
    }
    initialPlayer = color === 1 ? 'B' : 'W';
  }

  const query = {
    id,
    boardXSize: size,
    boardYSize: size,
    rules: ruleset,
    komi,
    initialPlayer,
    moves,
    maxVisits: profile.maxVisits,
    rootPolicyTemperature: profile.rootPolicyTemperature,
    includePolicy: !isHint && effectiveDiff <= 3,
    overrideSettings: {
      reportAnalysisWinratesAs: 'SIDETOMOVE',
      wideRootNoise: profile.wideRootNoise,
    },
  };

  if (initialStones.length > 0) {
    query.initialStones = initialStones;
  }

  return { query, effectiveDiff, isHint };
}

async function analyzeBadukMove(reqPayload) {
  if (!reqPayload || reqPayload.gameType === 'omok') {
    return { available: false };
  }

  const proc = ensureKataGoProcess();
  if (!proc) {
    return { available: false };
  }

  // Cancel any stale active query before issuing a new one
  if (activeQueryId) {
    cancelActiveAnalysis();
  }

  const size = Number(reqPayload.size) || 19;
  const board = reqPayload.board || [];
  const koPoint = reqPayload.koPoint || null;
  const id = `ktg_${++queryCounter}`;
  const { query, effectiveDiff, isHint } = buildKataGoQuery(id, reqPayload);
  const startTime = Date.now();

  const rawResult = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      sendTerminate(id);
      settlePending(id, { available: false, reason: 'timeout' });
    }, DEFAULT_QUERY_TIMEOUT_MS);

    activeQueryId = id;
    pendingQueries.set(id, { resolve, timer });

    try {
      proc.stdin.write(`${JSON.stringify(query)}\n`);
    } catch {
      settlePending(id, { available: false, reason: 'write-failed' });
    }
  });

  if (!rawResult || !rawResult.available || !rawResult.raw) {
    return { available: false };
  }

  const raw = rawResult.raw;
  if (raw.error) {
    return { available: false };
  }

  const rootInfo = raw.rootInfo || {};
  const moveInfos = Array.isArray(raw.moveInfos) ? raw.moveInfos : [];

  const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
  const winrate = clamp01(typeof rootInfo.winrate === 'number' ? rootInfo.winrate : 0.5);
  const scoreLead = typeof rootInfo.scoreLead === 'number' ? rootInfo.scoreLead : undefined;
  const totalSimulations =
    typeof rootInfo.visits === 'number'
      ? rootInfo.visits
      : moveInfos.reduce((acc, m) => acc + (Number(m.visits) || 0), 0);

  let chosenCoord = null;
  if (!isHint && effectiveDiff <= 3) {
    chosenCoord = selectSoftenedCasualMove(raw, board, size, koPoint, effectiveDiff);
  } else if (moveInfos.length > 0) {
    for (const info of moveInfos) {
      const c = gtpToCoord(info.move, size);
      if (c === null) {
        chosenCoord = null;
        break;
      }
      if (isLegalBoardMove(board, size, koPoint, c)) {
        chosenCoord = c;
        break;
      }
    }
  }

  const topSuggestions = [];
  for (const info of moveInfos) {
    if (topSuggestions.length >= 3) break;
    const c = gtpToCoord(info.move, size);
    if (!c || !isLegalBoardMove(board, size, koPoint, c)) continue;
    topSuggestions.push({
      coord: c,
      winrate: clamp01(typeof info.winrate === 'number' ? info.winrate : winrate),
      visits: Number(info.visits) || 0,
    });
  }

  return {
    available: true,
    result: {
      coord: chosenCoord,
      winrate,
      simulations: Math.max(1, totalSimulations),
      elapsedMs: Math.max(1, Date.now() - startTime),
      topSuggestions: topSuggestions.length > 0 ? topSuggestions : undefined,
      engineBackend: 'katago-native',
      scoreLead,
    },
  };
}

async function readBundledWebWeights(extraCandidatePaths = []) {
  const candidates = [
    ...extraCandidatePaths,
    path.join(__dirname, '../dist/models/katago-b6c96.ktg'),
    path.join(__dirname, '../public/models/katago-b6c96.ktg'),
    path.join(process.cwd(), 'dist', 'models', 'katago-b6c96.ktg'),
    path.join(process.cwd(), 'public', 'models', 'katago-b6c96.ktg'),
  ];

  for (const filePath of candidates) {
    if (!filePath) continue;
    try {
      const buf = await fs.readFile(filePath);
      if (buf && buf.length > 0) {
        return new Uint8Array(buf);
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

module.exports = {
  coordToGtp,
  gtpToCoord,
  getKataGoStatus,
  analyzeBadukMove,
  cancelActiveAnalysis,
  readBundledWebWeights,
  shutdownKataGo,
};
