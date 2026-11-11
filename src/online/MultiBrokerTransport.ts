import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { OnlineTransport, OnlineTransportStatus } from './types';

interface BrokerEndpoint {
  url: string;
  label: string;
}

const BROKER_ENDPOINTS: BrokerEndpoint[] = [
  { url: 'wss://broker.emqx.io:8084/mqtt', label: '글로벌 서버 #1 (EMQX)' },
  { url: 'wss://broker.hivemq.com:8884/mqtt', label: '글로벌 서버 #2 (HiveMQ)' },
  { url: 'wss://test.mosquitto.org:8081/mqtt', label: '글로벌 서버 #3 (Mosquitto)' },
];

export function mqttTopicMatches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  const pParts = pattern.split('/');
  const tParts = topic.split('/');

  for (let i = 0; i < pParts.length; i++) {
    const p = pParts[i];
    if (p === '#') return true;
    if (i >= tParts.length) return false;
    if (p !== '+' && p !== tParts[i]) return false;
  }
  return pParts.length === tParts.length;
}

function resolveMqttConnect(): typeof mqtt.connect {
  const mod = mqtt as unknown as {
    connect?: typeof mqtt.connect;
    default?: { connect?: typeof mqtt.connect };
  };
  if (typeof mod.connect === 'function') return mod.connect;
  if (mod.default && typeof mod.default.connect === 'function') return mod.default.connect;
  throw new Error('MQTT browser client connect function not found.');
}

export class MultiBrokerTransport implements OnlineTransport {
  private client: MqttClient | null = null;
  private status: OnlineTransportStatus = 'disconnected';
  private activeBrokerLabel = '연결 대기';
  private connectPromise: Promise<void> | null = null;
  private activeSubscriptions = new Set<string>();
  private messageHandlers = new Set<(topic: string, data: unknown) => void>();
  private statusHandlers = new Set<(status: OnlineTransportStatus, label: string) => void>();
  private localBus: BroadcastChannel | null = null;
  private clientTag: string;

  constructor(clientId: string) {
    this.clientTag = clientId;
    this.initLocalBus();
  }

  private initLocalBus(): void {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      this.localBus = new BroadcastChannel('sudam_3d_baduk_bus_v1');
      this.localBus.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as { topic?: string; data?: unknown } | undefined;
        if (!msg || typeof msg.topic !== 'string') return;
        for (const sub of this.activeSubscriptions) {
          if (mqttTopicMatches(sub, msg.topic)) {
            this.emitMessage(msg.topic, msg.data);
            break;
          }
        }
      };
    } catch {
      this.localBus = null;
    }
  }

  private setStatus(next: OnlineTransportStatus, label?: string): void {
    this.status = next;
    if (label) this.activeBrokerLabel = label;
    for (const fn of this.statusHandlers) {
      fn(this.status, this.activeBrokerLabel);
    }
  }

  private emitMessage(topic: string, data: unknown): void {
    for (const fn of this.messageHandlers) {
      fn(topic, data);
    }
  }

  public isConnected(): boolean {
    return this.status === 'connected' && Boolean(this.client?.connected);
  }

  public getBrokerLabel(): string {
    return this.activeBrokerLabel;
  }

  public async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.connectWithFailover().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connectWithFailover(): Promise<void> {
    const connectFn = resolveMqttConnect();

    for (let i = 0; i < BROKER_ENDPOINTS.length; i++) {
      const endpoint = BROKER_ENDPOINTS[i];
      this.setStatus('connecting', endpoint.label);

      const connected = await new Promise<boolean>((resolve) => {
        let settled = false;
        const mqttClientId = `${this.clientTag}_${Math.random().toString(36).slice(2, 7)}`;

        const candidate = connectFn(endpoint.url, {
          clientId: mqttClientId,
          clean: true,
          connectTimeout: 5500,
          reconnectPeriod: 3500,
          keepalive: 30,
        });

        const failTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            candidate.end(true);
          } catch {
            // ignore
          }
          resolve(false);
        }, 5800);

        candidate.once('connect', () => {
          if (settled) return;
          settled = true;
          clearTimeout(failTimer);
          this.attachClient(candidate, endpoint.label);
          resolve(true);
        });

        candidate.once('error', () => {
          if (settled) return;
          settled = true;
          clearTimeout(failTimer);
          try {
            candidate.end(true);
          } catch {
            // ignore
          }
          resolve(false);
        });
      });

      if (connected) {
        for (const topic of this.activeSubscriptions) {
          this.client?.subscribe(topic, { qos: 0 });
        }
        return;
      }
    }

    // Even if external WSS is blocked by an offline firewall, keep local BroadcastChannel working gracefully
    if (this.localBus) {
      this.setStatus('connected', '로컬 브라우저 중계 모드');
      return;
    }

    this.setStatus('error', '중계 서버 연결 실패');
    throw new Error('온라인 중계 서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.');
  }

  private attachClient(client: MqttClient, label: string): void {
    if (this.client && this.client !== client) {
      try {
        this.client.end(true);
      } catch {
        // ignore
      }
    }
    this.client = client;
    this.setStatus('connected', label);

    client.on('message', (topic: string, payloadBuf: Uint8Array) => {
      const raw = new TextDecoder().decode(payloadBuf).trim();
      if (!raw) {
        this.emitMessage(topic, null);
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        this.emitMessage(topic, parsed);
      } catch {
        // Ignore malformed payloads on public topics
      }
    });

    client.on('reconnect', () => {
      this.setStatus('reconnecting', label);
    });

    client.on('connect', () => {
      this.setStatus('connected', label);
      for (const topic of this.activeSubscriptions) {
        client.subscribe(topic, { qos: 0 });
      }
    });

    client.on('offline', () => {
      if (this.status !== 'disconnected') {
        this.setStatus('reconnecting', label);
      }
    });
  }

  public disconnect(): void {
    this.activeSubscriptions.clear();
    if (this.client) {
      try {
        this.client.end(true);
      } catch {
        // ignore
      }
      this.client = null;
    }
    this.setStatus('disconnected', '연결 종료');
  }

  public async subscribe(topic: string): Promise<void> {
    this.activeSubscriptions.add(topic);
    if (!this.client || !this.client.connected) return;
    await new Promise<void>((resolve) => {
      this.client!.subscribe(topic, { qos: 0 }, () => resolve());
    });
  }

  public async unsubscribe(topic: string): Promise<void> {
    this.activeSubscriptions.delete(topic);
    if (!this.client || !this.client.connected) return;
    await new Promise<void>((resolve) => {
      this.client!.unsubscribe(topic, () => resolve());
    });
  }

  public publish(topic: string, data: unknown, options?: { retain?: boolean }): void {
    const retain = Boolean(options?.retain);
    const serialized = data === null ? '' : JSON.stringify(data);

    if (this.client && this.client.connected) {
      this.client.publish(topic, serialized, { qos: 0, retain });
    }

    if (this.localBus) {
      try {
        this.localBus.postMessage({ topic, data });
      } catch {
        // ignore
      }
    }
  }

  public onMessage(handler: (topic: string, data: unknown) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  public onStatusChange(
    handler: (status: OnlineTransportStatus, brokerLabel: string) => void
  ): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }
}
