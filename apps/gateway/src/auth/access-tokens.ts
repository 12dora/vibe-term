import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ACCESS_TOKEN_ACTIVE_LIMIT,
  ACCESS_TOKEN_SECRET_PREFIX,
  type AccessTokenDto,
  type AccessTokenScope,
  type CreateAccessTokenRequest,
  type CreateAccessTokenResponse,
  isAccessTokenScope,
} from '@vibeterm/shared';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb as getOrmDb } from '../db/client';
import { accessTokenEvents, accessTokens } from '../db/schema';
import type { AuthDb } from './types';

const DAY_MS = 86_400_000;
const USED_AUDIT_WINDOW_MS = 10 * 60_000;
const LAST_USED_WRITE_MS = 60_000;
const AUDIT_RETENTION_MS = 180 * DAY_MS;
const THROTTLE_MAP_SOFT_CAP = 2_000;
const IP_MAX = 128;
const SECRET_PATTERN = /^vtk_[A-Za-z0-9_-]{43}$/;

export type AccessTokenVerifyFailure = 'unknown' | 'expired' | 'revoked' | 'malformed';

export type AccessTokenVerifyResult =
  | { ok: true; tokenId: string; userId: string; scopes: AccessTokenScope[] }
  | { ok: false; reason: AccessTokenVerifyFailure };

export type AccessTokenVerifyOptions = { ip?: string | null; now?: number };

export class AccessTokenLimitError extends Error {
  constructor() {
    super('access token limit reached');
    this.name = 'AccessTokenLimitError';
  }
}

type TokenRow = typeof accessTokens.$inferSelect;
type RevokedListener = (tokenId: string) => void;

const revokedListeners = new Set<RevokedListener>();

export function hashAccessTokenSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function generateAccessTokenSecret(): string {
  return ACCESS_TOKEN_SECRET_PREFIX + randomBytes(32).toString('base64url');
}

export class AccessTokenService {
  private readonly now: () => number;
  private readonly usedAudit = new Map<string, number>();

  constructor(
    private readonly db: AuthDb = getOrmDb(),
    opts: { now?: () => number } = {}
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  create(
    userId: string,
    req: CreateAccessTokenRequest,
    ip?: string | null
  ): CreateAccessTokenResponse {
    const now = this.now();
    if (this.activeCount(userId, now) >= ACCESS_TOKEN_ACTIVE_LIMIT) {
      throw new AccessTokenLimitError();
    }
    const secret = generateAccessTokenSecret();
    const row: TokenRow = {
      id: crypto.randomUUID(),
      userId,
      name: req.name,
      scopes: JSON.stringify(req.scopes),
      secretHash: hashAccessTokenSecret(secret),
      createdAt: now,
      expiresAt: req.expiresInDays === null ? null : now + req.expiresInDays * DAY_MS,
      lastUsedAt: null,
      lastUsedIp: null,
      revokedAt: null,
    };
    this.db.insert(accessTokens).values(row).run();
    this.audit(row.id, userId, 'created', normalizeIp(ip), now);
    this.prune(now);
    return { token: toDto(row), secret };
  }

  list(userId: string): AccessTokenDto[] {
    return this.db
      .select()
      .from(accessTokens)
      .where(and(eq(accessTokens.userId, userId), isNull(accessTokens.revokedAt)))
      .orderBy(desc(accessTokens.createdAt), desc(accessTokens.id))
      .all()
      .map(toDto);
  }

  revoke(userId: string, id: string, ip?: string | null): boolean {
    const now = this.now();
    const hit = this.db
      .update(accessTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(accessTokens.id, id),
          eq(accessTokens.userId, userId),
          isNull(accessTokens.revokedAt)
        )
      )
      .returning({ id: accessTokens.id })
      .all();
    if (hit.length === 0) return false;
    this.audit(id, userId, 'revoked', normalizeIp(ip), now);
    this.forgetThrottle(id);
    notifyAccessTokenRevoked(id);
    return true;
  }

  verify(secret: string, opts: AccessTokenVerifyOptions = {}): AccessTokenVerifyResult {
    if (typeof secret !== 'string' || !SECRET_PATTERN.test(secret)) {
      return { ok: false, reason: 'malformed' };
    }
    const now = opts.now ?? this.now();
    const hash = hashAccessTokenSecret(secret);
    const row = this.db.select().from(accessTokens).where(eq(accessTokens.secretHash, hash)).get();
    if (!row || !hashesEqual(row.secretHash, hash)) return { ok: false, reason: 'unknown' };
    if (row.revokedAt !== null) return { ok: false, reason: 'revoked' };
    if (row.expiresAt !== null && row.expiresAt <= now) return { ok: false, reason: 'expired' };
    const ip = normalizeIp(opts.ip);
    this.touch(row, ip, now);
    return { ok: true, tokenId: row.id, userId: row.userId, scopes: parseScopes(row.scopes) };
  }

  private touch(row: TokenRow, ip: string | null, now: number): void {
    if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_WRITE_MS) {
      this.db
        .update(accessTokens)
        .set({ lastUsedAt: now, lastUsedIp: ip ?? row.lastUsedIp })
        .where(eq(accessTokens.id, row.id))
        .run();
    }
    if (this.shouldAuditUse(row.id, ip, now)) {
      this.audit(row.id, row.userId, 'used', ip, now);
    }
  }

  private shouldAuditUse(tokenId: string, ip: string | null, now: number): boolean {
    const key = `${tokenId}|${ip ?? ''}`;
    let last: number | null | undefined = this.usedAudit.get(key);
    if (last === undefined) last = this.lastUsedEventAt(tokenId, ip);
    if (last !== null && now - last < USED_AUDIT_WINDOW_MS) {
      this.usedAudit.set(key, last);
      return false;
    }
    this.trimThrottle(now);
    this.usedAudit.set(key, now);
    return true;
  }

  private lastUsedEventAt(tokenId: string, ip: string | null): number | null {
    const row = this.db
      .select({ at: sql<number | null>`max(${accessTokenEvents.at})` })
      .from(accessTokenEvents)
      .where(
        and(
          eq(accessTokenEvents.tokenId, tokenId),
          eq(accessTokenEvents.event, 'used'),
          ip === null ? isNull(accessTokenEvents.ip) : eq(accessTokenEvents.ip, ip)
        )
      )
      .get();
    return row?.at ?? null;
  }

  private trimThrottle(now: number): void {
    if (this.usedAudit.size < THROTTLE_MAP_SOFT_CAP) return;
    for (const [key, at] of this.usedAudit) {
      if (now - at >= USED_AUDIT_WINDOW_MS) this.usedAudit.delete(key);
    }
    if (this.usedAudit.size >= THROTTLE_MAP_SOFT_CAP) this.usedAudit.clear();
  }

  private forgetThrottle(tokenId: string): void {
    const prefix = `${tokenId}|`;
    for (const key of this.usedAudit.keys()) {
      if (key.startsWith(prefix)) this.usedAudit.delete(key);
    }
  }

  private activeCount(userId: string, now: number): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(accessTokens)
      .where(
        and(
          eq(accessTokens.userId, userId),
          isNull(accessTokens.revokedAt),
          or(isNull(accessTokens.expiresAt), gt(accessTokens.expiresAt, now))
        )
      )
      .get();
    return Number(row?.n ?? 0);
  }

  private audit(
    tokenId: string,
    userId: string,
    event: 'created' | 'revoked' | 'used',
    ip: string | null,
    at: number
  ): void {
    this.db.insert(accessTokenEvents).values({ tokenId, userId, event, ip, at }).run();
  }

  /** 清理审计事件、早已撤销以及过期超过保留期仍未撤销的令牌行。 */
  prune(now: number = this.now()): void {
    const cutoff = now - AUDIT_RETENTION_MS;
    this.db.delete(accessTokenEvents).where(lt(accessTokenEvents.at, cutoff)).run();
    this.db.delete(accessTokens).where(lt(accessTokens.revokedAt, cutoff)).run();
    this.db
      .delete(accessTokens)
      .where(and(isNull(accessTokens.revokedAt), lt(accessTokens.expiresAt, cutoff)))
      .run();
  }

  /** 令牌行仍在、未撤销、未过期。长连接（exec 会话）周期性复核用。 */
  isActive(tokenId: string, now: number = this.now()): boolean {
    const row = this.db
      .select({ revokedAt: accessTokens.revokedAt, expiresAt: accessTokens.expiresAt })
      .from(accessTokens)
      .where(eq(accessTokens.id, tokenId))
      .get();
    if (!row || row.revokedAt !== null) return false;
    return row.expiresAt === null || row.expiresAt > now;
  }
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return ip.slice(0, IP_MAX);
}

function parseScopes(raw: string): AccessTokenScope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isAccessTokenScope) : [];
  } catch {
    return [];
  }
}

function toDto(row: TokenRow): AccessTokenDto {
  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
  };
}

let bound: AccessTokenService | null = null;
let fallback: AccessTokenService | null = null;

/** 测试注入用；传 null 恢复默认（全局库）实例。 */
export function bindAccessTokenService(service: AccessTokenService | null): void {
  bound = service;
}

export function getAccessTokenService(): AccessTokenService {
  if (bound) return bound;
  fallback ??= new AccessTokenService();
  return fallback;
}

export function createAccessToken(
  userId: string,
  req: CreateAccessTokenRequest,
  ip?: string | null
): CreateAccessTokenResponse {
  return getAccessTokenService().create(userId, req, ip);
}

export function listAccessTokens(userId: string): AccessTokenDto[] {
  return getAccessTokenService().list(userId);
}

export function revokeAccessToken(userId: string, id: string, ip?: string | null): boolean {
  return getAccessTokenService().revoke(userId, id, ip);
}

export function verifyAccessToken(
  secret: string,
  opts: AccessTokenVerifyOptions = {}
): AccessTokenVerifyResult {
  return getAccessTokenService().verify(secret, opts);
}

/** 任一服务实例撤销令牌后回调（如关闭该令牌的 exec 会话）；返回取消订阅函数。 */
export function onAccessTokenRevoked(listener: RevokedListener): () => void {
  revokedListeners.add(listener);
  return () => {
    revokedListeners.delete(listener);
  };
}

function notifyAccessTokenRevoked(tokenId: string): void {
  for (const listener of [...revokedListeners]) {
    try {
      listener(tokenId);
    } catch {
      // 监听方异常不影响撤销本身
    }
  }
}

export function isAccessTokenActive(tokenId: string): boolean {
  return getAccessTokenService().isActive(tokenId);
}

export function pruneAccessTokens(): void {
  getAccessTokenService().prune();
}
