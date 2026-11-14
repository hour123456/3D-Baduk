import { BLACK, WHITE, BoardSize, GameConfig, GameType, OmokRulesetType, PlayerColor } from '../rules/types';
import { ClockSnapshot } from '../rules/clock';
import { ProfileManager } from '../profile/ProfileManager';
import {
  AdminBanEntry,
  AdminClosedRoomEntry,
  AdminInterceptedChatMessage,
  AdminStealthWelcomePayload,
  CreateRoomOptions,
  DeadTogglePacketPayload,
  LiveConnectedUserRecord,
  MovePacketPayload,
  OnlineEnvelope,
  OnlineMatchInitPayload,
  OnlineRoleInfo,
  OnlineScoreAgreementState,
  OnlineSessionPhase,
  OnlineSessionRole,
  OnlineTransport,
  OnlineTransportStatus,
  PassPacketPayload,
  PresenceActivity,
  PresenceStats,
  QuickMatchSizePref,
  RoomSummary,
  ScoreAgreePacketPayload,
  SignedAdminForceClosePayload,
  SignedAdminStealthInspectPayload,
  SignedBanRegistryPayload,
  SignedClosedRoomsPayload,
  SyncSnapshotPayload,
} from './types';
import {
  canonicalizePayload,
  detectPublicIp,
  encryptIpForAdmin,
  findActiveBanForIdentity,
  formatBanDurationRemaining,
  hashIpAddress,
  isBanActive,
  verifyAdminSignature,
} from './adminSecurity';

const TOPIC_PREFIX = 'sudam-3d-baduk-v1';
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_TTL_MS = 25000;
const PRESENCE_TTL_MS = 28000;
const ADMIN_CMD_MAX_AGE_MS = 120000;
const CLOSED_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HOST_IDLE_MAX_MS = 30 * 60 * 1000;

function generateChatToken(): string {
  return `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function normalizeRoomCode(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-_]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(cleaned)) return null;
  return cleaned;
}

export function generateRoomCode(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  }
  return out;
}

export interface OnlineMatchCallbacks {
  onStatusChange: (status: OnlineTransportStatus, brokerLabel: string) => void;
  onPhaseChange: (phase: OnlineSessionPhase, detail?: string) => void;
  onOpenRoomsUpdated: (rooms: RoomSummary[]) => void;
  onWaitingRoomReady: (room: RoomSummary, isPublic: boolean) => void;
  onMatchStart: (config: GameConfig, role: OnlineRoleInfo, isRematch: boolean) => void;
  onSpectateStart?: (
    config: GameConfig,
    matchInit: OnlineMatchInitPayload,
    snapshot: SyncSnapshotPayload | null,
    spectatorCount: number
  ) => void;
  onSpectatorCountUpdated?: (spectatorCount: number) => void;
  onPresenceUpdated?: (stats: PresenceStats) => void;
  onRoomPasswordRequired?: (action: 'join' | 'spectate', roomCode: string, title?: string) => void;
  onRoomPasswordRejected?: (action: 'join' | 'spectate', roomCode: string, reason: string) => void;
  onRemoteMove: (payload: MovePacketPayload) => void;
  onRemotePass: (payload: PassPacketPayload) => void;
  onRemoteDeadToggle: (payload: DeadTogglePacketPayload) => void;
  onScoreAgreementChanged: (state: OnlineScoreAgreementState, deadIndices?: number[]) => void;
  onScoreBothAgreed: () => void;
  onRemoteScoreResume: (byColor: PlayerColor) => void;
  onRemoteResign: (color: PlayerColor) => void;
  onRemoteTimeout: (timedOutColor: PlayerColor) => void;
  onUndoRequested: (requesterColor: PlayerColor, steps: number) => void;
  onUndoResolved: (accepted: boolean, steps: number, clock?: ClockSnapshot) => void;
  onRematchRequested: (requesterColor: PlayerColor) => void;
  onRematchDeclined: () => void;
  onRemoteChat: (senderName: string, senderColor: PlayerColor, text: string) => void;
  onRemotePlayerChat?: (senderName: string, senderColor: PlayerColor, text: string) => void;
  onRemoteSpectatorChat?: (senderName: string, senderId: string, text: string) => void;
  onOpponentLeft: (opponentName: string) => void;
  onLatencyUpdated: (pingMs: number) => void;
  onSyncRequested: () => SyncSnapshotPayload | null;
  onSyncSnapshotReceived: (snapshot: SyncSnapshotPayload) => void;
  onError: (message: string) => void;

  // Admin Console & Ban / Moderation Callbacks
  onLiveUsersChanged?: (users: LiveConnectedUserRecord[]) => void;
  onBanRegistryChanged?: (bans: AdminBanEntry[]) => void;
  onClosedRoomsChanged?: (closedRooms: AdminClosedRoomEntry[]) => void;
  onSelfBanned?: (ban: AdminBanEntry) => void;
  onRoomForceClosed?: (reason: string) => void;
  onAdminMonitorChat?: (msg: AdminInterceptedChatMessage) => void;
  onAdminStealthJoined?: (welcome: AdminStealthWelcomePayload) => void;
}

export interface OnlineMatchManagerOptions {
  adminMode?: boolean;
  simulatedPublicIp?: string;
}

interface QuickMatchSeekPayload {
  clientId: string;
  nickname: string;
  preferredSize: QuickMatchSizePref;
  gameType?: GameType;
  omokRuleset?: OmokRulesetType;
  joinedAt: number;
}

interface QuickMatchOfferPayload {
  roomCode: string;
  hostId: string;
  hostName: string;
  guestId: string;
  boardSize: BoardSize;
  gameType?: GameType;
  omokRuleset?: OmokRulesetType;
}

interface QuickMatchAcceptPayload {
  roomCode: string;
  hostId: string;
  guestId: string;
  guestName: string;
  boardSize: BoardSize;
  gameType?: GameType;
  omokRuleset?: OmokRulesetType;
}

interface RoomJoinReqPayload {
  roomCode: string;
  guestId: string;
  guestName: string;
  accountId?: string;
  ipHash?: string;
  password?: string;
}

interface SpectateJoinReqPayload {
  roomCode: string;
  spectatorId: string;
  spectatorName: string;
  accountId?: string;
  ipHash?: string;
  password?: string;
}

interface SpectateWelcomePayload {
  roomCode: string;
  matchInit: OnlineMatchInitPayload;
  snapshot: SyncSnapshotPayload | null;
  spectatorCount: number;
}

export class OnlineMatchManager {
  private profile: ProfileManager;
  private transport: OnlineTransport;
  private callbacks: OnlineMatchCallbacks;
  private adminMode = false;
  private simulatedPublicIp?: string;

  private phase: OnlineSessionPhase = 'idle';
  private sessionRole: OnlineSessionRole = 'none';
  private sessionSeq = 0;
  private activeRoomCode: string | null = null;
  private roleInfo: OnlineRoleInfo | null = null;
  private lastMatchInit: OnlineMatchInitPayload | null = null;
  private activeMatchStartedAt = 0;
  private pendingPlayerChatToken = '';

  // Deduplication ring buffer
  private seenMsgIds = new Set<string>();
  private seenMsgQueue: string[] = [];

  // Lobby open rooms cache
  private openRooms = new Map<string, RoomSummary>();
  private watchingLobby = false;
  private lobbyPruneTimer: ReturnType<typeof setInterval> | null = null;

  // Host waiting & live room state (password stays strictly in host memory)
  private hostedRoom: RoomSummary | null = null;
  private hostedIsPublic = true;
  private hostRoomPassword = '';
  private hostAdvertiseTimer: ReturnType<typeof setInterval> | null = null;
  private lastHostActivityAt = Date.now();

  // Spectator & presence state
  private pendingJoinAction: 'join' | 'spectate' = 'join';
  private activeSpectators = new Map<string, { name: string; updatedAt: number }>();
  private spectatorHbTimer: ReturnType<typeof setInterval> | null = null;
  private spectatorPruneTimer: ReturnType<typeof setInterval> | null = null;

  private presenceTracking = false;
  private presencePeers = new Map<string, { activity: PresenceActivity; updatedAt: number }>();
  private liveUsers = new Map<string, LiveConnectedUserRecord>();
  private presenceHbTimer: ReturnType<typeof setInterval> | null = null;
  private presencePruneTimer: ReturnType<typeof setInterval> | null = null;

  // Client network identity & ban enforcement
  private connectedAt = Date.now();
  private myIpHash = '';
  private myEncryptedIp = '';
  private myIpReadyPromise: Promise<void> | null = null;
  private banRegistry: AdminBanEntry[] = [];
  private closedRooms: AdminClosedRoomEntry[] = [];
  private adminSubscribed = false;
  private pendingBanVerifyPromise: Promise<void> | null = null;
  private pendingClosedRoomsVerifyPromise: Promise<void> | null = null;
  private closedRoomClearThrottle = new Map<string, number>();

  // Admin stealth room monitoring state
  private stealthTargetHostId = '';
  private stealthTargetGuestId = '';
  private stealthWelcomeReceived = false;
  private stealthJoinTimeout: ReturnType<typeof setTimeout> | null = null;
  private stealthInspectRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private stealthSyncFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  // Join room retry timer
  private joinRetryTimer: ReturnType<typeof setInterval> | null = null;
  private joinTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // Quick match state
  private qmPreferredSize: QuickMatchSizePref = 'any';
  private qmGameType: GameType = 'baduk';
  private qmOmokRuleset: OmokRulesetType = 'renju';
  private qmSeekTimer: ReturnType<typeof setInterval> | null = null;
  private qmPendingOffer: {
    peerId: string;
    roomCode: string;
    boardSize: BoardSize;
    gameType?: GameType;
    omokRuleset?: OmokRulesetType;
    expiresAt: number;
  } | null = null;
  private qmAcceptedRoomCode: string | null = null;

  // In-game ping & scoring state
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private scoreAgreement: OnlineScoreAgreementState = { blackAgreed: false, whiteAgreed: false };
  private lastAgreedMaskKey = '';

  constructor(
    profile: ProfileManager,
    transport: OnlineTransport,
    callbacks: OnlineMatchCallbacks,
    options?: OnlineMatchManagerOptions
  ) {
    this.profile = profile;
    this.transport = transport;
    this.callbacks = callbacks;
    this.adminMode = Boolean(options?.adminMode);
    this.simulatedPublicIp = options?.simulatedPublicIp;

    this.transport.onStatusChange((status, label) => {
      this.callbacks.onStatusChange(status, label);
      if (status === 'connected') {
        this.adminSubscribed = false;
        void this.subscribeAdminChannels();
        if (this.phase === 'in_game' && this.activeRoomCode) {
          this.sendRoomPacket('sync_request', { roomCode: this.activeRoomCode });
        }
      }
    });

    this.transport.onMessage((topic, data) => {
      this.handleIncomingMessage(topic, data);
    });

    if (typeof window !== 'undefined') {
      const cleanupOnUnload = () => {
        if (!this.adminMode && this.presenceTracking && this.transport.isConnected()) {
          this.transport.publish(
            this.presenceTopic(),
            this.makeEnvelope('presence_bye', { clientId: this.profile.getClientId() })
          );
        }
        this.leaveCurrentSession(true);
      };
      window.addEventListener('beforeunload', cleanupOnUnload);
      window.addEventListener('pagehide', cleanupOnUnload);
    }
  }

  public getPhase(): OnlineSessionPhase {
    return this.phase;
  }

  public getSessionRole(): OnlineSessionRole {
    return this.sessionRole;
  }

  public getRoleInfo(): OnlineRoleInfo | null {
    return this.roleInfo ? { ...this.roleInfo } : null;
  }

  public getActiveRoomCode(): string | null {
    return this.activeRoomCode;
  }

  public getScoreAgreement(): OnlineScoreAgreementState {
    return { ...this.scoreAgreement };
  }

  private setPhase(next: OnlineSessionPhase, detail?: string): void {
    this.phase = next;
    this.callbacks.onPhaseChange(next, detail);
    if (this.presenceTracking) {
      this.publishPresenceHeartbeat();
      this.emitPresenceStats();
    }
  }

  private makeEnvelope<T>(type: string, payload: T): OnlineEnvelope<T> {
    const msgId = `${this.profile.getClientId()}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    this.markSeen(msgId);
    return {
      msgId,
      senderId: this.profile.getClientId(),
      sentAt: Date.now(),
      type,
      payload,
    };
  }

  private markSeen(msgId: string): boolean {
    if (this.seenMsgIds.has(msgId)) return false;
    this.seenMsgIds.add(msgId);
    this.seenMsgQueue.push(msgId);
    if (this.seenMsgQueue.length > 600) {
      const oldest = this.seenMsgQueue.shift();
      if (oldest) this.seenMsgIds.delete(oldest);
    }
    return true;
  }

  private roomTopic(roomCode: string): string {
    return `${TOPIC_PREFIX}/room/${roomCode}`;
  }

  private directTopic(clientId: string): string {
    return `${TOPIC_PREFIX}/direct/${clientId}`;
  }

  private lobbyRoomTopic(roomCode: string): string {
    return `${TOPIC_PREFIX}/lobby/rooms/${roomCode}`;
  }

  private lobbyRoomsWildcard(): string {
    return `${TOPIC_PREFIX}/lobby/rooms/+`;
  }

  private lobbyRoomsReqTopic(): string {
    return `${TOPIC_PREFIX}/lobby/rooms_req`;
  }

  private quickMatchTopic(): string {
    return `${TOPIC_PREFIX}/lobby/quickmatch`;
  }

  private presenceTopic(): string {
    return `${TOPIC_PREFIX}/presence/all`;
  }

  private spectatorChatTopic(roomCode: string): string {
    return `${TOPIC_PREFIX}/room/${roomCode}/spectator_chat`;
  }

  private adminBansTopic(): string {
    return `${TOPIC_PREFIX}/admin/bans`;
  }

  private adminClosedRoomsTopic(): string {
    return `${TOPIC_PREFIX}/admin/closed_rooms`;
  }

  private adminEventsTopic(): string {
    return `${TOPIC_PREFIX}/admin/events`;
  }

  private isElectronClient(): boolean {
    return typeof window !== 'undefined' && Boolean(window.electronAPI?.isElectron);
  }

  private async ensureClientNetworkIdentity(): Promise<void> {
    if (this.adminMode || this.myIpHash) return;
    if (!this.myIpReadyPromise) {
      this.myIpReadyPromise = (async () => {
        try {
          const detected = this.simulatedPublicIp || (await detectPublicIp()) || '127.0.0.1';
          this.myIpHash = await hashIpAddress(detected);
          this.myEncryptedIp = await encryptIpForAdmin(detected);
        } catch {
          this.myIpHash = await hashIpAddress('0.0.0.0');
          this.myEncryptedIp = '';
        }
      })();
    }
    await this.myIpReadyPromise;
  }

  private async subscribeAdminChannels(): Promise<void> {
    if (this.adminSubscribed || !this.transport.isConnected()) return;
    this.adminSubscribed = true;
    try {
      await this.transport.subscribe(this.adminBansTopic());
      await this.transport.subscribe(this.adminClosedRoomsTopic());
      await this.transport.subscribe(this.adminEventsTopic());
      if (this.pendingBanVerifyPromise) {
        await this.pendingBanVerifyPromise;
      }
      if (this.pendingClosedRoomsVerifyPromise) {
        await this.pendingClosedRoomsVerifyPromise;
      }
    } catch {
      this.adminSubscribed = false;
    }
  }

  public async ensureConnected(): Promise<void> {
    await this.ensureClientNetworkIdentity();
    await this.transport.connect();
    await this.transport.subscribe(this.directTopic(this.profile.getClientId()));
    await this.subscribeAdminChannels();
    if (this.pendingBanVerifyPromise) {
      await this.pendingBanVerifyPromise;
    }
    if (this.pendingClosedRoomsVerifyPromise) {
      await this.pendingClosedRoomsVerifyPromise;
    }
  }

  private getProfileAccountId(): string {
    return typeof this.profile.getAccountId === 'function'
      ? this.profile.getAccountId()
      : this.profile.getClientId();
  }

  public getBanRegistry(): AdminBanEntry[] {
    return this.banRegistry.filter((b) => isBanActive(b));
  }

  public getClosedRooms(now = Date.now()): AdminClosedRoomEntry[] {
    return this.closedRooms
      .filter((entry) => entry.expiresAt > now)
      .sort((a, b) => b.closedAt - a.closedAt);
  }

  private isRoomClosedByAdmin(roomCode: string, now = Date.now()): boolean {
    return this.closedRooms.some((entry) => entry.roomCode === roomCode && entry.expiresAt > now);
  }

  public getActiveBanForSelf(): AdminBanEntry | null {
    if (this.adminMode) return null;
    return findActiveBanForIdentity(this.banRegistry, {
      accountId: this.getProfileAccountId(),
      clientId: this.profile.getClientId(),
      ipHash: this.myIpHash,
    });
  }

  private enforceBanOnSelf(): AdminBanEntry | null {
    const ban = this.getActiveBanForSelf();
    if (!ban) return null;
    if (this.phase !== 'idle') {
      void this.cancelMatchmakingOrRoom();
    }
    this.callbacks.onSelfBanned?.(ban);
    return ban;
  }

  public getLiveConnectedUsers(): LiveConnectedUserRecord[] {
    const now = Date.now();
    const out: LiveConnectedUserRecord[] = [];
    for (const [id, rec] of this.liveUsers.entries()) {
      if (now - rec.updatedAt > PRESENCE_TTL_MS) {
        this.liveUsers.delete(id);
        continue;
      }
      out.push({ ...rec });
    }
    if (this.presenceTracking && !this.adminMode) {
      const myId = this.profile.getClientId();
      if (!this.liveUsers.has(myId)) {
        out.push({
          clientId: myId,
          accountId: this.getProfileAccountId(),
          nickname: this.profile.getNickname(),
          platform: this.isElectronClient() ? 'desktop' : 'web',
          activity: this.getMyPresenceActivity(),
          roomCode: this.activeRoomCode || undefined,
          ipHash: this.myIpHash,
          encryptedIp: this.myEncryptedIp,
          connectedAt: this.connectedAt,
          updatedAt: now,
        });
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // =========================================================================
  // Web Live Concurrent User Presence
  // =========================================================================

  private getMyPresenceActivity(): PresenceActivity {
    if (this.phase === 'in_game') return 'playing';
    if (this.phase === 'spectating') return 'spectating';
    return 'lobby';
  }

  public async startPresenceTracking(): Promise<void> {
    if (this.presenceTracking) {
      if (!this.adminMode) this.publishPresenceHeartbeat();
      this.emitPresenceStats();
      return;
    }
    this.presenceTracking = true;
    await this.ensureConnected();
    if (!this.presenceTracking) return;
    await this.transport.subscribe(this.presenceTopic());
    this.transport.publish(
      this.presenceTopic(),
      this.makeEnvelope('presence_req', { requesterId: this.profile.getClientId() })
    );
    if (!this.adminMode) {
      this.publishPresenceHeartbeat();
      this.presenceHbTimer = setInterval(() => this.publishPresenceHeartbeat(), 10000);
    }
    this.emitPresenceStats();
    this.presencePruneTimer = setInterval(() => this.prunePresencePeers(), 5000);
  }

  public stopPresenceTracking(): void {
    if (this.presenceHbTimer) {
      clearInterval(this.presenceHbTimer);
      this.presenceHbTimer = null;
    }
    if (this.presencePruneTimer) {
      clearInterval(this.presencePruneTimer);
      this.presencePruneTimer = null;
    }
    if (this.presenceTracking && this.transport.isConnected()) {
      if (!this.adminMode) {
        this.transport.publish(
          this.presenceTopic(),
          this.makeEnvelope('presence_bye', { clientId: this.profile.getClientId() })
        );
      }
      void this.transport.unsubscribe(this.presenceTopic());
    }
    this.presenceTracking = false;
    this.presencePeers.clear();
    this.liveUsers.clear();
  }

  private publishPresenceHeartbeat(): void {
    if (this.adminMode || !this.presenceTracking || !this.transport.isConnected()) return;
    this.transport.publish(
      this.presenceTopic(),
      this.makeEnvelope('presence_hb', {
        clientId: this.profile.getClientId(),
        accountId: this.getProfileAccountId(),
        nickname: this.profile.getNickname(),
        platform: this.isElectronClient() ? 'desktop' : 'web',
        activity: this.getMyPresenceActivity(),
        roomCode: this.activeRoomCode || undefined,
        ipHash: this.myIpHash,
        encryptedIp: this.myEncryptedIp,
        connectedAt: this.connectedAt,
        sentAt: Date.now(),
      })
    );
  }

  private prunePresencePeers(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, entry] of this.presencePeers.entries()) {
      if (now - entry.updatedAt > PRESENCE_TTL_MS) {
        this.presencePeers.delete(id);
        this.liveUsers.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.emitPresenceStats();
    }
  }

  public getPresenceStats(): PresenceStats {
    const now = Date.now();
    const myId = this.profile.getClientId();
    let onlineUsers = 0;
    let inGameUsers = 0;
    let spectatingUsers = 0;

    if (this.presenceTracking && !this.adminMode) {
      onlineUsers = 1;
      const myActivity = this.getMyPresenceActivity();
      if (myActivity === 'playing') inGameUsers++;
      else if (myActivity === 'spectating') spectatingUsers++;
    }

    for (const [id, entry] of this.presencePeers.entries()) {
      if (id === myId) continue;
      if (now - entry.updatedAt > PRESENCE_TTL_MS) {
        this.presencePeers.delete(id);
        this.liveUsers.delete(id);
        continue;
      }
      onlineUsers++;
      if (entry.activity === 'playing') inGameUsers++;
      else if (entry.activity === 'spectating') spectatingUsers++;
    }

    return { onlineUsers, inGameUsers, spectatingUsers };
  }

  private emitPresenceStats(): void {
    this.callbacks.onPresenceUpdated?.(this.getPresenceStats());
    this.callbacks.onLiveUsersChanged?.(this.getLiveConnectedUsers());
  }

  // =========================================================================
  // Open Room Directory Watching
  // =========================================================================

  public async startWatchingLobby(): Promise<void> {
    await this.ensureConnected();
    if (!this.watchingLobby) {
      this.watchingLobby = true;
      await this.transport.subscribe(this.lobbyRoomsWildcard());
      if (!this.lobbyPruneTimer) {
        this.lobbyPruneTimer = setInterval(() => this.pruneStaleRooms(), 3500);
      }
    }
    // Ask active hosts to announce immediately as well
    this.transport.publish(
      this.lobbyRoomsReqTopic(),
      this.makeEnvelope('rooms_ping', { requester: this.profile.getClientId() })
    );
    this.emitOpenRooms();
  }

  public async stopWatchingLobby(): Promise<void> {
    if (!this.watchingLobby) return;
    this.watchingLobby = false;
    if (this.lobbyPruneTimer) {
      clearInterval(this.lobbyPruneTimer);
      this.lobbyPruneTimer = null;
    }
    await this.transport.unsubscribe(this.lobbyRoomsWildcard());
  }

  public refreshOpenRooms(): void {
    if (!this.transport.isConnected()) return;
    this.pruneStaleRooms();
    this.transport.publish(
      this.lobbyRoomsReqTopic(),
      this.makeEnvelope('rooms_ping', { requester: this.profile.getClientId() })
    );
    this.emitOpenRooms();
  }

  private pruneStaleRooms(): void {
    const now = Date.now();
    let removed = false;
    for (const [code, summary] of this.openRooms.entries()) {
      if (now - summary.updatedAt > ROOM_TTL_MS) {
        this.openRooms.delete(code);
        removed = true;
      }
    }
    if (removed) {
      this.emitOpenRooms();
    }
  }

  private emitOpenRooms(): void {
    const myId = this.profile.getClientId();
    const now = Date.now();
    const list = Array.from(this.openRooms.values())
      .filter(
        (r) =>
          r.hostId !== myId &&
          !this.isRoomClosedByAdmin(r.roomCode, now) &&
          now - r.updatedAt <= ROOM_TTL_MS
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    this.callbacks.onOpenRoomsUpdated(list);
  }

  public getOpenRooms(): RoomSummary[] {
    this.pruneStaleRooms();
    const now = Date.now();
    return Array.from(this.openRooms.values())
      .filter((r) => !this.isRoomClosedByAdmin(r.roomCode, now) && now - r.updatedAt <= ROOM_TTL_MS)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  public isOwnRoom(room: RoomSummary): boolean {
    if (!room) return false;
    if (room.hostId === this.profile.getClientId()) return true;
    const myAcc = this.getProfileAccountId();
    return Boolean(room.accountId && myAcc && room.accountId === myAcc);
  }

  public async closeOwnOrLingeringRoom(rawCode: string): Promise<void> {
    const roomCode = normalizeRoomCode(rawCode);
    if (!roomCode) return;
    await this.ensureConnected();
    if (this.activeRoomCode === roomCode) {
      await this.cancelMatchmakingOrRoom();
    }
    this.transport.publish(
      this.roomTopic(roomCode),
      this.makeEnvelope('leave', {
        roomCode,
        senderName: this.profile.getNickname(),
      })
    );
    this.transport.publish(this.lobbyRoomTopic(roomCode), null, { retain: true });
    if (this.openRooms.delete(roomCode)) {
      this.emitOpenRooms();
    }
  }

  // =========================================================================
  // Create & Host Room
  // =========================================================================

  public async createRoom(options: CreateRoomOptions): Promise<RoomSummary> {
    const trimmedPassword = (options.password ?? '').trim();
    if (!options.isPublic && !trimmedPassword) {
      throw new Error('비공개 대국실은 비밀번호를 입력해야 합니다.');
    }

    await this.cancelMatchmakingOrRoom();
    const seq = ++this.sessionSeq;
    await this.ensureConnected();
    const activeBan = this.enforceBanOnSelf();
    if (activeBan) {
      throw new Error(`이용 제한 중입니다 (${formatBanDurationRemaining(activeBan.expiresAt)})`);
    }
    if (seq !== this.sessionSeq) throw new Error('대국방 생성 요청이 취소되었습니다.');

    const roomCode = generateRoomCode(6);
    const now = Date.now();
    const hostName = this.profile.getNickname();
    const title = options.title?.trim() || `${hostName}님의 수담 대국실`;

    // Note: password NEVER leaves host memory or enters RoomSummary
    const summary: RoomSummary = {
      roomCode,
      title,
      hostId: this.profile.getClientId(),
      accountId: this.getProfileAccountId(),
      hostName,
      isPublic: options.isPublic,
      hasPassword: !options.isPublic,
      status: 'waiting',
      moveCount: 0,
      spectatorCount: 0,
      boardSize: options.boardSize,
      ruleset: options.ruleset,
      gameType: options.gameType ?? 'baduk',
      omokRuleset: options.omokRuleset ?? 'renju',
      handicap: options.handicap,
      komi: options.komi,
      mainTimeSeconds: options.mainTimeSeconds,
      byoyomiSeconds: options.byoyomiSeconds,
      byoyomiPeriods: options.byoyomiPeriods,
      hostColorPref: options.hostColorPref,
      createdAt: now,
      updatedAt: now,
    };

    this.activeRoomCode = roomCode;
    this.hostedRoom = summary;
    this.hostedIsPublic = options.isPublic;
    this.hostRoomPassword = options.isPublic ? '' : trimmedPassword;
    this.lastHostActivityAt = now;
    this.activeSpectators.clear();

    await this.transport.subscribe(this.roomTopic(roomCode));
    // Both public and private rooms appear in the unified lobby listing
    await this.transport.subscribe(this.lobbyRoomsReqTopic());
    this.publishHostedRoomListing();
    this.hostAdvertiseTimer = setInterval(() => this.publishHostedRoomListing(), 6000);

    this.setPhase('waiting_room', roomCode);
    this.callbacks.onWaitingRoomReady(summary, options.isPublic);
    return summary;
  }

  private publishHostedRoomListing(): void {
    if (!this.hostedRoom) return;
    if (this.phase !== 'waiting_room' && this.phase !== 'in_game') return;
    const now = Date.now();
    if (
      this.isRoomClosedByAdmin(this.hostedRoom.roomCode, now) ||
      now - this.lastHostActivityAt > HOST_IDLE_MAX_MS
    ) {
      this.clearHostedRoomListing(this.hostedRoom.roomCode);
      this.hostedRoom = null;
      return;
    }
    this.hostedRoom.hostName = this.profile.getNickname();
    this.hostedRoom.spectatorCount = this.activeSpectators.size;
    this.hostedRoom.updatedAt = now;
    this.transport.publish(this.lobbyRoomTopic(this.hostedRoom.roomCode), this.hostedRoom, {
      retain: true,
    });
  }

  public updateHostMoveCount(moveCount: number): void {
    if (!this.hostedRoom || !this.roleInfo?.isHost || this.phase !== 'in_game') return;
    this.lastHostActivityAt = Date.now();
    this.hostedRoom.moveCount = moveCount;
    this.publishHostedRoomListing();
  }

  private clearHostedRoomListing(roomCode: string): void {
    if (this.hostAdvertiseTimer) {
      clearInterval(this.hostAdvertiseTimer);
      this.hostAdvertiseTimer = null;
    }
    this.transport.publish(this.lobbyRoomTopic(roomCode), null, { retain: true });
    void this.transport.unsubscribe(this.lobbyRoomsReqTopic());
  }

  // =========================================================================
  // Join Room / Spectate Room
  // =========================================================================

  public async joinRoom(rawCode: string, password?: string): Promise<void> {
    const roomCode = normalizeRoomCode(rawCode);
    if (!roomCode) {
      this.callbacks.onError('올바른 6자리 방 코드를 입력해 주세요.');
      return;
    }

    await this.cancelMatchmakingOrRoom();
    const seq = ++this.sessionSeq;
    this.activeRoomCode = roomCode;
    this.pendingJoinAction = 'join';
    this.setPhase('joining_room', roomCode);
    try {
      await this.ensureConnected();
    } catch (err) {
      if (seq === this.sessionSeq) this.setPhase('idle');
      throw err;
    }
    if (seq !== this.sessionSeq) return;
    if (this.enforceBanOnSelf()) return;
    await this.transport.subscribe(this.roomTopic(roomCode));

    const sendReq = () => {
      if (this.phase !== 'joining_room' || this.activeRoomCode !== roomCode) return;
      const req: RoomJoinReqPayload = {
        roomCode,
        guestId: this.profile.getClientId(),
        guestName: this.profile.getNickname(),
        accountId: this.getProfileAccountId(),
        ipHash: this.myIpHash,
        password: password?.trim() || undefined,
      };
      this.transport.publish(this.roomTopic(roomCode), this.makeEnvelope('room_join_req', req));
    };

    sendReq();
    this.joinRetryTimer = setInterval(sendReq, 1100);
    this.joinTimeoutTimer = setTimeout(() => {
      if (this.phase === 'joining_room' && this.activeRoomCode === roomCode) {
        void this.cancelMatchmakingOrRoom();
        this.callbacks.onError('해당 방을 찾을 수 없거나 이미 대국이 시작되었습니다.');
      }
    }, 8000);
  }

  public async spectateRoom(rawCode: string, password?: string): Promise<void> {
    const roomCode = normalizeRoomCode(rawCode);
    if (!roomCode) {
      this.callbacks.onError('올바른 6자리 방 코드를 입력해 주세요.');
      return;
    }

    await this.cancelMatchmakingOrRoom();
    const seq = ++this.sessionSeq;
    this.activeRoomCode = roomCode;
    this.pendingJoinAction = 'spectate';
    this.setPhase('joining_room', roomCode);
    try {
      await this.ensureConnected();
    } catch (err) {
      if (seq === this.sessionSeq) this.setPhase('idle');
      throw err;
    }
    if (seq !== this.sessionSeq) return;
    if (this.enforceBanOnSelf()) return;
    await this.transport.subscribe(this.roomTopic(roomCode));
    await this.transport.subscribe(this.spectatorChatTopic(roomCode));

    const sendReq = () => {
      if (this.phase !== 'joining_room' || this.activeRoomCode !== roomCode) return;
      const req: SpectateJoinReqPayload = {
        roomCode,
        spectatorId: this.profile.getClientId(),
        spectatorName: this.profile.getNickname(),
        accountId: this.getProfileAccountId(),
        ipHash: this.myIpHash,
        password: password?.trim() || undefined,
      };
      this.transport.publish(this.roomTopic(roomCode), this.makeEnvelope('spectate_join_req', req));
    };

    sendReq();
    this.joinRetryTimer = setInterval(sendReq, 1100);
    this.joinTimeoutTimer = setTimeout(() => {
      if (this.phase === 'joining_room' && this.activeRoomCode === roomCode) {
        void this.cancelMatchmakingOrRoom();
        this.callbacks.onError('관전 가능한 대국방을 찾을 수 없습니다.');
      }
    }, 8000);
  }

  // =========================================================================
  // Quick Match (빠른 매칭)
  // =========================================================================

  public async startQuickMatch(
    preferredSize: QuickMatchSizePref = 'any',
    gameType: GameType = 'baduk',
    omokRuleset: OmokRulesetType = 'renju'
  ): Promise<void> {
    this.qmGameType = gameType;
    this.qmOmokRuleset = omokRuleset;
    await this.cancelMatchmakingOrRoom();
    const seq = ++this.sessionSeq;
    this.qmPreferredSize = preferredSize;
    this.qmPendingOffer = null;
    this.qmAcceptedRoomCode = null;
    this.setPhase('quick_matching');

    try {
      await this.ensureConnected();
    } catch (err) {
      if (seq === this.sessionSeq) this.setPhase('idle');
      throw err;
    }
    if (seq !== this.sessionSeq) return;
    if (this.enforceBanOnSelf()) return;

    await this.transport.subscribe(this.quickMatchTopic());

    const broadcastSeek = () => {
      if (this.phase !== 'quick_matching') return;
      const seek: QuickMatchSeekPayload = {
        clientId: this.profile.getClientId(),
        nickname: this.profile.getNickname(),
        preferredSize: this.qmPreferredSize,
        gameType: this.qmGameType,
        omokRuleset: this.qmOmokRuleset,
        joinedAt: Date.now(),
      };
      this.transport.publish(this.quickMatchTopic(), this.makeEnvelope('qm_seek', seek));
    };

    broadcastSeek();
    this.qmSeekTimer = setInterval(broadcastSeek, 1200);
  }

  // =========================================================================
  // Cancel / Leave Session
  // =========================================================================

  public async cancelMatchmakingOrRoom(): Promise<void> {
    const seq = ++this.sessionSeq;
    if (this.joinRetryTimer) {
      clearInterval(this.joinRetryTimer);
      this.joinRetryTimer = null;
    }
    if (this.joinTimeoutTimer) {
      clearTimeout(this.joinTimeoutTimer);
      this.joinTimeoutTimer = null;
    }
    if (this.qmSeekTimer) {
      clearInterval(this.qmSeekTimer);
      this.qmSeekTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.spectatorHbTimer) {
      clearInterval(this.spectatorHbTimer);
      this.spectatorHbTimer = null;
    }
    if (this.spectatorPruneTimer) {
      clearInterval(this.spectatorPruneTimer);
      this.spectatorPruneTimer = null;
    }
    if (this.stealthJoinTimeout) {
      clearTimeout(this.stealthJoinTimeout);
      this.stealthJoinTimeout = null;
    }
    if (this.stealthInspectRetryTimer) {
      clearTimeout(this.stealthInspectRetryTimer);
      this.stealthInspectRetryTimer = null;
    }
    if (this.stealthSyncFallbackTimer) {
      clearTimeout(this.stealthSyncFallbackTimer);
      this.stealthSyncFallbackTimer = null;
    }
    this.stealthWelcomeReceived = false;

    const prevHosted = this.hostedRoom;
    const prevRoomCode = this.activeRoomCode;
    const prevStealthHostId = this.stealthTargetHostId;
    const prevStealthGuestId = this.stealthTargetGuestId;
    const wasStealth = this.sessionRole === 'admin_stealth';
    const wasInGame = this.phase === 'in_game';
    const wasSpectating = this.phase === 'spectating' && !wasStealth;

    this.hostedRoom = null;
    this.hostRoomPassword = '';
    this.activeSpectators.clear();
    this.activeRoomCode = null;
    this.stealthTargetHostId = '';
    this.stealthTargetGuestId = '';
    this.qmPendingOffer = null;
    this.qmAcceptedRoomCode = null;
    this.roleInfo = null;
    this.lastMatchInit = null;
    this.activeMatchStartedAt = 0;
    this.pendingPlayerChatToken = '';
    this.sessionRole = 'none';
    this.resetScoreAgreement();

    if (this.phase !== 'idle') {
      this.setPhase('idle');
    }

    if (prevHosted) {
      this.clearHostedRoomListing(prevHosted.roomCode);
    }

    if (prevRoomCode) {
      if (wasInGame) {
        this.transport.publish(
          this.roomTopic(prevRoomCode),
          this.makeEnvelope('leave', {
            roomCode: prevRoomCode,
            senderName: this.profile.getNickname(),
          })
        );
      } else if (wasSpectating) {
        this.transport.publish(
          this.roomTopic(prevRoomCode),
          this.makeEnvelope('spectator_leave', {
            roomCode: prevRoomCode,
            spectatorId: this.profile.getClientId(),
          })
        );
      }
      if (seq === this.sessionSeq) {
        await this.transport.unsubscribe(this.roomTopic(prevRoomCode));
        await this.transport.unsubscribe(this.spectatorChatTopic(prevRoomCode));
      }
    }

    if (seq === this.sessionSeq) {
      const myId = this.profile.getClientId();
      if (prevStealthHostId && prevStealthHostId !== myId) {
        await this.transport.unsubscribe(this.directTopic(prevStealthHostId));
      }
      if (prevStealthGuestId && prevStealthGuestId !== myId && prevStealthGuestId !== prevStealthHostId) {
        await this.transport.unsubscribe(this.directTopic(prevStealthGuestId));
      }
      await this.transport.unsubscribe(this.quickMatchTopic());
    }
  }

  public leaveCurrentSession(silent = false): void {
    if (this.hostedRoom) {
      this.clearHostedRoomListing(this.hostedRoom.roomCode);
    }
    if (this.phase === 'in_game' && this.activeRoomCode) {
      this.sendRoomPacket('leave', {
        roomCode: this.activeRoomCode,
        senderName: this.profile.getNickname(),
      });
    } else if (
      this.phase === 'spectating' &&
      this.sessionRole === 'spectator' &&
      this.activeRoomCode
    ) {
      this.sendRoomPacket('spectator_leave', {
        roomCode: this.activeRoomCode,
        spectatorId: this.profile.getClientId(),
      });
    }
    if (!silent) {
      void this.cancelMatchmakingOrRoom();
    }
  }

  // =========================================================================
  // Incoming Message Router
  // =========================================================================

  private handleIncomingMessage(topic: string, rawData: unknown): void {
    // 0. Global retained Ban Registry (ECDSA P-256 verified)
    if (topic === this.adminBansTopic()) {
      const p = this.handleSignedBanRegistry(rawData);
      const wrapped = p.finally(() => {
        if (this.pendingBanVerifyPromise === wrapped) {
          this.pendingBanVerifyPromise = null;
        }
      });
      this.pendingBanVerifyPromise = wrapped;
      return;
    }

    // 0.5 Global retained Admin Closed Rooms Registry (ECDSA P-256 verified)
    if (topic === this.adminClosedRoomsTopic()) {
      const p = this.handleSignedClosedRooms(rawData);
      const wrapped = p.finally(() => {
        if (this.pendingClosedRoomsVerifyPromise === wrapped) {
          this.pendingClosedRoomsVerifyPromise = null;
        }
      });
      this.pendingClosedRoomsVerifyPromise = wrapped;
      return;
    }

    // 1. Lobby directory retained room updates
    const lobbyPrefix = `${TOPIC_PREFIX}/lobby/rooms/`;
    if (topic.startsWith(lobbyPrefix)) {
      const code = topic.slice(lobbyPrefix.length);
      if (!code) return;
      if (rawData === null) {
        if (this.openRooms.delete(code)) {
          this.emitOpenRooms();
        }
        return;
      }
      const room = rawData as Partial<RoomSummary>;
      if (room && typeof room.roomCode === 'string' && typeof room.hostId === 'string') {
        const now = Date.now();
        if (this.isRoomClosedByAdmin(room.roomCode, now)) {
          if (this.openRooms.delete(room.roomCode)) {
            this.emitOpenRooms();
          }
          if (this.adminMode && this.transport.isConnected()) {
            const lastCleared = this.closedRoomClearThrottle.get(room.roomCode) ?? 0;
            if (now - lastCleared > 12000) {
              this.closedRoomClearThrottle.set(room.roomCode, now);
              this.transport.publish(this.lobbyRoomTopic(room.roomCode), null, { retain: true });
            }
          }
          return;
        }
        this.openRooms.set(room.roomCode, room as RoomSummary);
        this.emitOpenRooms();
      }
      return;
    }

    // 2. Standard Envelope packets
    const env = rawData as Partial<OnlineEnvelope> | null;
    if (!env || typeof env.msgId !== 'string' || typeof env.type !== 'string' || !env.senderId) {
      return;
    }
    if (env.senderId === this.profile.getClientId()) return;
    if (!this.markSeen(env.msgId)) return;

    // 2.5 Global Admin Moderation Events (e.g. Force Close)
    if (topic === this.adminEventsTopic()) {
      if (env.type === 'admin_force_close') {
        void this.handleSignedForceClose(env.payload as SignedAdminForceClosePayload);
      }
      return;
    }

    // Web live concurrent user presence packets
    if (topic === this.presenceTopic()) {
      if (env.type === 'presence_hb') {
        const p = env.payload as {
          clientId?: string;
          accountId?: string;
          nickname?: string;
          platform?: 'web' | 'desktop';
          activity?: PresenceActivity;
          roomCode?: string;
          ipHash?: string;
          encryptedIp?: string;
          connectedAt?: number;
          sentAt?: number;
        };
        if (p?.clientId) {
          const now = Date.now();
          this.presencePeers.set(p.clientId, {
            activity: p.activity ?? 'lobby',
            updatedAt: now,
          });
          this.liveUsers.set(p.clientId, {
            clientId: p.clientId,
            accountId: p.accountId || p.clientId,
            nickname: p.nickname || '익명 기객',
            platform: p.platform === 'desktop' ? 'desktop' : 'web',
            activity: p.activity ?? 'lobby',
            roomCode: p.roomCode,
            ipHash: p.ipHash || '',
            encryptedIp: p.encryptedIp || '',
            connectedAt: p.connectedAt || p.sentAt || now,
            updatedAt: now,
          });
          this.emitPresenceStats();
        }
      } else if (env.type === 'presence_bye') {
        const p = env.payload as { clientId?: string };
        if (p?.clientId) {
          const delPeer = this.presencePeers.delete(p.clientId);
          const delUser = this.liveUsers.delete(p.clientId);
          if (delPeer || delUser) {
            this.emitPresenceStats();
          }
        }
      } else if (env.type === 'presence_req') {
        if (!this.adminMode) {
          this.publishPresenceHeartbeat();
        }
      }
      return;
    }

    // Spectator-only isolated chat channel (players NEVER process this topic; admin stealth sees ALL)
    if (this.activeRoomCode && topic === this.spectatorChatTopic(this.activeRoomCode)) {
      if (env.type === 'spectator_chat') {
        const p = env.payload as { roomCode?: string; senderName?: string; text?: string };
        if (p && p.roomCode === this.activeRoomCode && typeof p.text === 'string' && p.text.trim()) {
          if (this.sessionRole === 'admin_stealth' && this.adminMode) {
            this.callbacks.onAdminMonitorChat?.({
              channel: 'spectator',
              roomCode: this.activeRoomCode,
              senderId: env.senderId,
              senderName: p.senderName || '관전자',
              text: p.text,
              sentAt: env.sentAt || Date.now(),
            });
          } else if (this.phase === 'spectating' && this.sessionRole === 'spectator') {
            this.callbacks.onRemoteSpectatorChat?.(
              p.senderName || '관전자',
              env.senderId,
              p.text
            );
          }
        }
      }
      return;
    }

    // Admin Stealth Wiretap of host/guest direct channels (for 1:1 private player_chat + match updates)
    if (
      this.adminMode &&
      this.sessionRole === 'admin_stealth' &&
      this.activeRoomCode &&
      ((this.stealthTargetHostId && topic === this.directTopic(this.stealthTargetHostId)) ||
        (this.stealthTargetGuestId && topic === this.directTopic(this.stealthTargetGuestId)))
    ) {
      if (env.type === 'player_chat') {
        const p = env.payload as {
          roomCode?: string;
          senderName?: string;
          senderColor?: PlayerColor;
          text?: string;
        };
        if (p && p.roomCode === this.activeRoomCode && typeof p.text === 'string' && p.text.trim()) {
          this.callbacks.onAdminMonitorChat?.({
            channel: 'player',
            roomCode: this.activeRoomCode,
            senderId: env.senderId,
            senderName: p.senderName || '대국자',
            senderColor: p.senderColor,
            text: p.text,
            sentAt: env.sentAt || Date.now(),
          });
        }
      } else if (env.type === 'match_start') {
        const init = env.payload as OnlineMatchInitPayload;
        if (init && init.roomCode === this.activeRoomCode) {
          void this.handleAdminStealthMatchUpdate(init);
        }
      } else if (env.type === 'rematch_response') {
        const p = env.payload as { accepted: boolean; nextMatch?: OnlineMatchInitPayload };
        if (p?.accepted && p.nextMatch && p.nextMatch.roomCode === this.activeRoomCode) {
          void this.handleAdminStealthMatchUpdate(p.nextMatch);
        }
      }
      return;
    }

    // Lobby rooms ping
    if (topic === this.lobbyRoomsReqTopic() && env.type === 'rooms_ping') {
      this.publishHostedRoomListing();
      return;
    }

    // Quick match queue discovery
    if (topic === this.quickMatchTopic() && env.type === 'qm_seek') {
      this.handleQuickMatchSeek(env.payload as QuickMatchSeekPayload);
      return;
    }

    // Direct signaling & direct 1:1 player chat
    if (topic === this.directTopic(this.profile.getClientId())) {
      if (env.type === 'admin_stealth_inspect') {
        void this.handleIncomingAdminStealthInspect(env.payload as SignedAdminStealthInspectPayload);
        return;
      }
      if (env.type === 'admin_stealth_welcome') {
        void this.handleAdminStealthWelcome(env.payload as AdminStealthWelcomePayload);
        return;
      }
      if (env.type === 'qm_offer') {
        void this.handleQuickMatchOffer(env.payload as QuickMatchOfferPayload);
        return;
      }
      if (env.type === 'qm_accept') {
        void this.handleQuickMatchAccept(env.payload as QuickMatchAcceptPayload);
        return;
      }
      if (env.type === 'match_start') {
        void this.handleMatchStartPacket(env.payload as OnlineMatchInitPayload, false);
        return;
      }
      if (env.type === 'room_password_required') {
        const p = env.payload as { action: 'join' | 'spectate'; roomCode: string; title?: string };
        if (this.phase === 'joining_room' && this.activeRoomCode === p.roomCode) {
          void this.cancelMatchmakingOrRoom().then(() => {
            this.callbacks.onRoomPasswordRequired?.(p.action, p.roomCode, p.title);
          });
        }
        return;
      }
      if (env.type === 'room_password_rejected') {
        const p = env.payload as { action: 'join' | 'spectate'; roomCode: string; reason: string };
        if (this.phase === 'joining_room' && this.activeRoomCode === p.roomCode) {
          void this.cancelMatchmakingOrRoom().then(() => {
            this.callbacks.onRoomPasswordRejected?.(
              p.action,
              p.roomCode,
              p.reason || '비밀번호가 일치하지 않습니다.'
            );
          });
        }
        return;
      }
      if (env.type === 'spectate_welcome') {
        void this.handleSpectateWelcome(env.payload as SpectateWelcomePayload);
        return;
      }
      if (env.type === 'rematch_response') {
        if (this.phase === 'in_game' && this.sessionRole === 'player') {
          const p = env.payload as { accepted: boolean; nextMatch?: OnlineMatchInitPayload };
          if (p.accepted && p.nextMatch) {
            void this.handleMatchStartPacket(p.nextMatch, true);
          }
        }
        return;
      }
      // Strictly isolated 1:1 player-to-player chat (Spectators NEVER receive or process this)
      if (env.type === 'player_chat') {
        if (
          this.phase !== 'in_game' ||
          this.sessionRole !== 'player' ||
          !this.roleInfo ||
          env.senderId !== this.roleInfo.opponentId
        ) {
          return;
        }
        const p = env.payload as {
          roomCode?: string;
          token?: string;
          senderName?: string;
          senderColor?: PlayerColor;
          text?: string;
        };
        if (
          !p ||
          p.roomCode !== this.activeRoomCode ||
          !this.lastMatchInit?.playerChatToken ||
          p.token !== this.lastMatchInit.playerChatToken ||
          typeof p.text !== 'string' ||
          !p.text.trim()
        ) {
          return;
        }
        const color = p.senderColor ?? (this.roleInfo.myColor === BLACK ? WHITE : BLACK);
        const senderName = p.senderName || this.roleInfo.opponentName;
        this.callbacks.onRemotePlayerChat?.(senderName, color, p.text);
        this.callbacks.onRemoteChat(senderName, color, p.text);
        return;
      }
    }

    // Room messages (auto-discover legacy/unregistered host & guest IDs for admin stealth wiretap)
    if (this.activeRoomCode && topic === this.roomTopic(this.activeRoomCode)) {
      if (
        this.adminMode &&
        this.sessionRole === 'admin_stealth' &&
        env.senderId &&
        env.senderId !== this.profile.getClientId()
      ) {
        if (!this.stealthTargetHostId) {
          this.stealthTargetHostId = env.senderId;
          void this.transport.subscribe(this.directTopic(env.senderId));
        } else if (
          env.senderId !== this.stealthTargetHostId &&
          !this.stealthTargetGuestId &&
          ['move', 'pass', 'ping', 'pong', 'chat', 'sync_snapshot', 'dead_toggle', 'score_agree'].includes(
            env.type
          )
        ) {
          this.stealthTargetGuestId = env.senderId;
          void this.transport.subscribe(this.directTopic(env.senderId));
        }
      }
      this.handleRoomPacket(env as OnlineEnvelope);
    }
  }

  private handleQuickMatchSeek(peer: QuickMatchSeekPayload): void {
    if (this.phase !== 'quick_matching') return;
    const myId = this.profile.getClientId();
    if (!peer.clientId || peer.clientId === myId) return;

    const peerGameType: GameType = peer.gameType ?? 'baduk';
    if (peerGameType !== this.qmGameType) return;
    if (this.qmGameType === 'omok') {
      const peerOmokRuleset: OmokRulesetType = peer.omokRuleset ?? 'renju';
      if (peerOmokRuleset !== this.qmOmokRuleset) return;
    }

    const sizeCompatible =
      this.qmPreferredSize === 'any' ||
      peer.preferredSize === 'any' ||
      this.qmPreferredSize === peer.preferredSize;
    if (!sizeCompatible) return;

    const defaultSize: BoardSize = this.qmGameType === 'omok' ? 15 : 19;
    const resolvedSize: BoardSize =
      this.qmPreferredSize !== 'any'
        ? this.qmPreferredSize
        : peer.preferredSize !== 'any'
          ? peer.preferredSize
          : defaultSize;

    // Deterministic Host selection: smaller clientId initiates offer
    if (myId < peer.clientId) {
      const now = Date.now();
      if (this.qmPendingOffer && now < this.qmPendingOffer.expiresAt) {
        return;
      }
      if (this.qmAcceptedRoomCode) return;

      const roomCode = generateRoomCode(6);
      this.qmPendingOffer = {
        peerId: peer.clientId,
        roomCode,
        boardSize: resolvedSize,
        gameType: this.qmGameType,
        omokRuleset: this.qmOmokRuleset,
        expiresAt: now + 2600,
      };

      void this.transport.subscribe(this.roomTopic(roomCode)).then(() => {
        if (this.phase !== 'quick_matching') return;
        const offer: QuickMatchOfferPayload = {
          roomCode,
          hostId: myId,
          hostName: this.profile.getNickname(),
          guestId: peer.clientId,
          boardSize: resolvedSize,
          gameType: this.qmGameType,
          omokRuleset: this.qmOmokRuleset,
        };
        this.transport.publish(this.directTopic(peer.clientId), this.makeEnvelope('qm_offer', offer));
      });
    } else {
      // Reply immediately so a waiting smaller-ID peer notices us without waiting 1.2s
      const seek: QuickMatchSeekPayload = {
        clientId: myId,
        nickname: this.profile.getNickname(),
        preferredSize: this.qmPreferredSize,
        gameType: this.qmGameType,
        omokRuleset: this.qmOmokRuleset,
        joinedAt: Date.now(),
      };
      this.transport.publish(this.quickMatchTopic(), this.makeEnvelope('qm_seek', seek));
    }
  }

  private async handleQuickMatchOffer(offer: QuickMatchOfferPayload): Promise<void> {
    if (this.phase !== 'quick_matching') return;
    if (offer.guestId !== this.profile.getClientId()) return;
    if (this.qmAcceptedRoomCode && this.qmAcceptedRoomCode !== offer.roomCode) return;

    this.qmAcceptedRoomCode = offer.roomCode;
    this.activeRoomCode = offer.roomCode;
    await this.transport.subscribe(this.roomTopic(offer.roomCode));

    const accept: QuickMatchAcceptPayload = {
      roomCode: offer.roomCode,
      hostId: offer.hostId,
      guestId: this.profile.getClientId(),
      guestName: this.profile.getNickname(),
      boardSize: offer.boardSize,
      gameType: offer.gameType ?? this.qmGameType,
      omokRuleset: offer.omokRuleset ?? this.qmOmokRuleset,
    };
    this.transport.publish(this.directTopic(offer.hostId), this.makeEnvelope('qm_accept', accept));

    // Safety release if host vanished before sending match_start
    setTimeout(() => {
      if (this.phase === 'quick_matching' && this.qmAcceptedRoomCode === offer.roomCode) {
        this.qmAcceptedRoomCode = null;
        this.activeRoomCode = null;
      }
    }, 3200);
  }

  private async handleQuickMatchAccept(accept: QuickMatchAcceptPayload): Promise<void> {
    if (this.phase !== 'quick_matching') return;
    if (!this.qmPendingOffer) return;
    if (
      accept.roomCode !== this.qmPendingOffer.roomCode ||
      accept.guestId !== this.qmPendingOffer.peerId
    ) {
      return;
    }

    const myId = this.profile.getClientId();
    const myName = this.profile.getNickname();
    const hostIsBlack = Math.random() < 0.5;
    const size = this.qmPendingOffer.boardSize;
    const blackName = hostIsBlack ? myName : accept.guestName;
    const whiteName = hostIsBlack ? accept.guestName : myName;
    const playerChatToken = generateChatToken();
    const now = Date.now();

    const initBase: OnlineMatchInitPayload = {
      roomCode: accept.roomCode,
      hostId: myId,
      guestId: accept.guestId,
      blackId: hostIsBlack ? myId : accept.guestId,
      whiteId: hostIsBlack ? accept.guestId : myId,
      blackName,
      whiteName,
      boardSize: size,
      ruleset: 'korean',
      gameType: accept.gameType ?? this.qmPendingOffer?.gameType ?? this.qmGameType,
      omokRuleset: accept.omokRuleset ?? this.qmPendingOffer?.omokRuleset ?? this.qmOmokRuleset,
      handicap: 0,
      komi: 6.5,
      mainTimeSeconds: size === 9 ? 300 : 600,
      byoyomiSeconds: 30,
      byoyomiPeriods: 3,
      startedAt: now,
    };

    this.activeRoomCode = accept.roomCode;
    this.lastHostActivityAt = now;
    this.hostedRoom = {
      roomCode: accept.roomCode,
      title: `빠른 매칭 (${blackName} vs ${whiteName})`,
      hostId: myId,
      accountId: this.getProfileAccountId(),
      hostName: myName,
      isPublic: true,
      hasPassword: false,
      status: 'in_game',
      blackName,
      whiteName,
      moveCount: 0,
      spectatorCount: 0,
      gameType: initBase.gameType,
      omokRuleset: initBase.omokRuleset,
      boardSize: size,
      ruleset: initBase.ruleset,
      handicap: 0,
      komi: 6.5,
      mainTimeSeconds: initBase.mainTimeSeconds,
      byoyomiSeconds: initBase.byoyomiSeconds,
      byoyomiPeriods: initBase.byoyomiPeriods,
      hostColorPref: hostIsBlack ? 'black' : 'white',
      createdAt: now,
      updatedAt: now,
    };
    this.hostedIsPublic = true;
    this.hostRoomPassword = '';
    this.activeSpectators.clear();
    await this.transport.subscribe(this.lobbyRoomsReqTopic());
    if (this.hostAdvertiseTimer) clearInterval(this.hostAdvertiseTimer);
    this.hostAdvertiseTimer = setInterval(() => this.publishHostedRoomListing(), 6000);

    const initForGuest: OnlineMatchInitPayload = { ...initBase, playerChatToken };
    this.transport.publish(this.directTopic(accept.guestId), this.makeEnvelope('match_start', initForGuest));
    this.transport.publish(this.roomTopic(accept.roomCode), this.makeEnvelope('match_start', initBase));

    await this.handleMatchStartPacket(initForGuest, false);
  }

  private handleRoomPacket(env: OnlineEnvelope): void {
    const isPlayerOrSpectator = this.phase === 'in_game' || this.phase === 'spectating';

    switch (env.type) {
      case 'room_join_req': {
        const req = env.payload as RoomJoinReqPayload;
        if (this.phase !== 'waiting_room' || !this.hostedRoom) {
          if (this.phase === 'in_game' && this.lastMatchInit && req.guestId === this.lastMatchInit.guestId) {
            // Re-send match_start directly so guest receives playerChatToken safely
            this.transport.publish(
              this.directTopic(req.guestId),
              this.makeEnvelope('match_start', this.lastMatchInit)
            );
          } else if (this.roleInfo?.isHost) {
            this.sendRoomPacket('room_join_reject', {
              targetGuestId: req.guestId,
              reason: '이미 다른 대국자와 경기가 진행 중입니다.',
            });
          }
          return;
        }

        const room = this.hostedRoom;
        const guestBan = findActiveBanForIdentity(this.banRegistry, {
          accountId: req.accountId,
          clientId: req.guestId,
          ipHash: req.ipHash,
        });
        if (guestBan) {
          this.sendRoomPacket('room_join_reject', {
            targetGuestId: req.guestId,
            reason: `관리자에 의해 온라인 이용이 제한된 사용자입니다 (${formatBanDurationRemaining(guestBan.expiresAt)}).`,
          });
          return;
        }
        // Private room password check strictly inside host memory
        if (!room.isPublic && this.hostRoomPassword) {
          if (!req.password || !req.password.trim()) {
            this.transport.publish(
              this.directTopic(req.guestId),
              this.makeEnvelope('room_password_required', {
                action: 'join',
                roomCode: room.roomCode,
                title: room.title,
              })
            );
            return;
          }
          if (req.password.trim() !== this.hostRoomPassword) {
            this.transport.publish(
              this.directTopic(req.guestId),
              this.makeEnvelope('room_password_rejected', {
                action: 'join',
                roomCode: room.roomCode,
                reason: '비밀번호가 일치하지 않습니다.',
              })
            );
            return;
          }
        }

        const myId = this.profile.getClientId();
        const myName = this.profile.getNickname();

        let hostIsBlack = true;
        if (room.hostColorPref === 'white') hostIsBlack = false;
        else if (room.hostColorPref === 'random') hostIsBlack = Math.random() < 0.5;

        const blackName = hostIsBlack ? myName : req.guestName;
        const whiteName = hostIsBlack ? req.guestName : myName;
        const playerChatToken = generateChatToken();

        const initBase: OnlineMatchInitPayload = {
          roomCode: room.roomCode,
          hostId: myId,
          guestId: req.guestId,
          blackId: hostIsBlack ? myId : req.guestId,
          whiteId: hostIsBlack ? req.guestId : myId,
          blackName,
          whiteName,
          boardSize: room.boardSize,
          ruleset: room.ruleset,
          gameType: room.gameType ?? 'baduk',
          omokRuleset: room.omokRuleset ?? 'renju',
          handicap: room.handicap,
          komi: room.komi,
          mainTimeSeconds: room.mainTimeSeconds,
          byoyomiSeconds: room.byoyomiSeconds,
          byoyomiPeriods: room.byoyomiPeriods,
          startedAt: Date.now(),
        };

        // Keep room advertised in lobby as live in_game for spectating
        room.status = 'in_game';
        room.blackName = blackName;
        room.whiteName = whiteName;
        room.moveCount = 0;
        room.spectatorCount = this.activeSpectators.size;
        this.publishHostedRoomListing();

        const initForGuest: OnlineMatchInitPayload = { ...initBase, playerChatToken };
        this.transport.publish(this.directTopic(req.guestId), this.makeEnvelope('match_start', initForGuest));
        this.transport.publish(this.roomTopic(room.roomCode), this.makeEnvelope('match_start', initBase));
        void this.handleMatchStartPacket(initForGuest, false);
        break;
      }

      case 'room_join_reject': {
        const rej = env.payload as { targetGuestId: string; reason: string };
        if (this.phase === 'joining_room' && rej.targetGuestId === this.profile.getClientId()) {
          void this.cancelMatchmakingOrRoom();
          this.callbacks.onError(rej.reason || '방에 입장할 수 없습니다.');
        }
        break;
      }

      case 'spectate_join_req': {
        if (!this.roleInfo?.isHost || this.phase !== 'in_game' || !this.lastMatchInit || !this.hostedRoom) {
          return;
        }
        const req = env.payload as SpectateJoinReqPayload;
        if (!req || req.roomCode !== this.activeRoomCode || !req.spectatorId) return;

        const specBan = findActiveBanForIdentity(this.banRegistry, {
          accountId: req.accountId,
          clientId: req.spectatorId,
          ipHash: req.ipHash,
        });
        if (specBan) {
          this.sendRoomPacket('room_join_reject', {
            targetGuestId: req.spectatorId,
            reason: `관리자에 의해 관전 입장이 제한되었습니다 (${formatBanDurationRemaining(specBan.expiresAt)}).`,
          });
          return;
        }

        // Private room password verification for spectators
        if (!this.hostedRoom.isPublic && this.hostRoomPassword) {
          if (!req.password || !req.password.trim()) {
            this.transport.publish(
              this.directTopic(req.spectatorId),
              this.makeEnvelope('room_password_required', {
                action: 'spectate',
                roomCode: this.hostedRoom.roomCode,
                title: this.hostedRoom.title,
              })
            );
            return;
          }
          if (req.password.trim() !== this.hostRoomPassword) {
            this.transport.publish(
              this.directTopic(req.spectatorId),
              this.makeEnvelope('room_password_rejected', {
                action: 'spectate',
                roomCode: this.hostedRoom.roomCode,
                reason: '비밀번호가 일치하지 않습니다.',
              })
            );
            return;
          }
        }

        this.activeSpectators.set(req.spectatorId, {
          name: req.spectatorName || '관전자',
          updatedAt: Date.now(),
        });
        const count = this.activeSpectators.size;
        this.roleInfo.spectatorCount = count;
        this.hostedRoom.spectatorCount = count;
        this.publishHostedRoomListing();
        this.sendRoomPacket('spectator_count', { roomCode: req.roomCode, count });
        this.callbacks.onSpectatorCountUpdated?.(count);

        // Strip playerChatToken so spectators never possess the private player chat token
        const safeInit: OnlineMatchInitPayload = { ...this.lastMatchInit };
        delete safeInit.playerChatToken;

        const welcome: SpectateWelcomePayload = {
          roomCode: req.roomCode,
          matchInit: safeInit,
          snapshot: this.callbacks.onSyncRequested(),
          spectatorCount: count,
        };
        this.transport.publish(this.directTopic(req.spectatorId), this.makeEnvelope('spectate_welcome', welcome));
        break;
      }

      case 'spectator_hb': {
        if (!this.roleInfo?.isHost || this.phase !== 'in_game') return;
        const p = env.payload as { roomCode?: string; spectatorId?: string };
        if (!p?.spectatorId || p.roomCode !== this.activeRoomCode) return;
        const existing = this.activeSpectators.get(p.spectatorId);
        if (existing) {
          existing.updatedAt = Date.now();
        } else {
          this.activeSpectators.set(p.spectatorId, { name: '관전자', updatedAt: Date.now() });
          const count = this.activeSpectators.size;
          this.roleInfo.spectatorCount = count;
          if (this.hostedRoom) {
            this.hostedRoom.spectatorCount = count;
            this.publishHostedRoomListing();
          }
          this.sendRoomPacket('spectator_count', { roomCode: this.activeRoomCode, count });
          this.callbacks.onSpectatorCountUpdated?.(count);
        }
        break;
      }

      case 'spectator_leave': {
        if (!this.roleInfo?.isHost || this.phase !== 'in_game') return;
        const p = env.payload as { roomCode?: string; spectatorId?: string };
        if (p?.spectatorId && this.activeSpectators.delete(p.spectatorId)) {
          const count = this.activeSpectators.size;
          this.roleInfo.spectatorCount = count;
          if (this.hostedRoom) {
            this.hostedRoom.spectatorCount = count;
            this.publishHostedRoomListing();
          }
          if (this.activeRoomCode) {
            this.sendRoomPacket('spectator_count', { roomCode: this.activeRoomCode, count });
          }
          this.callbacks.onSpectatorCountUpdated?.(count);
        }
        break;
      }

      case 'spectator_count': {
        if (!isPlayerOrSpectator) return;
        const p = env.payload as { roomCode?: string; count?: number };
        if (p && typeof p.count === 'number') {
          if (this.roleInfo) this.roleInfo.spectatorCount = p.count;
          this.callbacks.onSpectatorCountUpdated?.(p.count);
        }
        break;
      }

      case 'admin_stealth_inspect': {
        void this.handleIncomingAdminStealthInspect(env.payload as SignedAdminStealthInspectPayload);
        break;
      }

      case 'match_start': {
        if (this.adminMode && this.sessionRole === 'admin_stealth') {
          void this.handleAdminStealthMatchUpdate(env.payload as OnlineMatchInitPayload);
        } else {
          void this.handleMatchStartPacket(env.payload as OnlineMatchInitPayload, false);
        }
        break;
      }

      case 'move': {
        if (!isPlayerOrSpectator) return;
        this.callbacks.onRemoteMove(env.payload as MovePacketPayload);
        break;
      }

      case 'pass': {
        if (!isPlayerOrSpectator) return;
        this.callbacks.onRemotePass(env.payload as PassPacketPayload);
        break;
      }

      case 'dead_toggle': {
        if (!isPlayerOrSpectator) return;
        this.resetScoreAgreement();
        this.callbacks.onRemoteDeadToggle(env.payload as DeadTogglePacketPayload);
        this.callbacks.onScoreAgreementChanged(this.getScoreAgreement());
        break;
      }

      case 'score_agree': {
        if (!isPlayerOrSpectator) return;
        const p = env.payload as ScoreAgreePacketPayload;
        const maskKey = p.deadIndices.slice().sort((a, b) => a - b).join(',');
        if (this.lastAgreedMaskKey && this.lastAgreedMaskKey !== maskKey) {
          this.scoreAgreement = { blackAgreed: false, whiteAgreed: false };
        }
        this.lastAgreedMaskKey = maskKey;
        if (p.color === BLACK) this.scoreAgreement.blackAgreed = true;
        else this.scoreAgreement.whiteAgreed = true;

        this.callbacks.onScoreAgreementChanged(this.getScoreAgreement(), p.deadIndices);
        if (this.scoreAgreement.blackAgreed && this.scoreAgreement.whiteAgreed) {
          this.callbacks.onScoreBothAgreed();
        }
        break;
      }

      case 'score_resume': {
        if (!isPlayerOrSpectator) return;
        const p = env.payload as { color: PlayerColor };
        this.resetScoreAgreement();
        this.callbacks.onRemoteScoreResume(p.color);
        break;
      }

      case 'resign': {
        if (!isPlayerOrSpectator) return;
        const p = env.payload as { color: PlayerColor };
        this.callbacks.onRemoteResign(p.color);
        break;
      }

      case 'timeout': {
        if (!isPlayerOrSpectator) return;
        const p = env.payload as { timedOutColor: PlayerColor };
        this.callbacks.onRemoteTimeout(p.timedOutColor);
        break;
      }

      case 'undo_request': {
        if (this.phase !== 'in_game' || this.sessionRole !== 'player') return;
        const p = env.payload as { requesterColor: PlayerColor; steps: number };
        this.callbacks.onUndoRequested(p.requesterColor, p.steps);
        break;
      }

      case 'undo_response': {
        if (!isPlayerOrSpectator) return;
        const p = env.payload as { accepted: boolean; steps: number; clock?: ClockSnapshot };
        if (this.phase === 'spectating' && !p.accepted) return;
        this.callbacks.onUndoResolved(p.accepted, p.steps, p.clock);
        break;
      }

      case 'rematch_request': {
        if (this.phase !== 'in_game' || this.sessionRole !== 'player') return;
        const p = env.payload as { requesterColor: PlayerColor };
        this.callbacks.onRematchRequested(p.requesterColor);
        break;
      }

      case 'rematch_response': {
        if (!isPlayerOrSpectator) return;
        const p = env.payload as { accepted: boolean; nextMatch?: OnlineMatchInitPayload };
        if (this.sessionRole === 'admin_stealth' && this.adminMode) {
          if (p.accepted && p.nextMatch) {
            void this.handleAdminStealthMatchUpdate(p.nextMatch);
          }
          return;
        }
        if (this.phase === 'spectating') {
          if (p.accepted && p.nextMatch) {
            void this.handleSpectateRematch(p.nextMatch);
          }
          return;
        }
        if (p.accepted && p.nextMatch) {
          void this.handleMatchStartPacket(p.nextMatch, true);
        } else {
          this.callbacks.onRematchDeclined();
        }
        break;
      }

      case 'chat': {
        const p = env.payload as { senderName: string; senderColor: PlayerColor; text: string };
        if (this.sessionRole === 'admin_stealth' && this.adminMode && this.activeRoomCode) {
          this.callbacks.onAdminMonitorChat?.({
            channel: 'player',
            roomCode: this.activeRoomCode,
            senderId: env.senderId,
            senderName: p.senderName || '대국자',
            senderColor: p.senderColor,
            text: p.text,
            sentAt: env.sentAt || Date.now(),
          });
          return;
        }
        // Legacy room topic chat strictly ignored by normal spectators
        if (this.phase !== 'in_game' || this.sessionRole !== 'player') return;
        this.callbacks.onRemotePlayerChat?.(p.senderName, p.senderColor, p.text);
        this.callbacks.onRemoteChat(p.senderName, p.senderColor, p.text);
        break;
      }

      case 'ping': {
        if (this.phase !== 'in_game' || this.sessionRole !== 'player') return;
        const p = env.payload as { pingSentAt: number };
        this.sendRoomPacket('pong', { pingSentAt: p.pingSentAt });
        break;
      }

      case 'pong': {
        if (this.phase !== 'in_game' || this.sessionRole !== 'player') return;
        const p = env.payload as { pingSentAt: number };
        const rtt = Math.max(1, Math.round(Date.now() - p.pingSentAt));
        this.callbacks.onLatencyUpdated(rtt);
        break;
      }

      case 'sync_request': {
        if (this.phase !== 'in_game' || !this.roleInfo?.isHost) return;
        const snap = this.callbacks.onSyncRequested();
        if (snap) {
          this.sendRoomPacket('sync_snapshot', snap);
        }
        break;
      }

      case 'sync_snapshot': {
        if (!isPlayerOrSpectator) return;
        this.callbacks.onSyncSnapshotReceived(env.payload as SyncSnapshotPayload);
        break;
      }

      case 'leave': {
        if (!isPlayerOrSpectator) return;
        if (this.hostedRoom && (!this.activeRoomCode || this.hostedRoom.roomCode === this.activeRoomCode)) {
          this.clearHostedRoomListing(this.hostedRoom.roomCode);
          this.hostedRoom = null;
        }
        const p = env.payload as { senderName?: string };
        this.callbacks.onOpponentLeft(p.senderName || this.roleInfo?.opponentName || '상대 대국자');
        break;
      }
    }
  }

  private buildGameConfigFromInit(init: OnlineMatchInitPayload, myColor: PlayerColor): GameConfig {
    return {
      boardSize: init.boardSize,
      ruleset: init.ruleset,
      gameType: init.gameType ?? 'baduk',
      omokRuleset: init.omokRuleset ?? 'renju',
      handicap: init.handicap,
      komi: init.komi,
      superko: true,
      mode: 'online',
      humanColor: myColor,
      aiDifficulty: 3,
      mainTimeSeconds: init.mainTimeSeconds,
      byoyomiSeconds: init.byoyomiSeconds,
      byoyomiPeriods: init.byoyomiPeriods,
      blackName: init.blackName,
      whiteName: init.whiteName,
      roomCode: init.roomCode,
    };
  }

  private startSpectatorPruneLoop(): void {
    if (this.spectatorPruneTimer) clearInterval(this.spectatorPruneTimer);
    this.spectatorPruneTimer = setInterval(() => {
      if (!this.roleInfo?.isHost || this.phase !== 'in_game') return;
      const now = Date.now();
      let changed = false;
      for (const [id, info] of this.activeSpectators.entries()) {
        if (now - info.updatedAt > PRESENCE_TTL_MS) {
          this.activeSpectators.delete(id);
          changed = true;
        }
      }
      if (changed && this.activeRoomCode) {
        const count = this.activeSpectators.size;
        this.roleInfo.spectatorCount = count;
        if (this.hostedRoom) {
          this.hostedRoom.spectatorCount = count;
          this.publishHostedRoomListing();
        }
        this.sendRoomPacket('spectator_count', { roomCode: this.activeRoomCode, count });
        this.callbacks.onSpectatorCountUpdated?.(count);
      }
    }, 7000);
  }

  private async handleSpectateWelcome(welcome: SpectateWelcomePayload): Promise<void> {
    if (
      this.phase !== 'joining_room' ||
      this.pendingJoinAction !== 'spectate' ||
      this.activeRoomCode !== welcome.roomCode
    ) {
      return;
    }

    if (this.joinRetryTimer) {
      clearInterval(this.joinRetryTimer);
      this.joinRetryTimer = null;
    }
    if (this.joinTimeoutTimer) {
      clearTimeout(this.joinTimeoutTimer);
      this.joinTimeoutTimer = null;
    }

    await this.transport.subscribe(this.roomTopic(welcome.roomCode));
    await this.transport.subscribe(this.spectatorChatTopic(welcome.roomCode));

    const safeInit: OnlineMatchInitPayload = { ...welcome.matchInit };
    delete safeInit.playerChatToken;

    this.sessionRole = 'spectator';
    this.lastMatchInit = safeInit;
    this.resetScoreAgreement();
    this.roleInfo = {
      roomCode: welcome.roomCode,
      isHost: false,
      myColor: BLACK,
      opponentName: safeInit.whiteName,
      opponentId: '',
      sessionRole: 'spectator',
      spectatorCount: welcome.spectatorCount,
    };

    this.setPhase('spectating', welcome.roomCode);

    if (this.spectatorHbTimer) clearInterval(this.spectatorHbTimer);
    this.spectatorHbTimer = setInterval(() => {
      if (this.phase !== 'spectating' || !this.activeRoomCode) return;
      this.sendRoomPacket('spectator_hb', {
        roomCode: this.activeRoomCode,
        spectatorId: this.profile.getClientId(),
      });
    }, 10000);

    const config = this.buildGameConfigFromInit(safeInit, BLACK);
    this.callbacks.onSpectateStart?.(config, safeInit, welcome.snapshot, welcome.spectatorCount);
  }

  private async handleSpectateRematch(nextInit: OnlineMatchInitPayload): Promise<void> {
    if (this.phase !== 'spectating' || this.sessionRole !== 'spectator') return;
    if (this.lastMatchInit?.startedAt === nextInit.startedAt) return;
    const safeInit: OnlineMatchInitPayload = { ...nextInit };
    delete safeInit.playerChatToken;
    this.lastMatchInit = safeInit;
    this.resetScoreAgreement();
    const count = this.roleInfo?.spectatorCount ?? 1;
    const config = this.buildGameConfigFromInit(safeInit, BLACK);
    this.callbacks.onSpectateStart?.(config, safeInit, null, count);
  }

  private async handleMatchStartPacket(
    init: OnlineMatchInitPayload,
    isRematch: boolean
  ): Promise<void> {
    const myId = this.profile.getClientId();
    if (init.hostId !== myId && init.guestId !== myId) return;

    // Save private chat token synchronously before any await so dual delivery
    // (directTopic + roomTopic) never overwrites or drops the secret token.
    if (init.playerChatToken) {
      this.pendingPlayerChatToken = init.playerChatToken;
      if (this.lastMatchInit && this.lastMatchInit.startedAt === init.startedAt) {
        this.lastMatchInit.playerChatToken = init.playerChatToken;
      }
    }

    if (this.activeMatchStartedAt === init.startedAt) {
      return;
    }
    this.activeMatchStartedAt = init.startedAt;

    if (this.joinRetryTimer) {
      clearInterval(this.joinRetryTimer);
      this.joinRetryTimer = null;
    }
    if (this.joinTimeoutTimer) {
      clearTimeout(this.joinTimeoutTimer);
      this.joinTimeoutTimer = null;
    }
    if (this.qmSeekTimer) {
      clearInterval(this.qmSeekTimer);
      this.qmSeekTimer = null;
    }
    await this.transport.unsubscribe(this.quickMatchTopic());

    this.activeRoomCode = init.roomCode;
    await this.transport.subscribe(this.roomTopic(init.roomCode));

    const retainedToken =
      init.playerChatToken ||
      this.pendingPlayerChatToken ||
      (isRematch ? this.lastMatchInit?.playerChatToken : undefined);
    this.lastMatchInit = { ...init, playerChatToken: retainedToken };
    this.sessionRole = 'player';
    this.resetScoreAgreement();

    const myColor: PlayerColor = init.blackId === myId ? BLACK : WHITE;
    const opponentName = myColor === BLACK ? init.whiteName : init.blackName;
    const opponentId = myColor === BLACK ? init.whiteId : init.blackId;

    this.roleInfo = {
      roomCode: init.roomCode,
      isHost: init.hostId === myId,
      myColor,
      opponentName,
      opponentId,
      sessionRole: 'player',
      spectatorCount: this.activeSpectators.size,
    };

    if (this.roleInfo.isHost && this.hostedRoom) {
      this.lastHostActivityAt = Date.now();
      this.hostedRoom.status = 'in_game';
      this.hostedRoom.blackName = init.blackName;
      this.hostedRoom.whiteName = init.whiteName;
      this.hostedRoom.moveCount = 0;
      this.hostedRoom.spectatorCount = this.activeSpectators.size;
      this.startSpectatorPruneLoop();
    }

    const config = this.buildGameConfigFromInit(init, myColor);

    this.setPhase('in_game', init.roomCode);
    if (this.roleInfo.isHost && this.hostedRoom) {
      this.publishHostedRoomListing();
    }
    this.startPingLoop();
    this.callbacks.onMatchStart(config, { ...this.roleInfo }, isRematch);
  }

  private startPingLoop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const sendPing = () => {
      if (this.phase !== 'in_game' || !this.activeRoomCode) return;
      this.sendRoomPacket('ping', { pingSentAt: Date.now() });
    };
    setTimeout(sendPing, 450);
    this.pingTimer = setInterval(sendPing, 5000);
  }

  private sendRoomPacket<T>(type: string, payload: T): void {
    if (!this.activeRoomCode) return;
    this.transport.publish(
      this.roomTopic(this.activeRoomCode),
      this.makeEnvelope(type, payload)
    );
  }

  // =========================================================================
  // Outgoing Gameplay Actions
  // =========================================================================

  public sendMove(x: number, y: number, color: PlayerColor, moveNumber: number, clock?: ClockSnapshot): void {
    if (this.phase !== 'in_game' || !this.activeRoomCode) return;
    const payload: MovePacketPayload = {
      roomCode: this.activeRoomCode,
      x,
      y,
      color,
      moveNumber,
      clock,
    };
    this.sendRoomPacket('move', payload);
  }

  public sendPass(color: PlayerColor, moveNumber: number, clock?: ClockSnapshot): void {
    if (this.phase !== 'in_game' || !this.activeRoomCode) return;
    const payload: PassPacketPayload = {
      roomCode: this.activeRoomCode,
      color,
      moveNumber,
      clock,
    };
    this.sendRoomPacket('pass', payload);
  }

  public resetScoreAgreement(): void {
    this.scoreAgreement = { blackAgreed: false, whiteAgreed: false };
    this.lastAgreedMaskKey = '';
  }

  public sendDeadToggle(x: number, y: number, deadMask: Uint8Array): void {
    if (this.phase !== 'in_game' || !this.activeRoomCode) return;
    this.resetScoreAgreement();
    const deadIndices: number[] = [];
    for (let i = 0; i < deadMask.length; i++) {
      if (deadMask[i]) deadIndices.push(i);
    }
    const payload: DeadTogglePacketPayload = {
      roomCode: this.activeRoomCode,
      x,
      y,
      deadIndices,
    };
    this.sendRoomPacket('dead_toggle', payload);
    this.callbacks.onScoreAgreementChanged(this.getScoreAgreement());
  }

  public sendScoreAgree(deadMask: Uint8Array): void {
    if (this.phase !== 'in_game' || !this.activeRoomCode || !this.roleInfo) return;
    const deadIndices: number[] = [];
    for (let i = 0; i < deadMask.length; i++) {
      if (deadMask[i]) deadIndices.push(i);
    }
    const maskKey = deadIndices.join(',');
    if (this.lastAgreedMaskKey && this.lastAgreedMaskKey !== maskKey) {
      this.scoreAgreement = { blackAgreed: false, whiteAgreed: false };
    }
    this.lastAgreedMaskKey = maskKey;

    const myColor = this.roleInfo.myColor;
    if (myColor === BLACK) this.scoreAgreement.blackAgreed = true;
    else this.scoreAgreement.whiteAgreed = true;

    const payload: ScoreAgreePacketPayload = {
      roomCode: this.activeRoomCode,
      color: myColor,
      deadIndices,
    };
    this.sendRoomPacket('score_agree', payload);
    this.callbacks.onScoreAgreementChanged(this.getScoreAgreement());

    if (this.scoreAgreement.blackAgreed && this.scoreAgreement.whiteAgreed) {
      this.callbacks.onScoreBothAgreed();
    }
  }

  public sendScoreResume(): void {
    if (this.phase !== 'in_game' || !this.activeRoomCode || !this.roleInfo) return;
    this.resetScoreAgreement();
    this.sendRoomPacket('score_resume', { color: this.roleInfo.myColor });
  }

  public sendResign(color: PlayerColor): void {
    if (this.phase !== 'in_game' || !this.activeRoomCode) return;
    this.sendRoomPacket('resign', { color });
  }

  public sendTimeout(timedOutColor: PlayerColor): void {
    if (this.phase !== 'in_game' || !this.activeRoomCode) return;
    this.sendRoomPacket('timeout', { timedOutColor });
  }

  public requestUndo(steps: number): void {
    if (this.phase !== 'in_game' || !this.activeRoomCode || !this.roleInfo) return;
    this.sendRoomPacket('undo_request', {
      requesterColor: this.roleInfo.myColor,
      steps,
    });
  }

  public respondUndo(accepted: boolean, steps: number, clock?: ClockSnapshot): void {
    if (this.phase !== 'in_game' || !this.activeRoomCode) return;
    this.sendRoomPacket('undo_response', { accepted, steps, clock });
  }

  public requestRematch(): void {
    if (this.phase !== 'in_game' || !this.activeRoomCode || !this.roleInfo) return;
    this.sendRoomPacket('rematch_request', { requesterColor: this.roleInfo.myColor });
  }

  public respondRematch(accepted: boolean): void {
    if (
      this.phase !== 'in_game' ||
      this.sessionRole !== 'player' ||
      !this.activeRoomCode ||
      !this.lastMatchInit ||
      !this.roleInfo
    ) {
      return;
    }
    if (!accepted) {
      this.sendRoomPacket('rematch_response', { accepted: false });
      return;
    }

    // Swap Black and White colors on rematch!
    const prev = this.lastMatchInit;
    const token = prev.playerChatToken || generateChatToken();
    const nextPublic: OnlineMatchInitPayload = {
      ...prev,
      blackId: prev.whiteId,
      whiteId: prev.blackId,
      blackName: prev.whiteName,
      whiteName: prev.blackName,
      startedAt: Date.now(),
    };
    delete nextPublic.playerChatToken;

    const nextForPlayers: OnlineMatchInitPayload = {
      ...nextPublic,
      playerChatToken: token,
    };

    // Send secret token ONLY directly to opponent; broadcast tokenless init on roomTopic for spectators
    this.lastHostActivityAt = Date.now();
    this.transport.publish(
      this.directTopic(this.roleInfo.opponentId),
      this.makeEnvelope('rematch_response', { accepted: true, nextMatch: nextForPlayers })
    );
    this.sendRoomPacket('rematch_response', { accepted: true, nextMatch: nextPublic });
    void this.handleMatchStartPacket(nextForPlayers, true);
  }

  public sendPlayerChat(text: string): boolean {
    if (
      this.phase !== 'in_game' ||
      this.sessionRole !== 'player' ||
      !this.activeRoomCode ||
      !this.roleInfo ||
      !this.roleInfo.opponentId
    ) {
      return false;
    }
    const token = this.lastMatchInit?.playerChatToken;
    if (!token) return false;

    const trimmed = text.trim().slice(0, 120);
    if (!trimmed) return false;

    // Published strictly 1:1 to opponent's directTopic with token (spectators never receive)
    this.transport.publish(
      this.directTopic(this.roleInfo.opponentId),
      this.makeEnvelope('player_chat', {
        roomCode: this.activeRoomCode,
        token,
        senderName: this.profile.getNickname(),
        senderColor: this.roleInfo.myColor,
        text: trimmed,
      })
    );
    return true;
  }

  public sendSpectatorChat(text: string): boolean {
    if (
      this.phase !== 'spectating' ||
      this.sessionRole !== 'spectator' ||
      !this.activeRoomCode
    ) {
      return false;
    }
    const trimmed = text.trim().slice(0, 120);
    if (!trimmed) return false;

    // Published strictly to spectator-only topic (players never subscribe or receive)
    this.transport.publish(
      this.spectatorChatTopic(this.activeRoomCode),
      this.makeEnvelope('spectator_chat', {
        roomCode: this.activeRoomCode,
        senderName: this.profile.getNickname(),
        text: trimmed,
      })
    );
    return true;
  }

  public sendChat(text: string): void {
    if (this.sessionRole === 'spectator') {
      this.sendSpectatorChat(text);
    } else if (this.sessionRole === 'player') {
      this.sendPlayerChat(text);
    }
  }

  public getInviteUrl(): string {
    if (!this.activeRoomCode || typeof window === 'undefined') return '';
    const url = new URL(window.location.href);
    url.searchParams.set('room', this.activeRoomCode);
    return url.toString();
  }

  // =========================================================================
  // Admin Console Signed Verification, Enforcement & Stealth Monitoring
  // =========================================================================

  private async handleSignedBanRegistry(rawData: unknown): Promise<void> {
    if (rawData === null) {
      this.banRegistry = [];
      this.callbacks.onBanRegistryChanged?.([]);
      return;
    }
    const p = rawData as Partial<SignedBanRegistryPayload> | null;
    if (
      !p ||
      typeof p.version !== 'number' ||
      typeof p.updatedAt !== 'number' ||
      !Array.isArray(p.bans) ||
      typeof p.signature !== 'string'
    ) {
      return;
    }

    const ok = await verifyAdminSignature(
      { version: p.version, updatedAt: p.updatedAt, bans: p.bans },
      p.signature
    );
    if (!ok) return;

    this.banRegistry = p.bans.filter((b) => isBanActive(b));
    this.callbacks.onBanRegistryChanged?.(this.getBanRegistry());
    if (!this.adminMode) {
      this.enforceBanOnSelf();
    }
  }

  private async handleSignedClosedRooms(rawData: unknown): Promise<void> {
    if (rawData === null) {
      this.closedRooms = [];
      this.callbacks.onClosedRoomsChanged?.([]);
      return;
    }
    const p = rawData as Partial<SignedClosedRoomsPayload> | null;
    if (
      !p ||
      typeof p.version !== 'number' ||
      typeof p.updatedAt !== 'number' ||
      !Array.isArray(p.closedRooms) ||
      typeof p.signature !== 'string'
    ) {
      return;
    }

    const ok = await verifyAdminSignature(
      { version: p.version, updatedAt: p.updatedAt, closedRooms: p.closedRooms },
      p.signature
    );
    if (!ok) return;

    const now = Date.now();
    this.closedRooms = p.closedRooms.filter(
      (entry) =>
        entry &&
        typeof entry.roomCode === 'string' &&
        typeof entry.expiresAt === 'number' &&
        entry.expiresAt > now
    );

    let removedOpen = false;
    for (const entry of this.closedRooms) {
      if (this.openRooms.delete(entry.roomCode)) {
        removedOpen = true;
      }
      if (this.adminMode && this.transport.isConnected()) {
        this.transport.publish(this.lobbyRoomTopic(entry.roomCode), null, { retain: true });
      }
    }
    if (removedOpen) {
      this.emitOpenRooms();
    }

    this.callbacks.onClosedRoomsChanged?.(this.getClosedRooms(now));

    if (!this.adminMode && this.activeRoomCode && this.isRoomClosedByAdmin(this.activeRoomCode, now)) {
      if (this.hostedRoom && this.hostedRoom.roomCode === this.activeRoomCode) {
        this.clearHostedRoomListing(this.activeRoomCode);
        this.hostedRoom = null;
      }
      await this.cancelMatchmakingOrRoom();
      this.callbacks.onRoomForceClosed?.('관리자에 의해 닫힌 대국방입니다.');
    }
  }

  private async handleSignedForceClose(raw: SignedAdminForceClosePayload): Promise<void> {
    if (
      !raw ||
      raw.action !== 'admin_force_close' ||
      typeof raw.roomCode !== 'string' ||
      typeof raw.reason !== 'string' ||
      typeof raw.issuedAt !== 'number' ||
      typeof raw.signature !== 'string'
    ) {
      return;
    }
    if (Math.abs(Date.now() - raw.issuedAt) > ADMIN_CMD_MAX_AGE_MS) {
      return;
    }

    const ok = await verifyAdminSignature(
      {
        action: 'admin_force_close',
        roomCode: raw.roomCode,
        reason: raw.reason,
        issuedAt: raw.issuedAt,
      },
      raw.signature
    );
    if (!ok) return;

    if (this.openRooms.delete(raw.roomCode)) {
      this.emitOpenRooms();
    }

    if (this.activeRoomCode !== raw.roomCode) return;

    if (this.hostedRoom && this.hostedRoom.roomCode === raw.roomCode) {
      this.clearHostedRoomListing(raw.roomCode);
      this.hostedRoom = null;
    }

    const wasAdmin = this.adminMode;
    await this.cancelMatchmakingOrRoom();
    if (!wasAdmin) {
      this.callbacks.onRoomForceClosed?.(raw.reason || '관리자에 의해 대국방이 강제 종료되었습니다.');
    }
  }

  private async handleIncomingAdminStealthInspect(
    raw: SignedAdminStealthInspectPayload
  ): Promise<void> {
    if (
      !raw ||
      raw.action !== 'admin_stealth_inspect' ||
      typeof raw.roomCode !== 'string' ||
      typeof raw.adminId !== 'string' ||
      typeof raw.timestamp !== 'number' ||
      typeof raw.signature !== 'string'
    ) {
      return;
    }
    if (!this.hostedRoom || this.hostedRoom.roomCode !== raw.roomCode) {
      return;
    }
    if (Math.abs(Date.now() - raw.timestamp) > ADMIN_CMD_MAX_AGE_MS) {
      return;
    }

    const ok = await verifyAdminSignature(
      {
        action: 'admin_stealth_inspect',
        roomCode: raw.roomCode,
        adminId: raw.adminId,
        timestamp: raw.timestamp,
      },
      raw.signature
    );
    if (!ok) return;

    // Zero-notice, passwordless stealth response:
    // NEVER verify password, NEVER touch activeSpectators or spectatorCount, NEVER notify players/spectators
    let safeInit: OnlineMatchInitPayload | undefined;
    if (this.lastMatchInit) {
      safeInit = { ...this.lastMatchInit };
      delete safeInit.playerChatToken;
    }

    const welcome: AdminStealthWelcomePayload = {
      roomCode: raw.roomCode,
      roomStatus: this.hostedRoom.status,
      roomListing: { ...this.hostedRoom },
      hostId: this.profile.getClientId(),
      guestId: this.lastMatchInit?.guestId || '',
      matchInit: safeInit,
      snapshot: this.phase === 'in_game' ? this.callbacks.onSyncRequested() : null,
    };

    this.transport.publish(
      this.directTopic(raw.adminId),
      this.makeEnvelope('admin_stealth_welcome', welcome)
    );
  }

  private async handleAdminStealthWelcome(welcome: AdminStealthWelcomePayload): Promise<void> {
    if (!this.adminMode || this.sessionRole !== 'admin_stealth') return;
    if (!welcome || welcome.roomCode !== this.activeRoomCode) return;

    this.stealthWelcomeReceived = true;
    if (this.stealthJoinTimeout) {
      clearTimeout(this.stealthJoinTimeout);
      this.stealthJoinTimeout = null;
    }
    if (this.stealthInspectRetryTimer) {
      clearTimeout(this.stealthInspectRetryTimer);
      this.stealthInspectRetryTimer = null;
    }
    if (this.stealthSyncFallbackTimer) {
      clearTimeout(this.stealthSyncFallbackTimer);
      this.stealthSyncFallbackTimer = null;
    }

    this.stealthTargetHostId = welcome.hostId;
    if (welcome.hostId) {
      await this.transport.subscribe(this.directTopic(welcome.hostId));
    }
    if (welcome.guestId) {
      this.stealthTargetGuestId = welcome.guestId;
      await this.transport.subscribe(this.directTopic(welcome.guestId));
    }

    await this.transport.subscribe(this.roomTopic(welcome.roomCode));
    await this.transport.subscribe(this.spectatorChatTopic(welcome.roomCode));

    if (welcome.matchInit) {
      const safeInit: OnlineMatchInitPayload = { ...welcome.matchInit };
      delete safeInit.playerChatToken;
      this.lastMatchInit = safeInit;
      this.resetScoreAgreement();
      this.roleInfo = {
        roomCode: welcome.roomCode,
        isHost: false,
        myColor: BLACK,
        opponentName: safeInit.whiteName,
        opponentId: '',
        sessionRole: 'admin_stealth',
        spectatorCount: welcome.roomListing?.spectatorCount ?? 0,
      };
      this.setPhase('spectating', welcome.roomCode);
      const config = this.buildGameConfigFromInit(safeInit, BLACK);
      this.callbacks.onSpectateStart?.(
        config,
        safeInit,
        welcome.snapshot ?? null,
        welcome.roomListing?.spectatorCount ?? 0
      );
    } else if (this.phase !== 'spectating') {
      this.setPhase('spectating', welcome.roomCode);
    }

    this.callbacks.onAdminStealthJoined?.(welcome);
  }

  private async handleAdminStealthMatchUpdate(init: OnlineMatchInitPayload): Promise<void> {
    if (!this.adminMode || this.sessionRole !== 'admin_stealth' || !this.activeRoomCode) return;
    if (init.roomCode !== this.activeRoomCode) return;
    if (this.lastMatchInit?.startedAt === init.startedAt) return;

    if (init.guestId && init.guestId !== this.stealthTargetGuestId) {
      this.stealthTargetGuestId = init.guestId;
      await this.transport.subscribe(this.directTopic(init.guestId));
    }
    if (init.hostId && init.hostId !== this.stealthTargetHostId) {
      this.stealthTargetHostId = init.hostId;
      await this.transport.subscribe(this.directTopic(init.hostId));
    }

    const safeInit: OnlineMatchInitPayload = { ...init };
    delete safeInit.playerChatToken;
    this.lastMatchInit = safeInit;
    this.resetScoreAgreement();
    this.roleInfo = {
      roomCode: init.roomCode,
      isHost: false,
      myColor: BLACK,
      opponentName: safeInit.whiteName,
      opponentId: '',
      sessionRole: 'admin_stealth',
      spectatorCount: this.roleInfo?.spectatorCount ?? 0,
    };
    this.setPhase('spectating', init.roomCode);
    const config = this.buildGameConfigFromInit(safeInit, BLACK);
    this.callbacks.onSpectateStart?.(config, safeInit, null, this.roleInfo.spectatorCount ?? 0);
  }

  public async adminInitializeMonitoring(): Promise<void> {
    if (!this.adminMode) return;
    await this.startPresenceTracking();
    await this.startWatchingLobby();
  }

  public async adminPublishBanRegistry(
    bans: AdminBanEntry[],
    signFn: (canonicalJson: string) => Promise<string>
  ): Promise<SignedBanRegistryPayload> {
    await this.ensureConnected();
    const version = Date.now();
    const updatedAt = version;
    const unsigned = { version, updatedAt, bans };
    const signature = await signFn(canonicalizePayload(unsigned));
    const signed: SignedBanRegistryPayload = { ...unsigned, signature };
    this.banRegistry = bans.filter((b) => isBanActive(b));
    this.transport.publish(this.adminBansTopic(), signed, { retain: true });
    this.callbacks.onBanRegistryChanged?.(this.getBanRegistry());
    return signed;
  }

  public async adminPublishClosedRooms(
    entries: AdminClosedRoomEntry[],
    signFn: (canonicalJson: string) => Promise<string>
  ): Promise<SignedClosedRoomsPayload> {
    await this.ensureConnected();
    const now = Date.now();
    const dedup = new Map<string, AdminClosedRoomEntry>();
    for (const entry of entries) {
      if (!entry || typeof entry.roomCode !== 'string' || entry.expiresAt <= now) continue;
      const code = normalizeRoomCode(entry.roomCode);
      if (!code) continue;
      const prev = dedup.get(code);
      if (!prev || entry.closedAt >= prev.closedAt) {
        dedup.set(code, { ...entry, roomCode: code });
      }
    }
    const cleaned = Array.from(dedup.values()).sort((a, b) => b.closedAt - a.closedAt);
    const version = now;
    const updatedAt = now;
    const unsigned = { version, updatedAt, closedRooms: cleaned };
    const signature = await signFn(canonicalizePayload(unsigned));
    const signed: SignedClosedRoomsPayload = { ...unsigned, signature };
    this.closedRooms = cleaned;
    this.transport.publish(this.adminClosedRoomsTopic(), signed, { retain: true });

    let removed = false;
    for (const entry of cleaned) {
      if (this.openRooms.delete(entry.roomCode)) {
        removed = true;
      }
      this.transport.publish(this.lobbyRoomTopic(entry.roomCode), null, { retain: true });
    }
    if (removed) {
      this.emitOpenRooms();
    }
    this.callbacks.onClosedRoomsChanged?.(this.getClosedRooms(now));
    return signed;
  }

  public async adminForceCloseRoom(
    rawCode: string,
    reason: string,
    signFn: (canonicalJson: string) => Promise<string>
  ): Promise<SignedClosedRoomsPayload> {
    const roomCode = normalizeRoomCode(rawCode);
    if (!roomCode) throw new Error('유효한 방 코드가 아닙니다.');
    const existing = this.openRooms.get(roomCode);
    if (this.activeRoomCode === roomCode) {
      await this.cancelMatchmakingOrRoom();
    }
    await this.ensureConnected();
    const now = Date.now();
    const cleanReason = reason.trim() || '관리자에 의해 방이 종료되었습니다.';
    const unsigned = {
      action: 'admin_force_close' as const,
      roomCode,
      reason: cleanReason,
      issuedAt: now,
    };
    const signature = await signFn(canonicalizePayload(unsigned));
    const signedClose: SignedAdminForceClosePayload = { ...unsigned, signature };
    this.transport.publish(this.adminEventsTopic(), this.makeEnvelope('admin_force_close', signedClose));
    // Also publish leave on roomTopic so legacy v3.0 clients terminate their session cleanly
    this.transport.publish(
      this.roomTopic(roomCode),
      this.makeEnvelope('leave', { roomCode, senderName: '관리자 시스템 (방 종료)' })
    );
    this.transport.publish(this.lobbyRoomTopic(roomCode), null, { retain: true });
    if (this.openRooms.delete(roomCode)) {
      this.emitOpenRooms();
    }

    const nextEntries = [
      ...this.getClosedRooms(now).filter((e) => e.roomCode !== roomCode),
      {
        roomCode,
        hostId: existing?.hostId,
        title: existing?.title,
        reason: cleanReason,
        closedAt: now,
        expiresAt: now + CLOSED_ROOM_TTL_MS,
      },
    ];
    return await this.adminPublishClosedRooms(nextEntries, signFn);
  }

  public async adminReopenClosedRoom(
    rawCode: string,
    signFn: (canonicalJson: string) => Promise<string>
  ): Promise<SignedClosedRoomsPayload> {
    const roomCode = normalizeRoomCode(rawCode);
    if (!roomCode) throw new Error('유효한 방 코드가 아닙니다.');
    const next = this.getClosedRooms().filter((e) => e.roomCode !== roomCode);
    return await this.adminPublishClosedRooms(next, signFn);
  }

  public async adminStealthJoinRoom(
    roomOrCode: RoomSummary | string,
    signFn: (canonicalJson: string) => Promise<string>
  ): Promise<void> {
    if (!this.adminMode) {
      throw new Error('관리자 전용 패키지에서만 은밀 관전이 가능합니다.');
    }

    let room: RoomSummary;
    if (typeof roomOrCode === 'string') {
      const code = normalizeRoomCode(roomOrCode);
      if (!code) throw new Error('올바른 방 코드를 입력해 주세요.');
      room = this.openRooms.get(code) ?? {
        roomCode: code,
        title: `대국방 ${code}`,
        hostId: '',
        hostName: '방장',
        isPublic: false,
        hasPassword: true,
        status: 'in_game',
        moveCount: 0,
        spectatorCount: 0,
        boardSize: 19,
        ruleset: 'korean',
        gameType: 'baduk',
        omokRuleset: 'renju',
        handicap: 0,
        komi: 6.5,
        mainTimeSeconds: 600,
        byoyomiSeconds: 30,
        byoyomiPeriods: 3,
        hostColorPref: 'random',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    } else {
      room = roomOrCode;
    }

    await this.cancelMatchmakingOrRoom();
    const seq = ++this.sessionSeq;
    await this.ensureConnected();
    if (seq !== this.sessionSeq) return;

    this.activeRoomCode = room.roomCode;
    this.sessionRole = 'admin_stealth';
    this.stealthWelcomeReceived = false;
    this.stealthTargetHostId = room.hostId || '';
    this.stealthTargetGuestId = '';

    await this.transport.subscribe(this.roomTopic(room.roomCode));
    await this.transport.subscribe(this.spectatorChatTopic(room.roomCode));
    if (room.hostId) {
      await this.transport.subscribe(this.directTopic(room.hostId));
    }

    // Immediate 0ms zero-latency stealth entry into 3D board using RoomSummary metadata
    // (works for waiting rooms, live v4 rooms, and legacy v3.0 rooms without blocking)
    const isWaiting = room.status === 'waiting';
    const initialInit: OnlineMatchInitPayload = {
      roomCode: room.roomCode,
      hostId: room.hostId || '',
      guestId: '',
      blackId: room.hostId || '',
      whiteId: '',
      blackName: isWaiting
        ? `${room.hostName || '방장'} (대기 중)`
        : room.blackName || room.hostName || '흑 대국자',
      whiteName: isWaiting ? '도전자 대기 중' : room.whiteName || '백 대국자',
      gameType: room.gameType ?? 'baduk',
      omokRuleset: room.omokRuleset ?? 'renju',
      boardSize: room.boardSize,
      ruleset: room.ruleset,
      handicap: room.handicap,
      komi: room.komi,
      mainTimeSeconds: room.mainTimeSeconds,
      byoyomiSeconds: room.byoyomiSeconds,
      byoyomiPeriods: room.byoyomiPeriods,
      startedAt: room.createdAt || Date.now(),
    };

    this.lastMatchInit = initialInit;
    this.resetScoreAgreement();
    this.roleInfo = {
      roomCode: room.roomCode,
      isHost: false,
      myColor: BLACK,
      opponentName: initialInit.whiteName,
      opponentId: '',
      sessionRole: 'admin_stealth',
      spectatorCount: room.spectatorCount ?? 0,
    };
    this.setPhase('spectating', room.roomCode);

    const immediateConfig = this.buildGameConfigFromInit(initialInit, BLACK);
    this.callbacks.onSpectateStart?.(
      immediateConfig,
      initialInit,
      null,
      room.spectatorCount ?? 0
    );
    this.callbacks.onAdminStealthJoined?.({
      roomCode: room.roomCode,
      roomStatus: room.status,
      roomListing: { ...room },
      hostId: room.hostId || '',
      guestId: '',
      matchInit: isWaiting ? undefined : initialInit,
      snapshot: null,
    });

    const timestamp = Date.now();
    const adminId = this.profile.getClientId();
    const unsigned = {
      action: 'admin_stealth_inspect' as const,
      roomCode: room.roomCode,
      adminId,
      timestamp,
    };
    const signature = await signFn(canonicalizePayload(unsigned));
    const signed: SignedAdminStealthInspectPayload = { ...unsigned, signature };

    const publishInspect = () => {
      if (seq !== this.sessionSeq || this.sessionRole !== 'admin_stealth') return;
      if (this.stealthTargetHostId) {
        this.transport.publish(
          this.directTopic(this.stealthTargetHostId),
          this.makeEnvelope('admin_stealth_inspect', signed)
        );
      }
      this.transport.publish(
        this.roomTopic(room.roomCode),
        this.makeEnvelope('admin_stealth_inspect', signed)
      );
    };

    publishInspect();

    this.stealthInspectRetryTimer = setTimeout(() => {
      if (
        seq === this.sessionSeq &&
        this.sessionRole === 'admin_stealth' &&
        this.activeRoomCode === room.roomCode &&
        !this.stealthWelcomeReceived
      ) {
        publishInspect();
      }
    }, 1500);

    // Silent board snapshot fallback for legacy v3.0 hosts or delayed inspect replies
    this.stealthSyncFallbackTimer = setTimeout(() => {
      if (
        seq === this.sessionSeq &&
        this.sessionRole === 'admin_stealth' &&
        this.activeRoomCode === room.roomCode &&
        !this.stealthWelcomeReceived &&
        room.status === 'in_game'
      ) {
        this.sendRoomPacket('sync_request', { roomCode: room.roomCode });
      }
    }, 900);
  }
}
