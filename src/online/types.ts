import { BoardSize, Coord, GameResult, GameType, OmokRulesetType, PlayerColor, RulesetType } from '../rules/types';
import { ClockSnapshot } from '../rules/clock';

export type OnlineTransportStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export type OnlineSessionPhase =
  | 'idle'
  | 'quick_matching'
  | 'waiting_room'
  | 'joining_room'
  | 'in_game'
  | 'spectating';

export type OnlineSessionRole = 'none' | 'player' | 'spectator' | 'admin_stealth';

export type RoomLifecycleStatus = 'waiting' | 'in_game';

export type PresenceActivity = 'lobby' | 'playing' | 'spectating';

export type BanTargetType = 'account' | 'ip' | 'both';

export interface LiveConnectedUserRecord {
  clientId: string;
  accountId: string;
  nickname: string;
  platform: 'web' | 'desktop';
  activity: PresenceActivity;
  roomCode?: string;
  ipHash?: string;
  encryptedIp?: string;
  decryptedIp?: string;
  connectedAt: number;
  updatedAt: number;
}

export interface AdminBanEntry {
  banId: string;
  targetType: BanTargetType;
  accountId?: string;
  clientId?: string;
  ipHash?: string;
  maskedIpLabel?: string;
  targetNickname?: string;
  reason: string;
  createdAt: number;
  expiresAt: number | null; // null = permanent ban
}

export interface SignedBanRegistryPayload {
  version: number;
  updatedAt: number;
  bans: AdminBanEntry[];
  signature: string;
}

export interface SignedAdminForceClosePayload {
  action: 'admin_force_close';
  roomCode: string;
  reason: string;
  issuedAt: number;
  signature: string;
}

export interface SignedAdminStealthInspectPayload {
  action: 'admin_stealth_inspect';
  roomCode: string;
  adminId: string;
  timestamp: number;
  signature: string;
}

export interface AdminStealthWelcomePayload {
  roomCode: string;
  roomStatus: RoomLifecycleStatus;
  roomListing?: RoomSummary;
  hostId: string;
  guestId: string;
  matchInit?: OnlineMatchInitPayload;
  snapshot?: SyncSnapshotPayload | null;
}

export interface AdminInterceptedChatMessage {
  channel: 'player' | 'spectator';
  roomCode: string;
  senderId: string;
  senderName: string;
  senderColor?: PlayerColor;
  text: string;
  sentAt: number;
}

export interface PresenceStats {
  onlineUsers: number;
  inGameUsers: number;
  spectatingUsers: number;
}

export type QuickMatchSizePref = BoardSize | 'any';

export interface CreateRoomOptions {
  title?: string;
  isPublic: boolean;
  password?: string;
  gameType?: GameType;
  omokRuleset?: OmokRulesetType;
  boardSize: BoardSize;
  ruleset: RulesetType;
  handicap: number;
  komi: number;
  mainTimeSeconds: number;
  byoyomiSeconds: number;
  byoyomiPeriods: number;
  hostColorPref: 'black' | 'white' | 'random';
}

export interface RoomSummary {
  roomCode: string;
  title: string;
  hostId: string;
  hostName: string;
  isPublic: boolean;
  hasPassword: boolean;
  status: RoomLifecycleStatus;
  blackName?: string;
  whiteName?: string;
  moveCount?: number;
  spectatorCount?: number;
  gameType?: GameType;
  omokRuleset?: OmokRulesetType;
  boardSize: BoardSize;
  ruleset: RulesetType;
  handicap: number;
  komi: number;
  mainTimeSeconds: number;
  byoyomiSeconds: number;
  byoyomiPeriods: number;
  hostColorPref: 'black' | 'white' | 'random';
  createdAt: number;
  updatedAt: number;
}

export interface OnlineMatchInitPayload {
  roomCode: string;
  hostId: string;
  guestId: string;
  blackId: string;
  whiteId: string;
  blackName: string;
  whiteName: string;
  playerChatToken?: string;
  gameType?: GameType;
  omokRuleset?: OmokRulesetType;
  boardSize: BoardSize;
  ruleset: RulesetType;
  handicap: number;
  komi: number;
  mainTimeSeconds: number;
  byoyomiSeconds: number;
  byoyomiPeriods: number;
  startedAt: number;
}

export interface OnlineRoleInfo {
  roomCode: string;
  isHost: boolean;
  myColor: PlayerColor;
  opponentName: string;
  opponentId: string;
  sessionRole?: OnlineSessionRole;
  spectatorCount?: number;
}

export interface OnlineScoreAgreementState {
  blackAgreed: boolean;
  whiteAgreed: boolean;
}

export interface OnlineEnvelope<T = unknown> {
  msgId: string;
  senderId: string;
  sentAt: number;
  type: string;
  payload: T;
}

export interface MovePacketPayload {
  roomCode: string;
  x: number;
  y: number;
  color: PlayerColor;
  moveNumber: number;
  clock?: ClockSnapshot;
}

export interface PassPacketPayload {
  roomCode: string;
  color: PlayerColor;
  moveNumber: number;
  clock?: ClockSnapshot;
}

export interface DeadTogglePacketPayload {
  roomCode: string;
  x: number;
  y: number;
  deadIndices: number[];
}

export interface ScoreAgreePacketPayload {
  roomCode: string;
  color: PlayerColor;
  deadIndices: number[];
}

export interface SyncSnapshotPayload {
  roomCode: string;
  moves: Array<{ color: PlayerColor; coord: Coord | null }>;
  phase: 'playing' | 'scoring' | 'finished';
  deadIndices: number[];
  scoreAgreement: OnlineScoreAgreementState;
  clock: ClockSnapshot;
  result?: GameResult | null;
}

export interface OnlineTransport {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  getBrokerLabel(): string;
  subscribe(topic: string): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
  publish(topic: string, data: unknown, options?: { retain?: boolean }): void;
  onMessage(handler: (topic: string, data: unknown) => void): () => void;
  onStatusChange(handler: (status: OnlineTransportStatus, brokerLabel: string) => void): () => void;
}
