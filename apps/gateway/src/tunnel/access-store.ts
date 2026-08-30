import type { TunnelAccessPolicyRule, TunnelAccessStatus, TunnelMode } from '@tmex/shared';
import { eq } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { decryptWithContext, encrypt } from '../crypto';
import { tunnelAccess } from '../db/schema';
import { parseAccessRulesJson } from './access-rules';
import { sanitizeAccessError } from './access-sanitize';

export const TUNNEL_ACCESS_ID = 'default';
const ACCESS_SCOPE = 'tunnel_access';

export type TunnelAccessPersisted = {
  accountId: string | null;
  apiTokenEnc: string | null;
  teamDomain: string | null;
  appId: string | null;
  aud: string | null;
  hostname: string | null;
  rules: TunnelAccessPolicyRule[];
  enforceJwt: boolean;
  lastError: string | null;
  /** 全部 bypass 应用 id；契约 bypassAppId 取第一项（/hub/） */
  bypassAppIds: string[];
  updatedAt: string;
};

export const DEFAULT_TUNNEL_ACCESS: TunnelAccessPersisted = {
  accountId: null,
  apiTokenEnc: null,
  teamDomain: null,
  appId: null,
  aud: null,
  hostname: null,
  rules: [],
  enforceJwt: false,
  lastError: null,
  bypassAppIds: [],
  updatedAt: '',
};

export type TunnelAccessPatch = Partial<Omit<TunnelAccessPersisted, 'updatedAt'>> & {
  apiToken?: string | null;
};

export interface TunnelAccessStoreLike {
  get(): TunnelAccessPersisted;
  save(patch: TunnelAccessPatch): Promise<TunnelAccessPersisted>;
  getApiToken(): Promise<string | null>;
}

export function computeAccessEffective(opts: {
  configured: boolean;
  enforceJwt: boolean;
  accessHostname: string | null;
  tunnelMode: TunnelMode;
  tunnelHostname: string | null;
}): boolean {
  if (opts.tunnelMode !== 'named') return false;
  return Boolean(
    opts.configured &&
      opts.enforceJwt &&
      opts.accessHostname &&
      opts.accessHostname === opts.tunnelHostname
  );
}

export function parseBypassAppIds(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  const text = raw.trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is string => typeof v === 'string' && Boolean(v.trim()));
    } catch {
      return [];
    }
  }
  return [text];
}

export function serializeBypassAppIds(ids: string[]): string | null {
  if (!ids.length) return null;
  return JSON.stringify(ids);
}

export function accessStatusFrom(
  row: TunnelAccessPersisted,
  opts?: { tunnelMode?: TunnelMode; tunnelHostname?: string | null }
): TunnelAccessStatus {
  const configured = Boolean(row.appId && row.aud && row.hostname);
  return {
    hasCredentials: Boolean(row.apiTokenEnc && row.accountId),
    accountId: row.accountId,
    teamDomain: row.teamDomain,
    configured,
    appId: row.appId,
    aud: row.aud,
    hostname: row.hostname,
    rules: [...row.rules],
    enforceJwt: row.enforceJwt,
    effective: computeAccessEffective({
      configured,
      enforceJwt: row.enforceJwt,
      accessHostname: row.hostname,
      tunnelMode: opts?.tunnelMode ?? 'off',
      tunnelHostname: opts?.tunnelHostname ?? null,
    }),
    bypassAppId: row.bypassAppIds[0] ?? null,
    lastError: row.lastError,
  };
}

export class MemoryTunnelAccessStore implements TunnelAccessStoreLike {
  private row: TunnelAccessPersisted = { ...DEFAULT_TUNNEL_ACCESS, rules: [], bypassAppIds: [] };
  private apiToken: string | null = null;

  get(): TunnelAccessPersisted {
    return { ...this.row, rules: [...this.row.rules], bypassAppIds: [...this.row.bypassAppIds] };
  }

  async save(patch: TunnelAccessPatch): Promise<TunnelAccessPersisted> {
    let next = patch;
    if ('apiToken' in patch) {
      this.apiToken = patch.apiToken ?? null;
      next = { ...patch, apiTokenEnc: patch.apiToken ? 'enc' : null };
    }
    this.row = applyAccessPatch(this.row, next);
    return this.get();
  }

  async getApiToken(): Promise<string | null> {
    return this.apiToken;
  }
}

export class TunnelAccessStore implements TunnelAccessStoreLike {
  constructor(private readonly db: AuthDb) {}

  get(): TunnelAccessPersisted {
    try {
      const row = this.db
        .select()
        .from(tunnelAccess)
        .where(eq(tunnelAccess.id, TUNNEL_ACCESS_ID))
        .get();
      if (!row) return { ...DEFAULT_TUNNEL_ACCESS, rules: [], bypassAppIds: [] };
      return {
        accountId: row.accountId ?? null,
        apiTokenEnc: row.apiTokenEnc ?? null,
        teamDomain: row.teamDomain ?? null,
        appId: row.appId ?? null,
        aud: row.aud ?? null,
        hostname: row.hostname ?? null,
        rules: parseAccessRulesJson(row.rulesJson),
        enforceJwt: Boolean(row.enforceJwt),
        lastError: row.lastError ?? null,
        bypassAppIds: parseBypassAppIds(row.bypassAppId),
        updatedAt: row.updatedAt,
      };
    } catch {
      return { ...DEFAULT_TUNNEL_ACCESS, rules: [], bypassAppIds: [] };
    }
  }

  async save(patch: TunnelAccessPatch): Promise<TunnelAccessPersisted> {
    const current = this.get();
    let apiTokenEnc = current.apiTokenEnc;
    if ('apiToken' in patch) {
      apiTokenEnc = patch.apiToken ? await encrypt(patch.apiToken) : null;
    } else if (patch.apiTokenEnc !== undefined) {
      apiTokenEnc = patch.apiTokenEnc;
    }
    const next = applyAccessPatch({ ...current, apiTokenEnc }, patch);
    const values = {
      id: TUNNEL_ACCESS_ID,
      accountId: next.accountId,
      apiTokenEnc: next.apiTokenEnc,
      teamDomain: next.teamDomain,
      appId: next.appId,
      aud: next.aud,
      hostname: next.hostname,
      rulesJson: JSON.stringify(next.rules),
      enforceJwt: next.enforceJwt,
      lastError: next.lastError,
      bypassAppId: serializeBypassAppIds(next.bypassAppIds),
      updatedAt: next.updatedAt,
    };
    this.db
      .insert(tunnelAccess)
      .values(values)
      .onConflictDoUpdate({
        target: tunnelAccess.id,
        set: {
          accountId: values.accountId,
          apiTokenEnc: values.apiTokenEnc,
          teamDomain: values.teamDomain,
          appId: values.appId,
          aud: values.aud,
          hostname: values.hostname,
          rulesJson: values.rulesJson,
          enforceJwt: values.enforceJwt,
          lastError: values.lastError,
          bypassAppId: values.bypassAppId,
          updatedAt: values.updatedAt,
        },
      })
      .run();
    return next;
  }

  async getApiToken(): Promise<string | null> {
    const row = this.get();
    if (!row.apiTokenEnc) return null;
    return decryptWithContext(row.apiTokenEnc, {
      scope: ACCESS_SCOPE,
      entityId: TUNNEL_ACCESS_ID,
      field: 'api_token',
    });
  }
}

function applyAccessPatch(
  current: TunnelAccessPersisted,
  patch: TunnelAccessPatch
): TunnelAccessPersisted {
  const lastError =
    patch.lastError === undefined
      ? current.lastError
      : patch.lastError
        ? sanitizeAccessError(patch.lastError)
        : null;
  return {
    accountId: patch.accountId !== undefined ? patch.accountId : current.accountId,
    apiTokenEnc: patch.apiTokenEnc !== undefined ? patch.apiTokenEnc : current.apiTokenEnc,
    teamDomain: patch.teamDomain !== undefined ? patch.teamDomain : current.teamDomain,
    appId: patch.appId !== undefined ? patch.appId : current.appId,
    aud: patch.aud !== undefined ? patch.aud : current.aud,
    hostname: patch.hostname !== undefined ? patch.hostname : current.hostname,
    rules: patch.rules !== undefined ? patch.rules : current.rules,
    enforceJwt: patch.enforceJwt ?? current.enforceJwt,
    lastError,
    bypassAppIds: patch.bypassAppIds !== undefined ? patch.bypassAppIds : current.bypassAppIds,
    updatedAt: new Date().toISOString(),
  };
}
