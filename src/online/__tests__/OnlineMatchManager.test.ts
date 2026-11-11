import { describe, expect, it } from 'vitest';
import { BLACK, WHITE, GameConfig } from '../../rules/types';
import { sanitizeNickname, ProfileManager } from '../../profile/ProfileManager';
import { mqttTopicMatches } from '../MultiBrokerTransport';
import { OnlineMatchCallbacks, OnlineMatchManager } from '../OnlineMatchManager';
import {
  OnlineRoleInfo,
  OnlineScoreAgreementState,
  OnlineTransport,
  OnlineTransportStatus,
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

function makeBaseCallbacks(overrides: Partial<OnlineMatchCallbacks> = {}): OnlineMatchCallbacks {
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

describe('Nickname & Online Multiplayer Engine', () => {
  it('sanitizes Korean and English nicknames and enforces 14-char limit', () => {
    expect(sanitizeNickname('  수담명인   홍길동  ')).toBe('수담명인 홍길동');
    expect(sanitizeNickname('<script>악성닉네임123456789</script>')).toBe('script악성닉네임123');
    expect(sanitizeNickname('   \n\t  ')).toBe('');
  });

  it('matches MQTT single-level and multi-level wildcards accurately', () => {
    expect(mqttTopicMatches('sudam/lobby/rooms/+', 'sudam/lobby/rooms/AB23CD')).toBe(true);
    expect(mqttTopicMatches('sudam/lobby/rooms/+', 'sudam/lobby/rooms/AB23CD/extra')).toBe(false);
    expect(mqttTopicMatches('sudam/room/#', 'sudam/room/AB23CD/chat')).toBe(true);
  });

  it('pairs two players automatically via Quick Match with opposite stone colors', async () => {
    const hub = new InMemoryBrokerHub();
    let startA = null as { cfg: GameConfig; role: OnlineRoleInfo } | null;
    let startB = null as { cfg: GameConfig; role: OnlineRoleInfo } | null;

    const managerA = new OnlineMatchManager(
      makeFakeProfile('sd_aaa_100', '청풍기사'),
      new MockTransport(hub),
      makeBaseCallbacks({
        onMatchStart: (cfg, role) => {
          startA = { cfg, role };
        },
      })
    );

    const managerB = new OnlineMatchManager(
      makeFakeProfile('sd_zzz_200', '묘수달인'),
      new MockTransport(hub),
      makeBaseCallbacks({
        onMatchStart: (cfg, role) => {
          startB = { cfg, role };
        },
      })
    );

    await managerA.startQuickMatch(19);
    await managerB.startQuickMatch('any');

    // Allow microtasks in handleQuickMatchSeek -> qm_offer -> qm_accept -> match_start
    await new Promise((r) => setTimeout(r, 30));

    expect(startA).not.toBeNull();
    expect(startB).not.toBeNull();
    expect(startA!.role.roomCode).toBe(startB!.role.roomCode);
    expect(startA!.role.myColor).not.toBe(startB!.role.myColor);
    expect(startA!.cfg.boardSize).toBe(19);
    expect([startA!.cfg.blackName, startA!.cfg.whiteName].sort()).toEqual(
      ['묘수달인', '청풍기사'].sort()
    );

    await managerA.cancelMatchmakingOrRoom();
    await managerB.cancelMatchmakingOrRoom();
  });

  it('creates public room, lists in lobby, joins by code, syncs moves and mutual scoring agreement', async () => {
    const hub = new InMemoryBrokerHub();

    const movesSeenByGuest: Array<{ x: number; y: number }> = [];
    let guestRooms: RoomSummary[] = [];
    let hostRole = null as OnlineRoleInfo | null;
    let guestRole = null as OnlineRoleInfo | null;
    let hostBothAgreed = 0;
    let guestBothAgreed = 0;
    let lastGuestAgreement: OnlineScoreAgreementState | null = null;

    const host = new OnlineMatchManager(
      makeFakeProfile('sd_host_01', '방장흑기사'),
      new MockTransport(hub),
      makeBaseCallbacks({
        onMatchStart: (_cfg, role) => {
          hostRole = role;
        },
        onScoreBothAgreed: () => {
          hostBothAgreed++;
        },
      })
    );

    const guest = new OnlineMatchManager(
      makeFakeProfile('sd_guest_02', '초대백기사'),
      new MockTransport(hub),
      makeBaseCallbacks({
        onOpenRoomsUpdated: (rooms) => {
          guestRooms = rooms;
        },
        onMatchStart: (_cfg, role) => {
          guestRole = role;
        },
        onRemoteMove: (m) => {
          movesSeenByGuest.push({ x: m.x, y: m.y });
        },
        onScoreAgreementChanged: (st) => {
          lastGuestAgreement = st;
        },
        onScoreBothAgreed: () => {
          guestBothAgreed++;
        },
      })
    );

    const created = await host.createRoom({
      title: '13줄 친선 수담방',
      isPublic: true,
      boardSize: 13,
      ruleset: 'korean',
      handicap: 0,
      komi: 6.5,
      mainTimeSeconds: 300,
      byoyomiSeconds: 30,
      byoyomiPeriods: 3,
      hostColorPref: 'black',
    });

    await guest.startWatchingLobby();
    expect(guestRooms.length).toBe(1);
    expect(guestRooms[0].roomCode).toBe(created.roomCode);
    expect(guestRooms[0].hostName).toBe('방장흑기사');

    await guest.joinRoom(created.roomCode);
    await new Promise((r) => setTimeout(r, 20));

    expect(hostRole?.myColor).toBe(BLACK);
    expect(guestRole?.myColor).toBe(WHITE);
    // Open room listing is automatically cleared once match starts
    expect(guestRooms.length).toBe(0);

    // Host plays Black move at (3, 3)
    host.sendMove(3, 3, BLACK, 1);
    expect(movesSeenByGuest).toEqual([{ x: 3, y: 3 }]);

    // Mutual scoring agreement: Host agrees -> Guest toggles dead stone (resets!) -> Both agree
    const mask1 = new Uint8Array(169);
    host.sendScoreAgree(mask1);
    expect(lastGuestAgreement).toEqual({ blackAgreed: true, whiteAgreed: false });
    expect(hostBothAgreed).toBe(0);

    // Guest marks stone #12 dead -> resets agreement to 0/2
    const mask2 = new Uint8Array(169);
    mask2[12] = 1;
    guest.sendDeadToggle(12, 0, mask2);
    expect(host.getScoreAgreement()).toEqual({ blackAgreed: false, whiteAgreed: false });

    // Now both agree on mask2
    host.sendScoreAgree(mask2);
    guest.sendScoreAgree(mask2);
    expect(hostBothAgreed).toBe(1);
    expect(guestBothAgreed).toBe(1);

    await host.cancelMatchmakingOrRoom();
    await guest.cancelMatchmakingOrRoom();
  });
});
