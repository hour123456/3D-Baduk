import { describe, expect, it } from 'vitest';
import { BLACK, GameConfig, WHITE } from '../../rules/types';
import { ProfileManager, sanitizeNickname } from '../../profile/ProfileManager';
import { SettingsManager } from '../../settings/SettingsManager';
import { BowlPhysicsParticle, StonePhysicsWorld } from '../../scene/StonePhysicsWorld';
import { mqttTopicMatches } from '../MultiBrokerTransport';
import { OnlineMatchCallbacks, OnlineMatchManager } from '../OnlineMatchManager';
import {
  OnlineRoleInfo,
  OnlineTransport,
  OnlineTransportStatus,
  PresenceStats,
  RoomSummary,
  SyncSnapshotPayload,
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

function makeFakeProfile(clientId: string, nickname: string): ProfileManager {
  let currentNick = nickname;
  return {
    getProfile: () => ({ clientId, nickname: currentNick }),
    getClientId: () => clientId,
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

describe('v3 Features: Touch-Only Bowl Physics, Settings, Private Rooms, Spectate, Chat Isolation & Presence', () => {
  it('keeps settled bowl stone particles motionless and settles perturbed bowl stones quickly', () => {
    const world = new StonePhysicsWorld();
    const stoneR = 0.085;
    const minSpacing = stoneR * 2.1;
    const particles: BowlPhysicsParticle[] = [
      {
        x: -minSpacing,
        y: 0.04,
        z: 0,
        restX: -minSpacing,
        restY: 0.04,
        restZ: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        rotX: 0.1,
        rotY: 0,
        rotZ: -0.05,
        restRotX: 0.1,
        restRotZ: -0.05,
        angVx: 0,
        angVz: 0,
      },
      {
        x: minSpacing,
        y: 0.04,
        z: 0,
        restX: minSpacing,
        restY: 0.04,
        restZ: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        rotX: -0.1,
        rotY: 0,
        rotZ: 0.08,
        restRotX: -0.1,
        restRotZ: 0.08,
        angVx: 0,
        angVz: 0,
      },
    ];

    // Resting well-spaced particles stay motionless when stepped
    for (let i = 0; i < 10; i++) {
      world.stepContainerStones(particles, 0.016, 0.56, stoneR, 0.06);
    }
    expect(Math.hypot(particles[0].vx, particles[0].vy, particles[0].vz)).toBeLessThan(1e-6);

    // Perturbed particles rattle and damp smoothly toward rest pose
    particles[0].vx = 0.45;
    particles[0].vy = 0.35;
    particles[0].angVx = 4.2;
    for (let i = 0; i < 160; i++) {
      world.stepContainerStones(particles, 0.016, 0.56, stoneR, 0.06);
    }
    const residualSpeed = Math.hypot(particles[0].vx, particles[0].vy, particles[0].vz);
    expect(residualSpeed).toBeLessThan(0.015);
    expect(Math.abs(particles[0].rotX - particles[0].restRotX)).toBeLessThan(0.05);
  });

  it('persists and resets visualQuality, bloomEnabled and ornateFinishEnabled in SettingsManager', () => {
    const sm = new SettingsManager();
    const initial = sm.get();
    expect(['ultra', 'high', 'standard']).toContain(initial.visualQuality);
    expect(typeof initial.bloomEnabled).toBe('boolean');
    expect(typeof initial.ornateFinishEnabled).toBe('boolean');

    const updated = sm.update({
      visualQuality: 'standard',
      bloomEnabled: false,
      ornateFinishEnabled: false,
    });
    expect(updated.visualQuality).toBe('standard');
    expect(updated.bloomEnabled).toBe(false);
    expect(updated.ornateFinishEnabled).toBe(false);

    const reset = sm.resetDefaults();
    expect(reset.bloomEnabled).toBe(true);
    expect(reset.ornateFinishEnabled).toBe(true);
  });

  it('lists both public and password-protected private rooms, enforces private passwords, and streams live spectating', async () => {
    const hub = new InMemoryBrokerHub();
    let lobbyRooms: RoomSummary[] = [];
    let hostMatch: { cfg: GameConfig; role: OnlineRoleInfo } | null = null;
    let guestMatch: { cfg: GameConfig; role: OnlineRoleInfo } | null = null;
    let passwordRequiredAction: { action: 'join' | 'spectate'; roomCode: string } | null = null;
    let passwordRejectedReason = '';
    let spectateStarted: { cfg: GameConfig; snap: SyncSnapshotPayload | null; count: number } | null = null;
    let hostSpectatorCount = 0;
    const spectatorMoves: Array<{ x: number; y: number }> = [];

    const host: OnlineMatchManager = new OnlineMatchManager(
      makeFakeProfile('sd_host_priv', '비공개방장'),
      new MockTransport(hub),
      makeCallbacks({
        onMatchStart: (cfg, role) => {
          hostMatch = { cfg, role };
        },
        onSpectatorCountUpdated: (c) => {
          hostSpectatorCount = c;
        },
        onSyncRequested: (): SyncSnapshotPayload | null => ({
          roomCode: host.getActiveRoomCode() || '',
          moves: [{ color: BLACK, coord: { x: 3, y: 3 } }],
          phase: 'playing',
          deadIndices: [],
          scoreAgreement: { blackAgreed: false, whiteAgreed: false },
          clock: {
            black: { mainTimeLeft: 600, byoyomiPeriodsLeft: 3, byoyomiTimeLeft: 30, inByoyomi: false },
            white: { mainTimeLeft: 600, byoyomiPeriodsLeft: 3, byoyomiTimeLeft: 30, inByoyomi: false },
          },
        }),
      })
    );

    const guest = new OnlineMatchManager(
      makeFakeProfile('sd_guest_priv', '도전자'),
      new MockTransport(hub),
      makeCallbacks({
        onOpenRoomsUpdated: (rooms) => {
          lobbyRooms = rooms;
        },
        onMatchStart: (cfg, role) => {
          guestMatch = { cfg, role };
        },
        onRoomPasswordRequired: (action, roomCode) => {
          passwordRequiredAction = { action, roomCode };
        },
        onRoomPasswordRejected: (_action, _roomCode, reason) => {
          passwordRejectedReason = reason;
        },
      })
    );

    const spectator = new OnlineMatchManager(
      makeFakeProfile('sd_spec_priv', '관전명인'),
      new MockTransport(hub),
      makeCallbacks({
        onSpectateStart: (cfg, _init, snapshot, count) => {
          spectateStarted = { cfg, snap: snapshot, count };
        },
        onRemoteMove: (p) => {
          spectatorMoves.push({ x: p.x, y: p.y });
        },
        onRoomPasswordRequired: (action, roomCode) => {
          passwordRequiredAction = { action, roomCode };
        },
        onRoomPasswordRejected: (_action, _roomCode, reason) => {
          passwordRejectedReason = reason;
        },
      })
    );

    // Private room creation without password must fail
    await expect(
      host.createRoom({
        title: '사설 수담실',
        isPublic: false,
        password: '   ',
        boardSize: 19,
        ruleset: 'korean',
        handicap: 0,
        komi: 6.5,
        mainTimeSeconds: 600,
        byoyomiSeconds: 30,
        byoyomiPeriods: 3,
        hostColorPref: 'black',
      })
    ).rejects.toThrow();

    const privateRoom = await host.createRoom({
      title: '고수 비공개방',
      isPublic: false,
      password: '7788',
      boardSize: 19,
      ruleset: 'korean',
      handicap: 0,
      komi: 6.5,
      mainTimeSeconds: 600,
      byoyomiSeconds: 30,
      byoyomiPeriods: 3,
      hostColorPref: 'black',
    });

    await guest.startWatchingLobby();
    await new Promise((r) => setTimeout(r, 20));
    expect(lobbyRooms.length).toBe(1);
    expect(lobbyRooms[0].roomCode).toBe(privateRoom.roomCode);
    expect(lobbyRooms[0].hasPassword).toBe(true);
    expect(lobbyRooms[0].isPublic).toBe(false);
    expect((lobbyRooms[0] as unknown as Record<string, unknown>).password).toBeUndefined();

    // Missing password prompts client instead of silent fail
    await guest.joinRoom(privateRoom.roomCode);
    await new Promise((r) => setTimeout(r, 20));
    expect(passwordRequiredAction).toEqual({ action: 'join', roomCode: privateRoom.roomCode });

    // Wrong password rejected
    await guest.joinRoom(privateRoom.roomCode, '0000');
    await new Promise((r) => setTimeout(r, 20));
    expect(passwordRejectedReason).toContain('비밀번호');
    expect(guestMatch).toBeNull();

    // Correct password enters room & keeps room listed as live in_game
    await guest.joinRoom(privateRoom.roomCode, '7788');
    await new Promise((r) => setTimeout(r, 30));
    expect(hostMatch).not.toBeNull();
    expect(guestMatch).not.toBeNull();
    expect(lobbyRooms.length).toBe(1);
    expect(lobbyRooms[0].status).toBe('in_game');

    // Spectator wrong password -> rejected, correct password -> spectate starts
    passwordRejectedReason = '';
    await spectator.spectateRoom(privateRoom.roomCode, 'wrong');
    await new Promise((r) => setTimeout(r, 20));
    expect(passwordRejectedReason).toContain('비밀번호');
    expect(spectateStarted).toBeNull();

    await spectator.spectateRoom(privateRoom.roomCode, '7788');
    await new Promise((r) => setTimeout(r, 30));
    expect(spectateStarted).not.toBeNull();
    expect(spectateStarted!.count).toBe(1);
    expect(spectateStarted!.snap?.moves.length).toBe(1);
    expect(hostSpectatorCount).toBe(1);

    // Live moves propagate to spectator, while spectator cannot send player moves or player chat
    host.sendMove(15, 3, BLACK, 2);
    expect(spectatorMoves).toEqual([{ x: 15, y: 3 }]);
    expect(spectator.sendPlayerChat('관전자가 대국자 방해')).toBe(false);

    await spectator.cancelMatchmakingOrRoom();
    await new Promise((r) => setTimeout(r, 20));
    expect(hostSpectatorCount).toBe(0);

    await host.cancelMatchmakingOrRoom();
    await guest.cancelMatchmakingOrRoom();
  });

  it('strictly isolates player chat from spectators and spectator chat from match players', async () => {
    const hub = new InMemoryBrokerHub();
    const hostPlayerMsgs: string[] = [];
    const hostSpecMsgs: string[] = [];
    const guestPlayerMsgs: string[] = [];
    const guestSpecMsgs: string[] = [];
    const spec1PlayerMsgs: string[] = [];
    const spec1SpecMsgs: string[] = [];
    const spec2PlayerMsgs: string[] = [];
    const spec2SpecMsgs: string[] = [];

    const host = new OnlineMatchManager(
      makeFakeProfile('sd_p1', '흑기사'),
      new MockTransport(hub),
      makeCallbacks({
        onRemotePlayerChat: (_n, _c, t) => hostPlayerMsgs.push(t),
        onRemoteChat: (_n, _c, t) => {
          // Verify legacy fallback doesn't fire separately unexpectedly
          void t;
        },
        onRemoteSpectatorChat: (_n, _id, t) => hostSpecMsgs.push(t),
      })
    );
    const guest = new OnlineMatchManager(
      makeFakeProfile('sd_p2', '백선생'),
      new MockTransport(hub),
      makeCallbacks({
        onRemotePlayerChat: (_n, _c, t) => guestPlayerMsgs.push(t),
        onRemoteSpectatorChat: (_n, _id, t) => guestSpecMsgs.push(t),
      })
    );
    const spec1 = new OnlineMatchManager(
      makeFakeProfile('sd_s1', '관전1'),
      new MockTransport(hub),
      makeCallbacks({
        onRemotePlayerChat: (_n, _c, t) => spec1PlayerMsgs.push(t),
        onRemoteSpectatorChat: (_n, _id, t) => spec1SpecMsgs.push(t),
      })
    );
    const spec2 = new OnlineMatchManager(
      makeFakeProfile('sd_s2', '관전2'),
      new MockTransport(hub),
      makeCallbacks({
        onRemotePlayerChat: (_n, _c, t) => spec2PlayerMsgs.push(t),
        onRemoteSpectatorChat: (_n, _id, t) => spec2SpecMsgs.push(t),
      })
    );

    const room = await host.createRoom({
      title: '채팅 격리 테스트',
      isPublic: true,
      boardSize: 19,
      ruleset: 'korean',
      handicap: 0,
      komi: 6.5,
      mainTimeSeconds: 600,
      byoyomiSeconds: 30,
      byoyomiPeriods: 3,
      hostColorPref: 'black',
    });

    await guest.joinRoom(room.roomCode);
    await new Promise((r) => setTimeout(r, 25));

    await spec1.spectateRoom(room.roomCode);
    await spec2.spectateRoom(room.roomCode);
    await new Promise((r) => setTimeout(r, 30));

    // Player -> Player chat: delivered to opponent, NEVER to spectators
    expect(host.sendPlayerChat('잘 부탁합니다 (대국자 비밀)')).toBe(true);
    expect(guest.sendPlayerChat('화이팅입니다! (백 답장)')).toBe(true);
    expect(host.sendSpectatorChat('선수 사칭 관전채팅')).toBe(false);

    // Spectator -> Spectator chat: delivered to fellow spectators, NEVER to players
    expect(spec1.sendSpectatorChat('흑 포석이 좋네요 (관전)')).toBe(true);
    expect(spec2.sendSpectatorChat('동의합니다! (관전2)')).toBe(true);

    await new Promise((r) => setTimeout(r, 20));

    expect(guestPlayerMsgs).toEqual(['잘 부탁합니다 (대국자 비밀)']);
    expect(hostPlayerMsgs).toEqual(['화이팅입니다! (백 답장)']);
    expect(spec1PlayerMsgs).toEqual([]);
    expect(spec2PlayerMsgs).toEqual([]);

    expect(spec2SpecMsgs).toEqual(['흑 포석이 좋네요 (관전)']);
    expect(spec1SpecMsgs).toEqual(['동의합니다! (관전2)']);
    expect(hostSpecMsgs).toEqual([]);
    expect(guestSpecMsgs).toEqual([]);

    await spec1.cancelMatchmakingOrRoom();
    await spec2.cancelMatchmakingOrRoom();
    await host.cancelMatchmakingOrRoom();
    await guest.cancelMatchmakingOrRoom();
  });

  it('tracks live web concurrent users accurately across multiple sessions', async () => {
    const hub = new InMemoryBrokerHub();
    let latestStatsA: PresenceStats = { onlineUsers: 0, inGameUsers: 0, spectatingUsers: 0 };

    const clientA = new OnlineMatchManager(
      makeFakeProfile('sd_web_a', '접속자A'),
      new MockTransport(hub),
      makeCallbacks({
        onPresenceUpdated: (s) => {
          latestStatsA = s;
        },
      })
    );
    const clientB = new OnlineMatchManager(
      makeFakeProfile('sd_web_b', '접속자B'),
      new MockTransport(hub),
      makeCallbacks()
    );
    const clientC = new OnlineMatchManager(
      makeFakeProfile('sd_web_c', '접속자C'),
      new MockTransport(hub),
      makeCallbacks()
    );

    await clientA.startPresenceTracking();
    expect(latestStatsA.onlineUsers).toBe(1);

    await clientB.startPresenceTracking();
    await clientC.startPresenceTracking();
    await new Promise((r) => setTimeout(r, 25));

    expect(clientA.getPresenceStats().onlineUsers).toBe(3);
    expect(clientB.getPresenceStats().onlineUsers).toBe(3);

    clientC.stopPresenceTracking();
    await new Promise((r) => setTimeout(r, 20));
    expect(clientA.getPresenceStats().onlineUsers).toBe(2);

    clientA.stopPresenceTracking();
    clientB.stopPresenceTracking();
  });
});
