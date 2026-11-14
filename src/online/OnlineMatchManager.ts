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
  OnlineTransport,
  OnlineTransportStatus,
  PassPacketPayload,
  QuickMatchSizePref,
  RoomSummary,
  ScoreAgreePacketPayload,
  SyncSnapshotPayload,
} from './types';

const TOPIC_PREFIX = 'sudam-3d-baduk-v1';
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_TTL_MS = 25000;

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
}

export class OnlineMatchManager {
  private profile: ProfileManager;
  private transport: OnlineTransport;
  private callbacks: OnlineMatchCallbacks;

  private phase: OnlineSessionPhase = 'idle';
  private sessionSeq = 0;
  private activeRoomCode: string | null = null;
  private roleInfo: OnlineRoleInfo | null = null;
  private lastMatchInit: OnlineMatchInitPayload | null = null;

  // Deduplication ring buffer
  private seenMsgIds = new Set<string>();
  private seenMsgQueue: string[] = [];

  // Lobby open rooms cache
  private openRooms = new Map<string, RoomSummary>();
  private watchingLobby = false;
  private lobbyPruneTimer: ReturnType<typeof setInterval> | null = null;

  // Host waiting room state
  private hostedRoom: RoomSummary | null = null;
  private hostedIsPublic = true;
  private hostAdvertiseTimer: ReturnType<typeof setInterval> | null = null;

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
        this.leaveCurrentSession(true);
      });
    }
  }

  public getPhase(): OnlineSessionPhase {
    return this.phase;
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

  public async ensureConnected(): Promise<void> {
    await this.transport.connect();
    await this.transport.subscribe(this.directTopic(this.profile.getClientId()));
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
    await this.cancelMatchmakingOrRoom();
    const seq = ++this.sessionSeq;
    await this.ensureConnected();
    if (seq !== this.sessionSeq) throw new Error('대국방 생성 요청이 취소되었습니다.');

    const roomCode = generateRoomCode(6);
    const now = Date.now();
    const hostName = this.profile.getNickname();
    const title = options.title?.trim() || `${hostName}님의 수담 대국실`;

    const summary: RoomSummary = {
      roomCode,
      title,
      hostId: this.profile.getClientId(),
      hostName,
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

    await this.transport.subscribe(this.roomTopic(roomCode));
    if (options.isPublic) {
      await this.transport.subscribe(this.lobbyRoomsReqTopic());
      this.publishHostedRoomListing();
      this.hostAdvertiseTimer = setInterval(() => this.publishHostedRoomListing(), 6000);
    }

    this.setPhase('waiting_room', roomCode);
    this.callbacks.onWaitingRoomReady(summary, options.isPublic);
    return summary;
  }

  private publishHostedRoomListing(): void {
    if (!this.hostedRoom || !this.hostedIsPublic || this.phase !== 'waiting_room') return;
    this.hostedRoom.hostName = this.profile.getNickname();
    this.hostedRoom.updatedAt = Date.now();
    this.transport.publish(this.lobbyRoomTopic(this.hostedRoom.roomCode), this.hostedRoom, {
      retain: true,
    });
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
  // Join Room by Code / Open Room Click
  // =========================================================================

  public async joinRoom(rawCode: string): Promise<void> {
    const roomCode = normalizeRoomCode(rawCode);
    if (!roomCode) {
      this.callbacks.onError('올바른 6자리 방 코드를 입력해 주세요.');
      return;
    }

    await this.cancelMatchmakingOrRoom();
    const seq = ++this.sessionSeq;
    this.activeRoomCode = roomCode;
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

    const prevHosted = this.hostedRoom;
    const prevHostedPublic = this.hostedIsPublic;
    const prevRoomCode = this.activeRoomCode;
    const wasInGame = this.phase === 'in_game';

    this.hostedRoom = null;
    this.activeRoomCode = null;
    this.qmPendingOffer = null;
    this.qmAcceptedRoomCode = null;
    this.roleInfo = null;
    this.lastMatchInit = null;
    this.resetScoreAgreement();

    if (this.phase !== 'idle') {
      this.setPhase('idle');
    }

    if (prevHosted && prevHostedPublic) {
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
      }
      if (seq === this.sessionSeq) {
        await this.transport.unsubscribe(this.roomTopic(prevRoomCode));
      }
    }

    if (seq === this.sessionSeq) {
      await this.transport.unsubscribe(this.quickMatchTopic());
    }
  }

  public leaveCurrentSession(silent = false): void {
    if (this.hostedRoom && this.hostedIsPublic) {
      this.clearHostedRoomListing(this.hostedRoom.roomCode);
    }
    if (this.phase === 'in_game' && this.activeRoomCode) {
      this.sendRoomPacket('leave', {
        roomCode: this.activeRoomCode,
        senderName: this.profile.getNickname(),
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

    // Direct signaling messages
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

    const initPayload: OnlineMatchInitPayload = {
      roomCode: accept.roomCode,
      hostId: myId,
      guestId: accept.guestId,
      blackId: hostIsBlack ? myId : accept.guestId,
      whiteId: hostIsBlack ? accept.guestId : myId,
      blackName: hostIsBlack ? myName : accept.guestName,
      whiteName: hostIsBlack ? accept.guestName : myName,
      boardSize: size,
      ruleset: 'korean',
      gameType: accept.gameType ?? this.qmPendingOffer?.gameType ?? this.qmGameType,
      omokRuleset: accept.omokRuleset ?? this.qmPendingOffer?.omokRuleset ?? this.qmOmokRuleset,
      handicap: 0,
      komi: 6.5,
      mainTimeSeconds: size === 9 ? 300 : 600,
      byoyomiSeconds: 30,
      byoyomiPeriods: 3,
      startedAt: Date.now(),
    };

    this.activeRoomCode = accept.roomCode;
    const env = this.makeEnvelope('match_start', initPayload);
    this.transport.publish(this.directTopic(accept.guestId), env);
    this.transport.publish(this.roomTopic(accept.roomCode), env);

    await this.handleMatchStartPacket(initPayload, false);
  }

  private handleRoomPacket(env: OnlineEnvelope): void {
    switch (env.type) {
      case 'room_join_req': {
        const req = env.payload as RoomJoinReqPayload;
        if (this.phase !== 'waiting_room' || !this.hostedRoom) {
          if (this.phase === 'in_game' && this.lastMatchInit && req.guestId === this.lastMatchInit.guestId) {
            // Re-send match_start if guest missed the first packet
            this.sendRoomPacket('match_start', this.lastMatchInit);
          } else if (this.roleInfo?.isHost) {
            this.sendRoomPacket('room_join_reject', {
              targetGuestId: req.guestId,
              reason: '이미 다른 대국자와 경기가 진행 중입니다.',
            });
          }
          return;
        }

        const room = this.hostedRoom;
        const myId = this.profile.getClientId();
        const myName = this.profile.getNickname();

        let hostIsBlack = true;
        if (room.hostColorPref === 'white') hostIsBlack = false;
        else if (room.hostColorPref === 'random') hostIsBlack = Math.random() < 0.5;
        if (room.handicap >= 2) {
          // Standard handicap: Black has handicap stones, keep chosen preference
        }

        const initPayload: OnlineMatchInitPayload = {
          roomCode: room.roomCode,
          hostId: myId,
          guestId: req.guestId,
          blackId: hostIsBlack ? myId : req.guestId,
          whiteId: hostIsBlack ? req.guestId : myId,
          blackName: hostIsBlack ? myName : req.guestName,
          whiteName: hostIsBlack ? req.guestName : myName,
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

        if (this.hostedIsPublic) {
          this.clearHostedRoomListing(room.roomCode);
        }
        this.hostedRoom = null;

        const startEnv = this.makeEnvelope('match_start', initPayload);
        this.transport.publish(this.roomTopic(room.roomCode), startEnv);
        this.transport.publish(this.directTopic(req.guestId), startEnv);
        void this.handleMatchStartPacket(initPayload, false);
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

      case 'match_start': {
        void this.handleMatchStartPacket(env.payload as OnlineMatchInitPayload, false);
        break;
      }

      case 'move': {
        if (this.phase !== 'in_game') return;
        this.callbacks.onRemoteMove(env.payload as MovePacketPayload);
        break;
      }

      case 'pass': {
        if (this.phase !== 'in_game') return;
        this.callbacks.onRemotePass(env.payload as PassPacketPayload);
        break;
      }

      case 'dead_toggle': {
        if (this.phase !== 'in_game') return;
        this.resetScoreAgreement();
        this.callbacks.onRemoteDeadToggle(env.payload as DeadTogglePacketPayload);
        this.callbacks.onScoreAgreementChanged(this.getScoreAgreement());
        break;
      }

      case 'score_agree': {
        if (this.phase !== 'in_game') return;
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
        if (this.phase !== 'in_game') return;
        const p = env.payload as { color: PlayerColor };
        this.resetScoreAgreement();
        this.callbacks.onRemoteScoreResume(p.color);
        break;
      }

      case 'resign': {
        if (this.phase !== 'in_game') return;
        const p = env.payload as { color: PlayerColor };
        this.callbacks.onRemoteResign(p.color);
        break;
      }

      case 'timeout': {
        if (this.phase !== 'in_game') return;
        const p = env.payload as { timedOutColor: PlayerColor };
        this.callbacks.onRemoteTimeout(p.timedOutColor);
        break;
      }

      case 'undo_request': {
        if (this.phase !== 'in_game') return;
        const p = env.payload as { requesterColor: PlayerColor; steps: number };
        this.callbacks.onUndoRequested(p.requesterColor, p.steps);
        break;
      }

      case 'undo_response': {
        if (this.phase !== 'in_game') return;
        const p = env.payload as { accepted: boolean; steps: number; clock?: ClockSnapshot };
        this.callbacks.onUndoResolved(p.accepted, p.steps, p.clock);
        break;
      }

      case 'rematch_request': {
        if (this.phase !== 'in_game') return;
        const p = env.payload as { requesterColor: PlayerColor };
        this.callbacks.onRematchRequested(p.requesterColor);
        break;
      }

      case 'rematch_response': {
        if (this.phase !== 'in_game') return;
        const p = env.payload as { accepted: boolean; nextMatch?: OnlineMatchInitPayload };
        if (p.accepted && p.nextMatch) {
          void this.handleMatchStartPacket(p.nextMatch, true);
        } else {
          this.callbacks.onRematchDeclined();
        }
        break;
      }

      case 'chat': {
        if (this.phase !== 'in_game') return;
        const p = env.payload as { senderName: string; senderColor: PlayerColor; text: string };
        this.callbacks.onRemoteChat(p.senderName, p.senderColor, p.text);
        break;
      }

      case 'ping': {
        if (this.phase !== 'in_game') return;
        const p = env.payload as { pingSentAt: number };
        this.sendRoomPacket('pong', { pingSentAt: p.pingSentAt });
        break;
      }

      case 'pong': {
        if (this.phase !== 'in_game') return;
        const p = env.payload as { pingSentAt: number };
        const rtt = Math.max(1, Math.round(Date.now() - p.pingSentAt));
        this.callbacks.onLatencyUpdated(rtt);
        break;
      }

      case 'sync_request': {
        if (this.phase !== 'in_game') return;
        const snap = this.callbacks.onSyncRequested();
        if (snap) {
          this.sendRoomPacket('sync_snapshot', snap);
        }
        break;
      }

      case 'sync_snapshot': {
        if (this.phase !== 'in_game') return;
        this.callbacks.onSyncSnapshotReceived(env.payload as SyncSnapshotPayload);
        break;
      }

      case 'leave': {
        if (this.phase !== 'in_game') return;
        const p = env.payload as { senderName?: string };
        this.callbacks.onOpponentLeft(p.senderName || this.roleInfo?.opponentName || '상대 대국자');
        break;
      }
    }
  }

  private async handleMatchStartPacket(
    init: OnlineMatchInitPayload,
    isRematch: boolean
  ): Promise<void> {
    const myId = this.profile.getClientId();
    if (init.hostId !== myId && init.guestId !== myId) return;
    if (!isRematch && this.phase === 'in_game' && this.lastMatchInit?.startedAt === init.startedAt) {
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
    if (this.qmSeekTimer) {
      clearInterval(this.qmSeekTimer);
      this.qmSeekTimer = null;
    }
    await this.transport.unsubscribe(this.quickMatchTopic());

    this.activeRoomCode = init.roomCode;
    await this.transport.subscribe(this.roomTopic(init.roomCode));

    this.lastMatchInit = init;
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
    };

    const config: GameConfig = {
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

    this.setPhase('in_game', init.roomCode);
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
    if (this.phase !== 'in_game' || !this.activeRoomCode || !this.lastMatchInit || !this.roleInfo) {
      return;
    }
    if (!accepted) {
      this.sendRoomPacket('rematch_response', { accepted: false });
      return;
    }

    // Swap Black and White colors on rematch!
    const prev = this.lastMatchInit;
    const nextMatch: OnlineMatchInitPayload = {
      ...prev,
      blackId: prev.whiteId,
      whiteId: prev.blackId,
      blackName: prev.whiteName,
      whiteName: prev.blackName,
      startedAt: Date.now(),
    };
    this.sendRoomPacket('rematch_response', { accepted: true, nextMatch });
    void this.handleMatchStartPacket(nextMatch, true);
  }

  public sendChat(text: string): void {
    if (this.phase !== 'in_game' || !this.activeRoomCode || !this.roleInfo) return;
    const trimmed = text.trim().slice(0, 80);
    if (!trimmed) return;
    this.sendRoomPacket('chat', {
      senderName: this.profile.getNickname(),
      senderColor: this.roleInfo.myColor,
      text: trimmed,
    });
  }

  public getInviteUrl(): string {
    if (!this.activeRoomCode || typeof window === 'undefined') return '';
    const url = new URL(window.location.href);
    url.searchParams.set('room', this.activeRoomCode);
    return url.toString();
  }
}
