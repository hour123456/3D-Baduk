import { BLACK, WHITE, BoardSize, GameConfig, GameType, OmokRulesetType, PlayerColor } from '../rules/types';
import { ClockSnapshot } from '../rules/clock';
import { ProfileManager } from '../profile/ProfileManager';
import {
  CreateRoomOptions,
  DeadTogglePacketPayload,
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
  SyncSnapshotPayload,
} from './types';

const TOPIC_PREFIX = 'sudam-3d-baduk-v1';
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_TTL_MS = 25000;
const PRESENCE_TTL_MS = 28000;

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
  password?: string;
}

interface SpectateJoinReqPayload {
  roomCode: string;
  spectatorId: string;
  spectatorName: string;
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

  // Spectator & presence state
  private pendingJoinAction: 'join' | 'spectate' = 'join';
  private activeSpectators = new Map<string, { name: string; updatedAt: number }>();
  private spectatorHbTimer: ReturnType<typeof setInterval> | null = null;
  private spectatorPruneTimer: ReturnType<typeof setInterval> | null = null;

  private presenceTracking = false;
  private presencePeers = new Map<string, { activity: PresenceActivity; updatedAt: number }>();
  private presenceHbTimer: ReturnType<typeof setInterval> | null = null;
  private presencePruneTimer: ReturnType<typeof setInterval> | null = null;

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
    callbacks: OnlineMatchCallbacks
  ) {
    this.profile = profile;
    this.transport = transport;
    this.callbacks = callbacks;

    this.transport.onStatusChange((status, label) => {
      this.callbacks.onStatusChange(status, label);
      if (status === 'connected' && this.phase === 'in_game' && this.activeRoomCode) {
        this.sendRoomPacket('sync_request', { roomCode: this.activeRoomCode });
      }
    });

    this.transport.onMessage((topic, data) => {
      this.handleIncomingMessage(topic, data);
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        if (this.presenceTracking && this.transport.isConnected()) {
          this.transport.publish(
            this.presenceTopic(),
            this.makeEnvelope('presence_bye', { clientId: this.profile.getClientId() })
          );
        }
        this.leaveCurrentSession(true);
      });
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

  public async ensureConnected(): Promise<void> {
    await this.transport.connect();
    await this.transport.subscribe(this.directTopic(this.profile.getClientId()));
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
      this.publishPresenceHeartbeat();
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
    this.publishPresenceHeartbeat();
    this.emitPresenceStats();
    this.presenceHbTimer = setInterval(() => this.publishPresenceHeartbeat(), 10000);
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
      this.transport.publish(
        this.presenceTopic(),
        this.makeEnvelope('presence_bye', { clientId: this.profile.getClientId() })
      );
      void this.transport.unsubscribe(this.presenceTopic());
    }
    this.presenceTracking = false;
    this.presencePeers.clear();
  }

  private publishPresenceHeartbeat(): void {
    if (!this.presenceTracking || !this.transport.isConnected()) return;
    this.transport.publish(
      this.presenceTopic(),
      this.makeEnvelope('presence_hb', {
        clientId: this.profile.getClientId(),
        activity: this.getMyPresenceActivity(),
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

    if (this.presenceTracking) {
      onlineUsers = 1;
      const myActivity = this.getMyPresenceActivity();
      if (myActivity === 'playing') inGameUsers++;
      else if (myActivity === 'spectating') spectatingUsers++;
    }

    for (const [id, entry] of this.presencePeers.entries()) {
      if (id === myId) continue;
      if (now - entry.updatedAt > PRESENCE_TTL_MS) {
        this.presencePeers.delete(id);
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
    const list = Array.from(this.openRooms.values())
      .filter((r) => r.hostId !== myId && Date.now() - r.updatedAt <= ROOM_TTL_MS)
      .sort((a, b) => b.createdAt - a.createdAt);
    this.callbacks.onOpenRoomsUpdated(list);
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
    this.hostedRoom.hostName = this.profile.getNickname();
    this.hostedRoom.spectatorCount = this.activeSpectators.size;
    this.hostedRoom.updatedAt = Date.now();
    this.transport.publish(this.lobbyRoomTopic(this.hostedRoom.roomCode), this.hostedRoom, {
      retain: true,
    });
  }

  public updateHostMoveCount(moveCount: number): void {
    if (!this.hostedRoom || !this.roleInfo?.isHost || this.phase !== 'in_game') return;
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
    await this.transport.subscribe(this.roomTopic(roomCode));

    const sendReq = () => {
      if (this.phase !== 'joining_room' || this.activeRoomCode !== roomCode) return;
      const req: RoomJoinReqPayload = {
        roomCode,
        guestId: this.profile.getClientId(),
        guestName: this.profile.getNickname(),
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
    await this.transport.subscribe(this.roomTopic(roomCode));
    await this.transport.subscribe(this.spectatorChatTopic(roomCode));

    const sendReq = () => {
      if (this.phase !== 'joining_room' || this.activeRoomCode !== roomCode) return;
      const req: SpectateJoinReqPayload = {
        roomCode,
        spectatorId: this.profile.getClientId(),
        spectatorName: this.profile.getNickname(),
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

    const prevHosted = this.hostedRoom;
    const prevRoomCode = this.activeRoomCode;
    const wasInGame = this.phase === 'in_game';
    const wasSpectating = this.phase === 'spectating';

    this.hostedRoom = null;
    this.hostRoomPassword = '';
    this.activeSpectators.clear();
    this.activeRoomCode = null;
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
    } else if (this.phase === 'spectating' && this.activeRoomCode) {
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

    // Web live concurrent user presence packets
    if (topic === this.presenceTopic()) {
      if (env.type === 'presence_hb') {
        const p = env.payload as { clientId?: string; activity?: PresenceActivity };
        if (p?.clientId) {
          this.presencePeers.set(p.clientId, {
            activity: p.activity ?? 'lobby',
            updatedAt: Date.now(),
          });
          this.emitPresenceStats();
        }
      } else if (env.type === 'presence_bye') {
        const p = env.payload as { clientId?: string };
        if (p?.clientId && this.presencePeers.delete(p.clientId)) {
          this.emitPresenceStats();
        }
      } else if (env.type === 'presence_req') {
        this.publishPresenceHeartbeat();
      }
      return;
    }

    // Spectator-only isolated chat channel (players NEVER process this topic)
    if (this.activeRoomCode && topic === this.spectatorChatTopic(this.activeRoomCode)) {
      if (
        this.phase === 'spectating' &&
        this.sessionRole === 'spectator' &&
        env.type === 'spectator_chat'
      ) {
        const p = env.payload as { roomCode?: string; senderName?: string; text?: string };
        if (p && p.roomCode === this.activeRoomCode && typeof p.text === 'string' && p.text.trim()) {
          this.callbacks.onRemoteSpectatorChat?.(
            p.senderName || '관전자',
            env.senderId,
            p.text
          );
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

    // Room messages
    if (this.activeRoomCode && topic === this.roomTopic(this.activeRoomCode)) {
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
    this.hostedRoom = {
      roomCode: accept.roomCode,
      title: `빠른 매칭 (${blackName} vs ${whiteName})`,
      hostId: myId,
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

      case 'match_start': {
        void this.handleMatchStartPacket(env.payload as OnlineMatchInitPayload, false);
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
        // Legacy room topic chat strictly ignored by spectators
        if (this.phase !== 'in_game' || this.sessionRole !== 'player') return;
        const p = env.payload as { senderName: string; senderColor: PlayerColor; text: string };
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
}
