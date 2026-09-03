import type { LocalAuthStatus, TmexRoles } from '@tmex/shared';
import { eq } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { config } from '../config';
import { getDb as getOrmDb } from './client';
import { localAuthSettings, users } from './schema';

export const LOCAL_AUTH_ID = 'default';

const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MIN_PASSWORD_LEN = 8;

export interface LocalAuthStoreLike {
  getEnabled(): boolean;
  setEnabled(enabled: boolean): void;
}

export class MemoryLocalAuthStore implements LocalAuthStoreLike {
  private enabled = false;

  getEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

export class LocalAuthStore implements LocalAuthStoreLike {
  constructor(private readonly db: AuthDb = getOrmDb()) {}

  getEnabled(): boolean {
    try {
      const row = this.db
        .select()
        .from(localAuthSettings)
        .where(eq(localAuthSettings.id, LOCAL_AUTH_ID))
        .get();
      return Boolean(row?.enabled);
    } catch {
      return false;
    }
  }

  setEnabled(enabled: boolean): void {
    const now = new Date().toISOString();
    this.db
      .insert(localAuthSettings)
      .values({ id: LOCAL_AUTH_ID, enabled, updatedAt: now })
      .onConflictDoUpdate({
        target: localAuthSettings.id,
        set: { enabled, updatedAt: now },
      })
      .run();
  }
}

export function buildLocalAuthStatus(input: {
  standalone: boolean;
  enabled: boolean;
  credentialsPresent: boolean;
}): LocalAuthStatus {
  const supported = input.standalone;
  return {
    supported,
    enabled: input.enabled,
    effective: supported && input.enabled && input.credentialsPresent,
    credentialsPresent: input.credentialsPresent,
  };
}

export function standaloneClosedModeFields() {
  return {
    mode: 'none' as const,
    uid: null,
    username: null,
    kdfParams: null,
    passkeysForThisOrigin: false,
    totpEnabled: false,
    rootEpoch: null,
    rootPublicKey: null,
    hubNodeId: null,
    hubPublicUrl: null,
  };
}

export type LocalAuthToggleOk = { ok: true; enabled: boolean };
export type LocalAuthDenied = { ok: false; code: string; status: number };
export type LocalAuthToggleDecision = LocalAuthToggleOk | LocalAuthDenied;

export function decideLocalAuthToggle(input: {
  standalone: boolean;
  wantEnabled: boolean;
  credentialsPresent: boolean;
  loopback: boolean;
  authenticated: boolean;
}): LocalAuthToggleDecision {
  if (!input.standalone) return { ok: false, code: 'not_standalone', status: 404 };
  if (!input.authenticated && !input.loopback) {
    return { ok: false, code: 'LOCAL_ONLY', status: 403 };
  }
  if (input.wantEnabled && !input.credentialsPresent) {
    return { ok: false, code: 'CREDENTIALS_REQUIRED', status: 409 };
  }
  return { ok: true, enabled: input.wantEnabled };
}

export type LocalAuthBootstrapDecision = { ok: true } | LocalAuthDenied;

export function decideLocalAuthBootstrap(input: {
  standalone: boolean;
  enabled: boolean;
  credentialsPresent: boolean;
  loopback: boolean;
}): LocalAuthBootstrapDecision {
  if (!input.standalone) return { ok: false, code: 'not_standalone', status: 404 };
  if (!input.loopback) return { ok: false, code: 'LOCAL_ONLY', status: 403 };
  if (input.enabled) return { ok: false, code: 'LOCAL_AUTH_ENABLED', status: 409 };
  if (input.credentialsPresent) return { ok: false, code: 'CREDENTIALS_EXIST', status: 409 };
  return { ok: true };
}

export function validateLocalAuthUsername(username: string): LocalAuthDenied | { ok: true } {
  if (!USERNAME_RE.test(username)) {
    return { ok: false, code: 'invalid_username', status: 400 };
  }
  return { ok: true };
}

export function validateLocalAuthPassword(password: string): LocalAuthDenied | { ok: true } {
  if (password.length < MIN_PASSWORD_LEN) {
    return { ok: false, code: 'weak_password', status: 400 };
  }
  return { ok: true };
}

export function defaultLoginEnforced(
  roles: TmexRoles = config.roles,
  localAuthEffective: () => boolean = readLocalAuthEffective
): boolean {
  return roles.hub || roles.node || localAuthEffective();
}

export function readLocalAuthEffective(): boolean {
  try {
    if (!new LocalAuthStore().getEnabled()) return false;
    const row = getOrmDb().select({ id: users.id }).from(users).limit(1).get();
    return Boolean(row);
  } catch {
    return false;
  }
}

export { isLoopbackClientIp } from '../mesh/address-class';
