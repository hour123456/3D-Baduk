export type StoneColor = 0 | 1 | 2; // 0: Empty, 1: Black (흑), 2: White (백)
export type PlayerColor = 1 | 2;

export const EMPTY = 0 as const;
export const BLACK = 1 as const;
export const WHITE = 2 as const;

export function opponentColor(color: PlayerColor): PlayerColor {
  return color === BLACK ? WHITE : BLACK;
}

export type BoardSize = 9 | 13 | 19;
export type RulesetType = 'korean' | 'chinese';
export type AIDifficulty = 1 | 2 | 3 | 4 | 5;
export type GamePhase = 'setup' | 'playing' | 'scoring' | 'finished' | 'review';

export type IllegalMoveReason =
  | 'GAME_NOT_ACTIVE'
  | 'OUT_OF_BOUNDS'
  | 'OCCUPIED'
  | 'SUICIDE'
  | 'KO'
  | 'SUPERKO';

export interface Coord {
  x: number;
  y: number;
}

export interface GameConfig {
  boardSize: BoardSize;
  ruleset: RulesetType;
  handicap: number; // 0 or 2..9
  komi: number;
  superko: boolean; // Enforce positional superko
  mode: 'ai' | 'local2p' | 'online';
  humanColor: PlayerColor;
  aiDifficulty: AIDifficulty;
  mainTimeSeconds: number; // 0 = unlimited
  byoyomiSeconds: number;
  byoyomiPeriods: number;
  blackName?: string;
  whiteName?: string;
  roomCode?: string;
}

export interface MoveRecord {
  moveNumber: number; // 1-indexed
  color: PlayerColor;
  coord: Coord | null; // null = PASS (한수쉼)
  captured: Coord[];
  koPointAfter: Coord | null;
  boardBefore: Uint8Array;
  boardAfter: Uint8Array;
  capturesAfter: { black: number; white: number }; // stones captured BY black / BY white
  hashAfter: bigint;
  consecutivePasses: number;
  timestamp: number;
}

export interface MoveValidation {
  valid: boolean;
  reason?: IllegalMoveReason;
  capturedCoords?: Coord[];
  resultingBoard?: Uint8Array;
  resultingHash?: bigint;
  nextKoPoint?: Coord | null;
  adjacentOpponentCount?: number;
  adjacentTotalCount?: number;
}

export type WinReason = 'score' | 'resign' | 'timeout';

export interface ScoreBreakdown {
  ruleset: RulesetType;
  komi: number;
  blackTerritory: number;
  whiteTerritory: number;
  blackAliveStones: number;
  whiteAliveStones: number;
  blackCapturesDuringPlay: number;
  whiteCapturesDuringPlay: number;
  deadBlackStones: number;
  deadWhiteStones: number;
  dameCount: number;
  blackTotal: number;
  whiteTotal: number;
  winner: PlayerColor | 'draw';
  margin: number;
  territoryMap: Int8Array;
  deadStoneMask: Uint8Array;
}

export interface GameResult {
  winner: PlayerColor | 'draw';
  reason: WinReason;
  margin?: number;
  scoreBreakdown?: ScoreBreakdown;
  summaryText: string;
}

declare global {
  interface Window {
    electronAPI?: {
      isElectron: boolean;
      saveSgf: (content: string, defaultName?: string) => Promise<{ canceled: boolean; filePath?: string }>;
      openSgf: () => Promise<{ canceled: boolean; content?: string; fileName?: string }>;
      toggleFullscreen: () => Promise<boolean>;
    };
  }
}