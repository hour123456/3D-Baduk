export type StoneColor = 0 | 1 | 2; // 0: Empty, 1: Black (흑), 2: White (백)
export type PlayerColor = 1 | 2;

export const EMPTY = 0 as const;
export const BLACK = 1 as const;
export const WHITE = 2 as const;

export function opponentColor(color: PlayerColor): PlayerColor {
  return color === BLACK ? WHITE : BLACK;
}

export type GameType = 'baduk' | 'omok';
export type OmokRulesetType = 'renju' | 'freestyle';
export type BoardSize = 9 | 13 | 15 | 19;
export type RulesetType = 'korean' | 'chinese';
export type AIDifficulty = 1 | 2 | 3 | 4 | 5;
export type GamePhase = 'setup' | 'playing' | 'scoring' | 'finished' | 'review';

export type IllegalMoveReason =
  | 'GAME_NOT_ACTIVE'
  | 'OUT_OF_BOUNDS'
  | 'OCCUPIED'
  | 'SUICIDE'
  | 'KO'
  | 'SUPERKO'
  | 'DOUBLE_THREE'
  | 'DOUBLE_FOUR'
  | 'OVERLINE';

export interface Coord {
  x: number;
  y: number;
}

export interface GameConfig {
  gameType?: GameType;
  omokRuleset?: OmokRulesetType;
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
  winrateAfter?: number;
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

export type WinReason = 'score' | 'resign' | 'timeout' | 'five_in_row' | 'draw';

export interface ScoreBreakdown {
  ruleset: RulesetType;
  komi: number;
  // Territory intersections (empty points surrounded exclusively by live stones of one color + dead opponent stone intersections)
  blackTerritory: number;
  whiteTerritory: number;
  // Alive stones currently on board
  blackAliveStones: number;
  whiteAliveStones: number;
  // Prisoners captured during play
  blackCapturesDuringPlay: number; // White stones captured by Black
  whiteCapturesDuringPlay: number; // Black stones captured by White
  // Dead stones marked at scoring
  deadBlackStones: number;
  deadWhiteStones: number;
  // Neutral dame intersections
  dameCount: number;
  // Final totals
  blackTotal: number;
  whiteTotal: number;
  winner: PlayerColor | 'draw';
  margin: number; // |blackTotal - whiteTotal|
  territoryMap: Int8Array; // 0: neutral/occupied-alive, 1: black territory, 2: white territory
  deadStoneMask: Uint8Array; // 1 where stone on board is marked dead
}

export interface GameResult {
  winner: PlayerColor | 'draw';
  reason: WinReason;
  margin?: number;
  scoreBreakdown?: ScoreBreakdown;
  winningLine?: Coord[];
  summaryText: string;
}

declare global {
  interface Window {
    electronAPI?: {
      isElectron: boolean;
      isAdmin?: boolean;
      saveSgf: (content: string, defaultName?: string) => Promise<{ canceled: boolean; filePath?: string }>;
      openSgf: () => Promise<{ canceled: boolean; content?: string; fileName?: string }>;
      toggleFullscreen: () => Promise<boolean>;
      adminSignPayload?: (canonicalJson: string) => Promise<string>;
      adminDecryptIp?: (encryptedB64: string) => Promise<string>;
      adminLoadBanRegistry?: () => Promise<unknown>;
      adminSaveBanRegistry?: (data: unknown) => Promise<boolean>;
      adminLoadClosedRooms?: () => Promise<unknown>;
      adminSaveClosedRooms?: (data: unknown) => Promise<boolean>;
      katagoAnalyze?: (
        payload: import('../ai/MctsEngine').AISearchRequest
      ) => Promise<{ available: boolean; result?: import('../ai/MctsEngine').AISearchResult }>;
      katagoCancel?: () => Promise<boolean>;
      katagoStatus?: () => Promise<{ nativeAvailable: boolean; modelName: string }>;
      readKataGoWeights?: () => Promise<Uint8Array | null>;
    };
  }
}
