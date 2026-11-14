import { ADMIN_ENCRYPT_PUBLIC_JWK, ADMIN_SIGN_PUBLIC_JWK } from './adminPublicKeys';
import { AdminBanEntry } from './types';

let cachedPublicIpPromise: Promise<string> | null = null;
let cachedVerifyKeyPromise: Promise<CryptoKey> | null = null;
let cachedEncryptKeyPromise: Promise<CryptoKey> | null = null;

function getSubtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new Error('WebCrypto subtle API is unavailable in this environment.');
  }
  return s;
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function sortValueDeterministically(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortValueDeterministically(item));
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sorted: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    sorted[k] = sortValueDeterministically(v);
  }
  return sorted;
}

export function canonicalizePayload(payload: unknown): string {
  return JSON.stringify(sortValueDeterministically(payload));
}

async function getVerifyKey(): Promise<CryptoKey> {
  if (!cachedVerifyKeyPromise) {
    cachedVerifyKeyPromise = getSubtle().importKey(
      'jwk',
      ADMIN_SIGN_PUBLIC_JWK,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
  }
  return cachedVerifyKeyPromise;
}

async function getEncryptKey(): Promise<CryptoKey> {
  if (!cachedEncryptKeyPromise) {
    cachedEncryptKeyPromise = getSubtle().importKey(
      'jwk',
      ADMIN_ENCRYPT_PUBLIC_JWK,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt']
    );
  }
  return cachedEncryptKeyPromise;
}

export async function verifyAdminSignature(payload: unknown, signatureB64: string): Promise<boolean> {
  if (!signatureB64 || typeof signatureB64 !== 'string') return false;
  try {
    const key = await getVerifyKey();
    const canonical = canonicalizePayload(payload);
    const dataBytes = new TextEncoder().encode(canonical);
    const sigBytes = base64ToBytes(signatureB64);
    return await getSubtle().verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      toArrayBuffer(sigBytes),
      toArrayBuffer(dataBytes)
    );
  } catch {
    return false;
  }
}

export async function signPayloadWithPrivateJwk(
  payload: unknown,
  signPrivateJwk: JsonWebKey
): Promise<string> {
  const key = await getSubtle().importKey(
    'jwk',
    signPrivateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const canonical = canonicalizePayload(payload);
  const dataBytes = new TextEncoder().encode(canonical);
  const sig = await getSubtle().sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toArrayBuffer(dataBytes)
  );
  return bytesToBase64(new Uint8Array(sig));
}

export async function hashIpAddress(ip: string): Promise<string> {
  const normalized = ip.trim().toLowerCase();
  const data = new TextEncoder().encode(`sudam-ip-v1:${normalized}`);
  const digest = await getSubtle().digest('SHA-256', toArrayBuffer(data));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function encryptIpForAdmin(ip: string): Promise<string> {
  const key = await getEncryptKey();
  const bytes = new TextEncoder().encode(ip.trim());
  const cipher = await getSubtle().encrypt({ name: 'RSA-OAEP' }, key, toArrayBuffer(bytes));
  return bytesToBase64(new Uint8Array(cipher));
}

export async function decryptIpWithPrivateJwk(
  encryptedB64: string,
  decryptPrivateJwk: JsonWebKey
): Promise<string> {
  const key = await getSubtle().importKey(
    'jwk',
    decryptPrivateJwk,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt']
  );
  const cipherBytes = base64ToBytes(encryptedB64);
  const plain = await getSubtle().decrypt({ name: 'RSA-OAEP' }, key, toArrayBuffer(cipherBytes));
  return new TextDecoder().decode(new Uint8Array(plain));
}

async function fetchWithTimeout(url: string, timeoutMs = 2500): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

export async function detectPublicIp(): Promise<string> {
  if (cachedPublicIpPromise) return cachedPublicIpPromise;
  cachedPublicIpPromise = (async () => {
    if (typeof fetch !== 'function') return 'local-network';

    try {
      const res = await fetchWithTimeout('https://api.ipify.org?format=json', 2500);
      if (res.ok) {
        const json = (await res.json()) as { ip?: string };
        if (json?.ip && typeof json.ip === 'string') {
          return json.ip.trim();
        }
      }
    } catch {
      // Try secondary lookup
    }

    try {
      const res = await fetchWithTimeout('https://www.cloudflare.com/cdn-cgi/trace', 2500);
      if (res.ok) {
        const text = await res.text();
        const match = text.match(/^ip=(.+)$/m);
        if (match && match[1]) {
          return match[1].trim();
        }
      }
    } catch {
      // Offline / restricted fallback
    }

    return 'local-network';
  })();
  return cachedPublicIpPromise;
}

export function maskIpForLabel(ip: string): string {
  const trimmed = ip.trim();
  if (!trimmed || trimmed === 'local-network') return '로컬망';
  if (trimmed.includes('.')) {
    const parts = trimmed.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`;
  }
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':');
    return `${parts.slice(0, 2).join(':')}:*`;
  }
  return 'IP 차단됨';
}

export function isBanActive(ban: AdminBanEntry, now = Date.now()): boolean {
  return ban.expiresAt === null || ban.expiresAt > now;
}

export function findActiveBanForIdentity(
  bans: AdminBanEntry[],
  identity: { accountId?: string; clientId?: string; ipHash?: string },
  now = Date.now()
): AdminBanEntry | null {
  for (const ban of bans) {
    if (!isBanActive(ban, now)) continue;

    const matchAccount =
      (ban.targetType === 'account' || ban.targetType === 'both') &&
      ((ban.accountId && identity.accountId && ban.accountId === identity.accountId) ||
        (ban.clientId && identity.clientId && ban.clientId === identity.clientId));

    const matchIp =
      (ban.targetType === 'ip' || ban.targetType === 'both') &&
      Boolean(ban.ipHash && identity.ipHash && ban.ipHash === identity.ipHash);

    if (matchAccount || matchIp) {
      return ban;
    }
  }
  return null;
}

export function formatBanDurationRemaining(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return '영구 이용 제한 (무기한)';
  const diffMs = Math.max(0, expiresAt - now);
  if (diffMs <= 0) return '만료됨';
  const totalSec = Math.ceil(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  const until = new Date(expiresAt).toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  if (days > 0) return `${days}일 ${hours}시간 남음 (해제: ${until})`;
  if (hours > 0) return `${hours}시간 ${mins}분 남음 (해제: ${until})`;
  if (mins > 0) return `${mins}분 남음 (해제: ${until})`;
  return `${secs}초 남음 (해제: ${until})`;
}
