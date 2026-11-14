import {
  BLACK,
  WHITE,
  BoardSize,
  Coord,
  GameConfig,
  GameType,
  OmokRulesetType,
  PlayerColor,
  RulesetType,
} from './types';
import { GoEngine } from './GoEngine';
import { GomokuEngine } from './GomokuEngine';

function coordToSgf(coord: Coord | null): string {
  if (!coord) return '';
  const a = String.fromCharCode(97 + coord.x);
  const b = String.fromCharCode(97 + coord.y);
  return `${a}${b}`;
}

function sgfToCoord(token: string, size: BoardSize): Coord | null {
  const clean = token.trim();
  if (clean.length === 0 || (clean === 'tt' && size <= 19)) {
    return null; // Pass
  }
  if (clean.length < 2) return null;
  const x = clean.charCodeAt(0) - 97;
  const y = clean.charCodeAt(1) - 97;
  if (x < 0 || x >= size || y < 0 || y >= size) return null;
  return { x, y };
}

function escapeSgfText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

export function exportToSgf(engine: GoEngine | GomokuEngine): string {
  const cfg = engine.config;
  const isOmok = cfg.gameType === 'omok' || engine instanceof GomokuEngine;
  const dateStr = new Date().toISOString().slice(0, 10);
  const gm = isOmok ? 4 : 1;
  const ru = isOmok
    ? (cfg.omokRuleset ?? 'renju') === 'freestyle'
      ? 'Freestyle'
      : 'Renju'
    : cfg.ruleset === 'korean'
      ? 'Korean'
      : 'Chinese';
  const pb = escapeSgfText(
    cfg.blackName || (cfg.mode === 'ai' && cfg.humanColor === WHITE ? `AI (Lv.${cfg.aiDifficulty})` : '흑 대국자')
  );
  const pw = escapeSgfText(
    cfg.whiteName || (cfg.mode === 'ai' && cfg.humanColor === BLACK ? `AI (Lv.${cfg.aiDifficulty})` : '백 대국자')
  );

  let re = '';
  if (engine.result) {
    if (engine.result.winner === 'draw') {
      re = 'RE[0]';
    } else {
      const w = engine.result.winner === BLACK ? 'B' : 'W';
      if (engine.result.reason === 'resign') re = `RE[${w}+R]`;
      else if (engine.result.reason === 'timeout') re = `RE[${w}+T]`;
      else if (engine.result.reason === 'five_in_row') re = `RE[${w}+5]`;
      else re = `RE[${w}+${engine.result.margin ?? 0}]`;
    }
  }

  let header = `(;FF[4]GM[${gm}]CA[UTF-8]AP[Sudam3DBaduk:2.0]SZ[${engine.size}]KM[${isOmok ? 0 : cfg.komi}]RU[${ru}]DT[${dateStr}]PB[${pb}]PW[${pw}]`;
  if (re) header += re;

  if (!isOmok && engine instanceof GoEngine && engine.handicapStones.length >= 2) {
    header += `HA[${engine.handicapStones.length}]AB`;
    for (const pt of engine.handicapStones) {
      header += `[${coordToSgf(pt)}]`;
    }
  }

  let body = '';
  for (const move of engine.history) {
    const tag = move.color === BLACK ? 'B' : 'W';
    body += `;${tag}[${coordToSgf(move.coord)}]`;
  }

  return `${header}${body})\n`;
}

export interface ParsedSgfGame {
  gameType: GameType;
  omokRuleset: OmokRulesetType;
  boardSize: BoardSize;
  komi: number;
  ruleset: RulesetType;
  handicap: number;
  setupBlack: Coord[];
  setupWhite: Coord[];
  moves: Array<{ color: PlayerColor; coord: Coord | null }>;
  blackName?: string;
  whiteName?: string;
  resultText?: string;
}

export function parseSgf(sgfContent: string): ParsedSgfGame {
  // Tokenize SGF properties along the main variation (first branch if variations exist)
  let gameType: GameType = 'baduk';
  let omokRuleset: OmokRulesetType = 'renju';
  let boardSize: BoardSize = 19;
  let komi = 6.5;
  let ruleset: RulesetType = 'korean';
  let handicap = 0;
  const setupBlack: Coord[] = [];
  const setupWhite: Coord[] = [];
  const moves: Array<{ color: PlayerColor; coord: Coord | null }> = [];
  let blackName: string | undefined;
  let whiteName: string | undefined;
  let resultText: string | undefined;

  // Strip nested side-variations while keeping the main trunk
  let mainLine = '';
  let depth = 0;
  let inBracket = false;
  let escaped = false;
  // Keep depth === 1 (primary game tree) and stop if a sibling variation starts after depth 1 closes,
  // or skip nested sub-variations (depth > 1) after first child
  let closedAtDepth1 = false;
  const branchTakenAtDepth = new Map<number, boolean>();

  for (let i = 0; i < sgfContent.length; i++) {
    const ch = sgfContent[i];
    if (inBracket) {
      if (depth === 1) mainLine += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === ']') {
        inBracket = false;
      }
      continue;
    }

    if (ch === '[') {
      inBracket = true;
      if (depth === 1) mainLine += ch;
    } else if (ch === '(') {
      const parentDepth = depth;
      if (parentDepth === 0) {
        if (closedAtDepth1) break;
        depth = 1;
      } else {
        if (!branchTakenAtDepth.get(parentDepth)) {
          branchTakenAtDepth.set(parentDepth, true);
          // Inline first branch into main trunk
          depth = 1;
        } else {
          depth = parentDepth + 1;
        }
      }
    } else if (ch === ')') {
      if (depth === 1) {
        closedAtDepth1 = true;
        depth = 0;
      } else if (depth > 1) {
        depth--;
      }
    } else {
      if (depth === 1) mainLine += ch;
    }
  }

  const source = mainLine.length > 0 ? mainLine : sgfContent;
  const nodeStrings = source.split(';').slice(1);

  const propRegex = /([A-Z]+)((?:\[(?:\\.|[^\]])*\])+)/g;
  const valRegex = /\[((?:\\.|[^\]])*)\]/g;

  nodeStrings.forEach((nodeStr, nodeIdx) => {
    propRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = propRegex.exec(nodeStr)) !== null) {
      const key = match[1];
      const rawVals = match[2];
      const values: string[] = [];
      valRegex.lastIndex = 0;
      let vMatch: RegExpExecArray | null;
      while ((vMatch = valRegex.exec(rawVals)) !== null) {
        values.push(vMatch[1].replace(/\\(.)/g, '$1'));
      }

      if (nodeIdx === 0) {
        if (key === 'GM' && values[0]) {
          const gm = parseInt(values[0], 10);
          if (gm === 4 || gm === 5) gameType = 'omok';
        } else if (key === 'SZ' && values[0]) {
          const sz = parseInt(values[0], 10);
          if (sz === 9 || sz === 13 || sz === 15 || sz === 19) {
            boardSize = sz;
            if (sz === 15) gameType = 'omok';
          }
        } else if (key === 'KM' && values[0]) {
          const km = parseFloat(values[0]);
          if (!Number.isNaN(km)) komi = km;
        } else if (key === 'RU' && values[0]) {
          if (/freestyle|gomoku/i.test(values[0])) {
            omokRuleset = 'freestyle';
            gameType = 'omok';
          } else if (/renju/i.test(values[0])) {
            omokRuleset = 'renju';
            gameType = 'omok';
          } else if (/chinese|area|aga/i.test(values[0])) {
            ruleset = 'chinese';
          } else {
            ruleset = 'korean';
          }
        } else if (key === 'HA' && values[0]) {
          const ha = parseInt(values[0], 10);
          if (!Number.isNaN(ha)) handicap = ha;
        } else if (key === 'PB' && values[0]) {
          blackName = values[0];
        } else if (key === 'PW' && values[0]) {
          whiteName = values[0];
        } else if (key === 'RE' && values[0]) {
          resultText = values[0];
        }
      }

      if (key === 'AB') {
        for (const v of values) {
          const pt = sgfToCoord(v, boardSize);
          if (pt) setupBlack.push(pt);
        }
      } else if (key === 'AW') {
        for (const v of values) {
          const pt = sgfToCoord(v, boardSize);
          if (pt) setupWhite.push(pt);
        }
      } else if (key === 'B' && values.length > 0) {
        moves.push({ color: BLACK, coord: sgfToCoord(values[0], boardSize) });
      } else if (key === 'W' && values.length > 0) {
        moves.push({ color: WHITE, coord: sgfToCoord(values[0], boardSize) });
      }
    }
  });

  return {
    gameType,
    omokRuleset,
    boardSize,
    komi,
    ruleset,
    handicap,
    setupBlack,
    setupWhite,
    moves,
    blackName,
    whiteName,
    resultText,
  };
}
