import type { LocalAuthStatus } from '@tmex/shared';
import type { UserRecord, UserStore } from '../auth/user-store';
import type { HubTlsInfo, HubTlsInfoProvider } from './mesh-deps';

export const AUTH_MODE_CACHE_TTL_MS = 5_000;

export type AuthModeSnapshot = {
  tls: HubTlsInfo;
  localAuth: LocalAuthStatus;
  user: UserRecord | null;
  hub: { nodeId: string | null; publicUrl: string | null };
  closed: boolean;
};

type CacheEntry = {
  snapshot: AuthModeSnapshot;
  expiresAt: number;
  generation: number;
};

let generation = 0;

export function invalidateAuthModeCache(): void {
  generation += 1;
}

export async function withAuthModeInvalidation(
  run: () => Response | Promise<Response>
): Promise<Response> {
  const res = await run();
  if (res.ok) invalidateAuthModeCache();
  return res;
}

export class AuthModeCache {
  private entry: CacheEntry | null = null;

  async get(now: number, load: () => Promise<AuthModeSnapshot>): Promise<AuthModeSnapshot> {
    if (this.entry && this.entry.generation === generation && now < this.entry.expiresAt) {
      return this.entry.snapshot;
    }
    const gen = generation;
    const snapshot = await load();
    if (gen === generation) {
      this.entry = {
        snapshot,
        expiresAt: now + AUTH_MODE_CACHE_TTL_MS,
        generation: gen,
      };
    }
    return snapshot;
  }
}

export async function loadAuthModeTls(
  tlsInfo: HubTlsInfoProvider | undefined
): Promise<HubTlsInfo> {
  return (await tlsInfo?.()) ?? { caFingerprint: null, caPem: null };
}

export function findPrimaryUser(store: UserStore, primaryUserId?: string): UserRecord | null {
  if (primaryUserId) {
    const direct = store.getById(primaryUserId) ?? store.getByUsername(primaryUserId);
    if (direct) return direct;
  }
  for (const cert of store.listCerts()) {
    const user = store.getById(cert.userId);
    if (user) return user;
  }
  for (const node of store.listNodes()) {
    const user = store.getById(node.userId);
    if (user) return user;
  }
  return store.listUsers()[0] ?? null;
}

export function isPasskeyAvailable(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    const secure = url.protocol === 'https:' || host === 'localhost' || host.endsWith('.localhost');
    const ip = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
    const domainOrLocalhost = host === 'localhost' || host.endsWith('.localhost') || !ip;
    return secure && domainOrLocalhost;
  } catch {
    return false;
  }
}
