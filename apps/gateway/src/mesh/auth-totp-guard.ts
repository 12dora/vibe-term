import {
  type UserKeyState,
  decryptTotpSecret,
  encodeBase64url,
  verifyTotpCode,
} from '@vibeterm/shared/auth';
import type { UserRecord } from '../auth/user-store';
import { accountHasTotp } from '../db/local-auth-http';
import { logAuthLoginLocked } from './auth-audit-log';
import type { TotpFactorResult } from './auth-passkey-origin';
import { parseTotpBody } from './auth-totp-record';
import {
  LOGIN_LIMITER_MAX_KEYS,
  LOGIN_LIMITER_PRUNE_EVERY,
  TOTP_FAIL_LIMIT,
  TOTP_FAIL_WINDOW_MS,
  TOTP_LOCK_MAX_SHIFT,
  TOTP_REPLAY_TTL_MS,
} from './mesh-deps';

type FailEntry = {
  hits: number[];
  lockouts: number;
  lockedUntil: number;
};

type ReplayEntry = {
  sessPk: string;
  expiresAt: number;
};

function evictOldest(map: Map<string, unknown>, maxKeys: number): void {
  while (map.size > maxKeys) {
    const victim = map.keys().next().value;
    if (victim === undefined) break;
    map.delete(victim);
  }
}

export class TotpFailureLimiter {
  private readonly entries = new Map<string, FailEntry>();
  private recordCount = 0;

  constructor(private readonly now: () => number) {}

  get size(): number {
    return this.entries.size;
  }

  isLimited(uid: string): boolean {
    if (!uid) return false;
    const entry = this.live(uid);
    return Boolean(entry && entry.lockedUntil > this.now());
  }

  recordFailure(uid: string): void {
    if (!uid) return;
    const now = this.now();
    const entry = this.live(uid) ?? { hits: [], lockouts: 0, lockedUntil: 0 };
    if (entry.lockedUntil > now) {
      this.entries.set(uid, entry);
      return;
    }
    entry.hits.push(now);
    if (entry.hits.length >= TOTP_FAIL_LIMIT) {
      entry.lockouts += 1;
      const shift = Math.min(entry.lockouts - 1, TOTP_LOCK_MAX_SHIFT);
      entry.lockedUntil = now + TOTP_FAIL_WINDOW_MS * 2 ** shift;
      entry.hits = [];
      logAuthLoginLocked({ uid, until: entry.lockedUntil, reason: 'totp_failures' });
    }
    this.entries.set(uid, entry);
    this.pruneIfNeeded();
  }

  clear(uid: string): void {
    this.entries.delete(uid);
  }

  lockedUntil(uid: string): number {
    return this.live(uid)?.lockedUntil ?? 0;
  }

  private live(uid: string): FailEntry | null {
    const entry = this.entries.get(uid);
    if (!entry) return null;
    const now = this.now();
    const cutoff = now - TOTP_FAIL_WINDOW_MS;
    entry.hits = entry.hits.filter((at) => at > cutoff);
    if (entry.hits.length === 0 && entry.lockedUntil <= now && entry.lockouts === 0) {
      this.entries.delete(uid);
      return null;
    }
    return entry;
  }

  private pruneIfNeeded(): void {
    this.recordCount += 1;
    if (this.recordCount % LOGIN_LIMITER_PRUNE_EVERY !== 0) return;
    for (const key of [...this.entries.keys()]) this.live(key);
    evictOldest(this.entries, LOGIN_LIMITER_MAX_KEYS);
  }
}

export type TotpReplayStatus = 'fresh' | 'reuse' | 'conflict';

export class TotpReplayCache {
  private readonly entries = new Map<string, ReplayEntry>();
  private recordCount = 0;

  constructor(private readonly now: () => number) {}

  get size(): number {
    return this.entries.size;
  }

  inspect(uid: string, code: string, sessPk: Uint8Array): TotpReplayStatus {
    const key = replayKey(uid, code);
    const entry = this.entries.get(key);
    const now = this.now();
    if (!entry || entry.expiresAt <= now) {
      if (entry) this.entries.delete(key);
      return 'fresh';
    }
    return entry.sessPk === encodeBase64url(sessPk) ? 'reuse' : 'conflict';
  }

  consume(uid: string, code: string, sessPk: Uint8Array): void {
    const now = this.now();
    this.entries.set(replayKey(uid, code), {
      sessPk: encodeBase64url(sessPk),
      expiresAt: now + TOTP_REPLAY_TTL_MS,
    });
    this.recordCount += 1;
    if (this.recordCount % LOGIN_LIMITER_PRUNE_EVERY !== 0) return;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    evictOldest(this.entries, LOGIN_LIMITER_MAX_KEYS);
  }
}

function replayKey(uid: string, code: string): string {
  return `${uid}\n${code}`;
}

/** 登录路径上的 TOTP 错码桶 + 已消费验证码缓存。 */
export class TotpLoginGuard {
  readonly failures: TotpFailureLimiter;
  readonly replay: TotpReplayCache;

  constructor(now: () => number) {
    this.failures = new TotpFailureLimiter(now);
    this.replay = new TotpReplayCache(now);
  }

  isLimited(uid: string): boolean {
    return this.failures.isLimited(uid);
  }

  recordFailure(uid: string): void {
    this.failures.recordFailure(uid);
  }

  clearFailures(uid: string): void {
    this.failures.clear(uid);
  }

  replayStatus(uid: string, code: string, sessPk: Uint8Array): TotpReplayStatus {
    return this.replay.inspect(uid, code, sessPk);
  }

  consume(uid: string, code: string, sessPk: Uint8Array): void {
    this.replay.consume(uid, code, sessPk);
  }
}

const TOTP_SKIP: TotpFactorResult = { ok: true, verified: false, enrolled: false };
const TOTP_PENDING: TotpFactorResult = { ok: true, verified: false, enrolled: true };
const TOTP_OK: TotpFactorResult = { ok: true, verified: true, enrolled: true };

function rejectTotp(guard: TotpLoginGuard, uid: string): TotpFactorResult {
  guard.recordFailure(uid);
  return { ok: false, code: 'TOTP_INVALID' };
}

export async function verifyLoginTotp(args: {
  user: UserRecord;
  method: string;
  totpBody: unknown;
  sessPk: Uint8Array;
  nowMs: number;
  state: Pick<UserKeyState, 'totp' | 'rootEpoch'>;
  guard: TotpLoginGuard;
}): Promise<TotpFactorResult> {
  if (args.method !== 'root') return TOTP_SKIP;
  if (!accountHasTotp(args.user, args.state.totp != null)) return TOTP_SKIP;
  const parsed = parseTotpBody(args.totpBody);
  if (!parsed) return TOTP_PENDING;
  if (args.guard.isLimited(args.user.id)) return { ok: false, code: 'RATE_LIMITED' };
  const replay = args.guard.replayStatus(args.user.id, parsed.code, args.sessPk);
  if (replay === 'reuse') return TOTP_OK;
  if (replay === 'conflict') return rejectTotp(args.guard, args.user.id);
  return verifyFreshTotp(args, parsed);
}

async function verifyFreshTotp(
  args: {
    user: UserRecord;
    sessPk: Uint8Array;
    nowMs: number;
    state: Pick<UserKeyState, 'totp' | 'rootEpoch'>;
    guard: TotpLoginGuard;
  },
  parsed: { code: string; kTotp: Uint8Array }
): Promise<TotpFactorResult> {
  if (!args.state.totp || args.user.totpRecordSeq == null) {
    return rejectTotp(args.guard, args.user.id);
  }
  try {
    const secret = await decryptTotpSecret(parsed.kTotp, args.state.totp, {
      uid: args.user.id,
      root_epoch: args.state.rootEpoch,
      seq: BigInt(args.user.totpRecordSeq),
    });
    if (!verifyTotpCode(secret, parsed.code, Math.floor(args.nowMs / 1000))) {
      return rejectTotp(args.guard, args.user.id);
    }
    args.guard.consume(args.user.id, parsed.code, args.sessPk);
    args.guard.clearFailures(args.user.id);
    return TOTP_OK;
  } catch {
    return rejectTotp(args.guard, args.user.id);
  }
}
