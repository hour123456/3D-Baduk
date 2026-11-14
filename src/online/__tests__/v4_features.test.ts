import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLACK, WHITE } from '../../rules/types';
import { GameClock, UrgentCountdownState } from '../../rules/clock';
import { ProfileManager, sanitizeNickname } from '../../profile/ProfileManager';
import { SettingsManager, resolveEffectiveUiLayout } from '../../settings/SettingsManager';
import { BowlPhysicsParticle, StonePhysicsWorld } from '../../scene/StonePhysicsWorld';
import { TUTORIAL_LESSONS } from '../../tutorial/TutorialCurriculum';
import { TutorialController } from '../../tutorial/TutorialController';
import { mqttTopicMatches } from '../MultiBrokerTransport';
import { OnlineMatchCallbacks, OnlineMatchManager } from '../OnlineMatchManager';
import {
  canonicalizePayload,
  decryptIpWithPrivateJwk,
  encryptIpForAdmin,
  hashIpAddress,
  signPayloadWithPrivateJwk,
  verifyAdminSignature,
} from '../adminSecurity';
import {
  AdminBanEntry,
  AdminInterceptedChatMessage,
  AdminStealthWelcomePayload,
  LiveConnectedUserRecord,
  OnlineTransport,
  OnlineTransportStatus,
  PresenceStats,
  RoomSummary,
} from '../types';

class InMemoryBrokerHub {
  public clients = new Set<MockTransport>();
  public retained = new Map<string, unknown>();

  public broadcast(sender: MockTransport, topic: string, data: unknown, retain: boolean): void {
    if (retain) {
      if (data === null) this.retained.delete(topic);
      else this.retained.set(topic, data);
    }
    for (const c of this.clients) {
      if (c === sender) continue;
      c.deliverIfSubscribed(topic, data);
    }
  }
}

class MockTransport implements OnlineTransport {
  private hub: InMemoryBrokerHub;
  private connected = false;
  private subs = new Set<string>();
  private msgHandlers = new Set<(topic: string, data: unknown) => void>();
  private statusHandlers = new Set<(s: OnlineTransportStatus, l: string) => void>();

  constructor(hub: InMemoryBrokerHub) {
    this.hub = hub;
    this.hub.clients.add(this);
  }

  public async connect(): Promise<void> {
    this.connected = true;
    for (const h of this.statusHandlers) h('connected', 'MockHub');
  }

  public disconnect(): void {
    this.connected = false;
    this.subs.clear();
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getBrokerLabel(): string {
    return 'MockHub';
  }

  public async subscribe(topic: string): Promise<void> {
    this.subs.add(topic);
    for (const [retTopic, retVal] of this.hub.retained.entries()) {
      if (mqttTopicMatches(topic, retTopic)) {
        for (const fn of this.msgHandlers) fn(retTopic, retVal);
      }
    }
  }

  public async unsubscribe(topic: string): Promise<void> {
    this.subs.delete(topic);
  }

  public publish(topic: string, data: unknown, options?: { retain?: boolean }): void {
    const clone = data === null ? null : JSON.parse(JSON.stringify(data));
    this.hub.broadcast(this, topic, clone, Boolean(options?.retain));
  }

  public deliverIfSubscribed(topic: string, data: unknown): void {
    for (const pattern of this.subs) {
      if (mqttTopicMatches(pattern, topic)) {
        for (const fn of this.msgHandlers) fn(topic, data);
        break;
      }
    }
  }

  public onMessage(handler: (topic: string, data: unknown) => void): () => void {
    this.msgHandlers.add(handler);
    return () => this.msgHandlers.delete(handler);
  }

  public onStatusChange(
    handler: (status: OnlineTransportStatus, brokerLabel: string) => void
  ): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }
}

function makeFakeProfile(clientId: string, accountId: string, nickname: string): ProfileManager {
  let currentNick = nickname;
  return {
    getProfile: () => ({ clientId, accountId, nickname: currentNick }),
    getClientId: () => clientId,
    getAccountId: () => accountId,
    getNickname: () => currentNick,
    setNickname: (n: string) => {
      currentNick = sanitizeNickname(n) || currentNick;
      return currentNick;
    },
    onChange: () => () => {},
  } as unknown as ProfileManager;
}

function makeCallbacks(overrides: Partial<OnlineMatchCallbacks> = {}): OnlineMatchCallbacks {
  return {
    onStatusChange: () => {},
    onPhaseChange: () => {},
    onOpenRoomsUpdated: () => {},
    onWaitingRoomReady: () => {},
    onMatchStart: () => {},
    onRemoteMove: () => {},
    onRemotePass: () => {},
    onRemoteDeadToggle: () => {},
    onScoreAgreementChanged: () => {},
    onScoreBothAgreed: () => {},
    onRemoteScoreResume: () => {},
    onRemoteResign: () => {},
    onRemoteTimeout: () => {},
    onUndoRequested: () => {},
    onUndoResolved: () => {},
    onRematchRequested: () => {},
    onRematchDeclined: () => {},
    onRemoteChat: () => {},
    onOpponentLeft: () => {},
    onLatencyUpdated: () => {},
    onSyncRequested: () => null,
    onSyncSnapshotReceived: () => {},
    onError: () => {},
    ...overrides,
  };
}

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (idx: number) => Array.from(map.keys())[idx] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('v4 Features: Settings, Clock 10s Alert, Directional Physics, Tutorial, Crypto & Admin Mode', () => {
  it('clamps brightness (0.5~1.5) and resolves mobile/desktop UI & board grain settings', () => {
    const storage = makeMemoryStorage();
    vi.stubGlobal('window', {
      localStorage: storage,
      innerWidth: 390,
      innerHeight: 844,
      matchMedia: () => ({ matches: true }),
    });
    vi.stubGlobal('navigator', { maxTouchPoints: 5 });

    const sm = new SettingsManager();
    const initial = sm.get();
    // On mobile touch viewport, defaults promote clear lines & soft wood grain
    expect(initial.boardGrainIntensity).toBe('soft');
    expect(initial.gridLineContrast).toBe('high');
    expect(resolveEffectiveUiLayout(initial.uiLayoutMode)).toBe('mobile');

    expect(sm.update({ lightingBrightness: 9.0 }).lightingBrightness).toBe(1.5);
    expect(sm.update({ lightingBrightness: 0.1 }).lightingBrightness).toBe(0.5);
    expect(
      sm.update({ boardGrainIntensity: 'plain', gridLineContrast: 'high', uiLayoutMode: 'desktop' })
    ).toMatchObject({
      boardGrainIntensity: 'plain',
      gridLineContrast: 'high',
      uiLayoutMode: 'desktop',
    });
    expect(resolveEffectiveUiLayout('desktop')).toBe('desktop');
    expect(resolveEffectiveUiLayout('mobile')).toBe('mobile');
  });

  it('emits onUrgentCountdown when <=10s remain in byoyomi or main time and clears on stop/turn switch', () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    });
    vi.stubGlobal('window', {
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    });

    const urgentEvents: UrgentCountdownState[] = [];
    const warnings: number[] = [];
    const clock = new GameClock({
      onTick: () => {},
      onByoyomiWarning: (_c, sec) => warnings.push(sec),
      onTimeout: () => {},
      onUrgentCountdown: (state) => urgentEvents.push(state),
    });

    clock.configure(0, 12, 2);
    clock.startTurn(BLACK);
    expect(urgentEvents[urgentEvents.length - 1]?.active).toBe(false);

    vi.advanceTimersByTime(2200); // ~9.8s left -> ceil 10
    const tenEvent = urgentEvents.find((e) => e.active && e.secondsLeft === 10);
    expect(tenEvent).toBeDefined();
    expect(tenEvent?.color).toBe(BLACK);
    expect(tenEvent?.isByoyomi).toBe(true);
    expect(warnings).toContain(10);

    // Switching turn resets countdown back to 12s -> urgent banner deactivates
    clock.startTurn(WHITE);
    expect(urgentEvents[urgentEvents.length - 1]?.active).toBe(false);

    clock.stop();
    expect(urgentEvents[urgentEvents.length - 1]?.active).toBe(false);
  });

  it('nudges board stones along exact touch direction without unintended reverse recoil', () => {
    const world = new StonePhysicsWorld();
    world.setMotionStyle('instant');
    const placed = world.spawnPlacementBody({
      key: '9,9',
      color: BLACK,
      targetX: 0,
      targetZ: 0,
      bowlX: 3,
      bowlY: 0.4,
      bowlZ: 1,
      radius: 0.2,
      halfHeight: 0.09,
      jitterX: 0,
      jitterZ: 0,
      boardSurfaceY: 0,
    });
    // Settled realistic body has zero sideways roll spin
    expect(placed.angVz).toBe(0);

    // Push along +X (1, 0)
    const okX = world.nudgeStone(placed, 1, 0, 1.0);
    expect(okX).toBe(true);
    expect(placed.vx).toBeGreaterThan(0.2);
    expect(Math.abs(placed.vz)).toBeLessThan(1e-6);

    const prevX = placed.x;
    world.stepBoardStones([placed], 0.016);
    expect(placed.x).toBeGreaterThan(prevX);

    // Push a second stone diagonally toward (+1, -1)
    const diag = world.spawnPlacementBody({
      key: '10,10',
      color: WHITE,
      targetX: 0.5,
      targetZ: 0.5,
      bowlX: -3,
      bowlY: 0.4,
      bowlZ: -1,
      radius: 0.2,
      halfHeight: 0.09,
      jitterX: 0,
      jitterZ: 0,
      boardSurfaceY: 0,
    });
    world.nudgeStone(diag, 1, -1, 1.0);
    expect(diag.vx).toBeGreaterThan(0.15);
    expect(diag.vz).toBeLessThan(-0.15);

    // Container step settles bowl particles cleanly
    const bowlStone: BowlPhysicsParticle = {
      x: 0.1,
      y: 0.05,
      z: -0.05,
      restX: 0,
      restY: 0.04,
      restZ: 0,
      vx: 0.4,
      vy: 0.2,
      vz: -0.3,
      rotX: 0,
      rotY: 0,
      rotZ: 0,
      restRotX: 0,
      restRotZ: 0,
      angVx: 0,
      angVz: 0,
    };
    for (let i = 0; i < 60; i++) {
      world.stepContainerStones([bowlStone], 0.02, 0.36, 0.104, 0.045);
    }
    expect(Math.hypot(bowlStone.x - bowlStone.restX, bowlStone.z - bowlStone.restZ)).toBeLessThan(0.02);
  });

  it('completes all 9 tutorial curriculum lessons, handles wrong attempts, Lesson 7 snapback, Lesson 8 scoring, and persists completion', () => {
    const storage = makeMemoryStorage();
    vi.stubGlobal('window', { localStorage: storage });

    const tut = new TutorialController();
    expect(tut.getLessons().length).toBe(9);
    expect(TUTORIAL_LESSONS.length).toBe(9);

    // Lesson 1: wrong point vs star point
    const l1 = tut.startLesson('lesson-1-liberties');
    expect(l1?.boardSize).toBe(9);
    const badAttempt = tut.evaluateMoveAttempt(0, 0);
    expect(badAttempt.accepted).toBe(false);
    const goodAttempt = tut.evaluateMoveAttempt(4, 4);
    expect(goodAttempt.accepted).toBe(true);
    expect(tut.isAwaitingNextStep()).toBe(true);

    // Lesson 7 snapback triggers opponentReply on step 1, then final capture completes lesson
    tut.startLesson('lesson-7-tesuji');
    const s1 = tut.evaluateMoveAttempt(8, 0);
    expect(s1.accepted).toBe(true);
    expect(s1.needsOpponentReply).toEqual({ x: 7, y: 0, color: WHITE });
    const next7 = tut.advanceToNextStep();
    expect(next7.hasNextStep).toBe(true);
    const s2 = tut.evaluateMoveAttempt(8, 0);
    expect(s2.accepted).toBe(true);
    expect(s2.lessonCompleted).toBe(true);
    expect(tut.getCompletedLessonIds().has('lesson-7-tesuji')).toBe(true);

    // Lesson 8 pass -> mark_dead (1,4) -> confirm_score
    tut.startLesson('lesson-8-scoring');
    expect(tut.evaluateMoveAttempt(1, 1).accepted).toBe(false);
    expect(tut.evaluatePassAttempt().accepted).toBe(true);
    tut.advanceToNextStep();
    expect(tut.evaluateDeadStoneAttempt(3, 3).accepted).toBe(false);
    expect(tut.evaluateDeadStoneAttempt(1, 4).accepted).toBe(true);
    tut.advanceToNextStep();
    const scoreDone = tut.evaluateConfirmScoreAttempt();
    expect(scoreDone.accepted).toBe(true);
    expect(scoreDone.lessonCompleted).toBe(true);

    // Lesson 9 Omok Renju 4-3 point
    tut.startLesson('lesson-9-omok-renju');
    expect(tut.evaluateMoveAttempt(2, 10).accepted).toBe(false); // 3-3 forbidden point
    expect(tut.evaluateMoveAttempt(7, 7).accepted).toBe(true);

    // Persistence across fresh controller instance
    const tutReloaded = new TutorialController();
    expect(tutReloaded.getCompletedLessonIds().has('lesson-7-tesuji')).toBe(true);
    expect(tutReloaded.getCompletedLessonIds().has('lesson-8-scoring')).toBe(true);
    expect(tutReloaded.getCompletedLessonIds().has('lesson-9-omok-renju')).toBe(true);
  });

  it('verifies ECDSA P-256 signatures from Node webcrypto.subtle + local keys and RSA-OAEP IP encryption', async () => {
    const keysFile = path.resolve(process.cwd(), 'electron/admin-keys.local.json');
    if (!fs.existsSync(keysFile)) return;
    const keysJson = JSON.parse(fs.readFileSync(keysFile, 'utf8')) as {
      signPrivateJwk: JsonWebKey;
      decryptPrivateJwk: JsonWebKey;
    };

    const payload = { action: 'admin_force_close', roomCode: 'ABCD12', reason: 'test', issuedAt: 123456789 };
    // Sign via helper (simulating Node webcrypto.subtle)
    const canonical = canonicalizePayload(payload);
    const nodeSignKey = await webcrypto.subtle.importKey(
      'jwk',
      keysJson.signPrivateJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    const rawSig = await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      nodeSignKey,
      new TextEncoder().encode(canonical)
    );
    const sigB64 = Buffer.from(rawSig).toString('base64');

    expect(await verifyAdminSignature(payload, sigB64)).toBe(true);
    expect(await verifyAdminSignature({ ...payload, roomCode: 'HACKED' }, sigB64)).toBe(false);
    expect(await verifyAdminSignature(payload, 'invalid-base64-sig')).toBe(false);

    // Also test browser sign helper + RSA-OAEP IP encrypt/decrypt roundtrip
    const sig2 = await signPayloadWithPrivateJwk(payload, keysJson.signPrivateJwk);
    expect(await verifyAdminSignature(payload, sig2)).toBe(true);

    const encIp = await encryptIpForAdmin('203.0.113.42');
    expect(encIp).not.toContain('203.0.113.42');
    const decIp = await decryptIpWithPrivateJwk(encIp, keysJson.decryptPrivateJwk);
    expect(decIp).toBe('203.0.113.42');
  });

  it('supports invisible Admin monitoring, IP/Account bans, passwordless zero-notice stealth dual chat monitor, and force close', async () => {
    const keysFile = path.resolve(process.cwd(), 'electron/admin-keys.local.json');
    if (!fs.existsSync(keysFile)) return;
    const keysJson = JSON.parse(fs.readFileSync(keysFile, 'utf8')) as {
      signPrivateJwk: JsonWebKey;
      decryptPrivateJwk: JsonWebKey;
    };
    const signFn = (canonicalJson: string) => signPayloadWithPrivateJwk(JSON.parse(canonicalJson), keysJson.signPrivateJwk);

    const hub = new InMemoryBrokerHub();

    let latestPresenceForPlayer: PresenceStats = { onlineUsers: 0, inGameUsers: 0, spectatingUsers: 0 };
    let hostBanned: AdminBanEntry | null = null;
    let guestBanned: AdminBanEntry | null = null;
    let hostForceClosedReason = '';
    let guestForceClosedReason = '';
    let specNotifiedJoin = false;
    let hostRoomCreated: RoomSummary | null = null;
    let adminLiveUsers: LiveConnectedUserRecord[] = [];
    let adminStealthWelcome: AdminStealthWelcomePayload | null = null;
    const adminChats: AdminInterceptedChatMessage[] = [];

    const host = new OnlineMatchManager(
      makeFakeProfile('sd_host', 'acc_host_001', '방장기사'),
      new MockTransport(hub),
      makeCallbacks({
        onWaitingRoomReady: (r) => {
          hostRoomCreated = r;
        },
        onPresenceUpdated: (s) => {
          latestPresenceForPlayer = s;
        },
        onRoomForceClosed: (reason) => {
          hostForceClosedReason = reason;
        },
      }),
      { simulatedPublicIp: '198.51.100.10' }
    );

    const guest = new OnlineMatchManager(
      makeFakeProfile('sd_guest', 'acc_guest_002', '도전자'),
      new MockTransport(hub),
      makeCallbacks({
        onSelfBanned: (ban) => {
          guestBanned = ban;
        },
        onRoomForceClosed: (reason) => {
          guestForceClosedReason = reason;
        },
      }),
      { simulatedPublicIp: '198.51.100.77' }
    );

    const spectator = new OnlineMatchManager(
      makeFakeProfile('sd_spec', 'acc_spec_003', '관전객'),
      new MockTransport(hub),
      makeCallbacks({
        onSpectatorCountUpdated: () => {
          specNotifiedJoin = true;
        },
      }),
      { simulatedPublicIp: '198.51.100.99' }
    );

    const admin = new OnlineMatchManager(
      makeFakeProfile('sd_admin', 'acc_admin_root', '수담관리자'),
      new MockTransport(hub),
      makeCallbacks({
        onLiveUsersChanged: (users) => {
          adminLiveUsers = users;
        },
        onAdminStealthJoined: (w) => {
          adminStealthWelcome = w;
        },
        onAdminMonitorChat: (m) => {
          adminChats.push(m);
        },
      }),
      { adminMode: true }
    );

    await admin.adminInitializeMonitoring();
    await host.startPresenceTracking();
    await guest.startPresenceTracking();
    await spectator.startPresenceTracking();
    await new Promise((r) => setTimeout(r, 30));

    // Admin is completely hidden from regular players' live count (3 players, not 4)
    expect(latestPresenceForPlayer.onlineUsers).toBe(3);
    expect(adminLiveUsers.length).toBe(3);
    const guestRecord = adminLiveUsers.find((u) => u.accountId === 'acc_guest_002');
    expect(guestRecord?.encryptedIp).toBeTruthy();
    expect(await decryptIpWithPrivateJwk(guestRecord!.encryptedIp!, keysJson.decryptPrivateJwk)).toBe(
      '198.51.100.77'
    );

    // Host opens a PRIVATE password-protected room
    await host.createRoom({
      title: '비밀 고수 대국',
      isPublic: false,
      password: 'secret-pass',
      gameType: 'baduk',
      boardSize: 19,
      ruleset: 'korean',
      handicap: 0,
      komi: 6.5,
      mainTimeSeconds: 600,
      byoyomiSeconds: 30,
      byoyomiPeriods: 3,
      hostColorPref: 'black',
    });
    expect(hostRoomCreated).not.toBeNull();
    const roomCode = hostRoomCreated!.roomCode;

    await guest.joinRoom(roomCode, 'secret-pass');
    await spectator.spectateRoom(roomCode, 'secret-pass');
    await new Promise((r) => setTimeout(r, 30));

    // Reset flag to confirm Admin stealth join triggers ZERO spectator count update or notice
    specNotifiedJoin = false;
    const roomSummary = admin.getOpenRooms().find((r) => r.roomCode === roomCode) || hostRoomCreated!;
    await admin.adminStealthJoinRoom(roomSummary, signFn);
    await new Promise((r) => setTimeout(r, 40));

    expect(adminStealthWelcome).not.toBeNull();
    expect(adminStealthWelcome!.roomCode).toBe(roomCode);
    expect(specNotifiedJoin).toBe(false);
    expect(host.getRoleInfo()?.spectatorCount ?? 1).toBe(1);

    // Both isolated Player Chat AND Spectator Chat arrive at Admin monitor simultaneously
    expect(host.sendPlayerChat('대국자 흑의 비밀 인사')).toBe(true);
    expect(guest.sendPlayerChat('대국자 백의 응답')).toBe(true);
    expect(spectator.sendSpectatorChat('관전방 중계 잡담')).toBe(true);
    await new Promise((r) => setTimeout(r, 30));

    expect(adminChats.some((c) => c.channel === 'player' && c.text === '대국자 흑의 비밀 인사')).toBe(true);
    expect(adminChats.some((c) => c.channel === 'player' && c.text === '대국자 백의 응답')).toBe(true);
    expect(adminChats.some((c) => c.channel === 'spectator' && c.text === '관전방 중계 잡담')).toBe(true);

    // Force close room -> host & guest receive onRoomForceClosed
    await admin.adminForceCloseRoom(roomCode, '비정상 대국 강제 종료', signFn);
    await new Promise((r) => setTimeout(r, 30));
    expect(hostForceClosedReason).toBe('비정상 대국 강제 종료');
    expect(guestForceClosedReason).toBe('비정상 대국 강제 종료');

    // IP Ban on guest -> kicks active banned user and blocks alt account sharing the same IP!
    const guestIpHash = await hashIpAddress('198.51.100.77');
    const ipBan: AdminBanEntry = {
      banId: 'ban-ip-1',
      targetType: 'ip',
      ipHash: guestIpHash,
      maskedIpLabel: '198.51.*.*',
      targetNickname: '도전자',
      reason: 'IP 차단 테스트',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    };
    await admin.adminPublishBanRegistry([ipBan], signFn);
    await new Promise((r) => setTimeout(r, 30));
    const receivedGuestBan = guestBanned as AdminBanEntry | null;
    expect(receivedGuestBan?.banId).toBe('ban-ip-1');

    // Alt account sharing banned IP cannot join or create rooms!
    const altSameIp = new OnlineMatchManager(
      makeFakeProfile('sd_alt', 'acc_alt_999', '부캐유저'),
      new MockTransport(hub),
      makeCallbacks({
        onSelfBanned: (b) => {
          hostBanned = b;
        },
      }),
      { simulatedPublicIp: '198.51.100.77' }
    );
    await expect(
      altSameIp.createRoom({
        title: '우회 시도',
        isPublic: true,
        boardSize: 19,
        ruleset: 'korean',
        handicap: 0,
        komi: 6.5,
        mainTimeSeconds: 0,
        byoyomiSeconds: 0,
        byoyomiPeriods: 0,
        hostColorPref: 'black',
      })
    ).rejects.toThrow();

    // Unban lifts restriction cleanly
    await admin.adminPublishBanRegistry([], signFn);
    await new Promise((r) => setTimeout(r, 25));
    expect(admin.getBanRegistry().length).toBe(0);
    void hostBanned;

    host.stopPresenceTracking();
    guest.stopPresenceTracking();
    spectator.stopPresenceTracking();
    await host.cancelMatchmakingOrRoom();
    await guest.cancelMatchmakingOrRoom();
    await spectator.cancelMatchmakingOrRoom();
    await admin.cancelMatchmakingOrRoom();
    await altSameIp.cancelMatchmakingOrRoom();
  });
});
