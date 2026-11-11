export interface PlayerProfile {
  clientId: string;
  nickname: string;
}

const LOCAL_STORAGE_KEY = 'sudam_player_profile_v1';
const SESSION_CLIENT_KEY = 'sudam_tab_client_id_v1';
const SESSION_NICK_KEY = 'sudam_tab_nickname_v1';

const BADUK_TITLES = ['수담기사', '반상명인', '오석기성', '청풍국수', '묘수탐구', '초읽기달인'];

export function sanitizeNickname(raw: string): string {
  const stripped = raw
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(stripped);
  return chars.slice(0, 14).join('').trim();
}

export function generateRandomClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `sd_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `sd_${ts}_${rand}`;
}

export function generateDefaultNickname(): string {
  const prefix = BADUK_TITLES[Math.floor(Math.random() * BADUK_TITLES.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}_${num}`;
}

export class ProfileManager {
  private clientId: string;
  private nickname: string;
  private listeners: Set<(nickname: string) => void> = new Set();

  constructor() {
    this.clientId = this.loadOrCreateClientId();
    this.nickname = this.loadOrCreateNickname();
  }

  private loadOrCreateClientId(): string {
    try {
      const existing = window.sessionStorage.getItem(SESSION_CLIENT_KEY);
      if (existing && existing.startsWith('sd_')) {
        return existing;
      }
      const created = generateRandomClientId();
      window.sessionStorage.setItem(SESSION_CLIENT_KEY, created);
      return created;
    } catch {
      return generateRandomClientId();
    }
  }

  private loadOrCreateNickname(): string {
    try {
      const tabNick = window.sessionStorage.getItem(SESSION_NICK_KEY);
      if (tabNick) {
        const cleanTab = sanitizeNickname(tabNick);
        if (cleanTab.length > 0) return cleanTab;
      }

      const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { nickname?: string };
        if (parsed.nickname) {
          const clean = sanitizeNickname(parsed.nickname);
          if (clean.length > 0) {
            window.sessionStorage.setItem(SESSION_NICK_KEY, clean);
            return clean;
          }
        }
      }
    } catch {
      // Ignore storage access errors in restricted modes
    }

    const fallback = generateDefaultNickname();
    this.persistNickname(fallback);
    return fallback;
  }

  private persistNickname(nick: string): void {
    try {
      window.sessionStorage.setItem(SESSION_NICK_KEY, nick);
      window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ nickname: nick }));
    } catch {
      // Ignore storage quota / privacy mode errors
    }
  }

  public getProfile(): PlayerProfile {
    return {
      clientId: this.clientId,
      nickname: this.nickname,
    };
  }

  public getClientId(): string {
    return this.clientId;
  }

  public getNickname(): string {
    return this.nickname;
  }

  public setNickname(rawInput: string): string {
    const cleaned = sanitizeNickname(rawInput);
    const next = cleaned.length > 0 ? cleaned : this.nickname;
    const changed = next !== this.nickname;
    this.nickname = next;
    this.persistNickname(next);

    if (changed) {
      for (const fn of this.listeners) {
        fn(this.nickname);
      }
    }
    return this.nickname;
  }

  public onChange(listener: (nickname: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
