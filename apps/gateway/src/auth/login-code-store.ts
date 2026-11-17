import { LOGIN_CODE_ERRORS, type LoginCodeState } from '@vibeterm/shared';
import { LOGIN_CODE_TTL_MS } from '@vibeterm/shared/auth';
import type { DelegationMethod } from './types';

export const LOGIN_CODE_USER_PENDING_CAP = 32;
export const LOGIN_CODE_GLOBAL_CAP = 1024;

export type LoginCodeSecond = 'totp' | 'passkey' | 'waived' | 'none';

export interface LoginCodeGrant {
  hashHex: string;
  uid: string;
  method: DelegationMethod;
  /** 委托里的 credential_id 原文（通行密钥委托才有），兑换时原样用于签会话。 */
  credentialId: string | null;
  second: LoginCodeSecond;
  createdVia: string;
  createdAt: number;
  expiresAt: number;
  state: LoginCodeState;
  usedAt: number | null;
}

export type LoginCodeCreateInput = Omit<
  LoginCodeGrant,
  'createdAt' | 'expiresAt' | 'state' | 'usedAt'
>;

export type LoginCodeCreateResult =
  | { ok: true; grant: LoginCodeGrant }
  | { ok: false; reason: 'limit' | 'duplicate' };

export type LoginCodeConsumeResult =
  | { ok: true; grant: LoginCodeGrant }
  | { ok: false; code: string };

const STATE_ERROR: Record<Exclude<LoginCodeState, 'pending'>, string> = {
  used: LOGIN_CODE_ERRORS.used,
  expired: LOGIN_CODE_ERRORS.expired,
  revoked: LOGIN_CODE_ERRORS.revoked,
};

/**
 * 待兑换登录命令（仅内存，重启即失效）。已用 / 过期 / 作废的条目再保留一个 TTL，
 * 供持码人查询状态，之后在下一次访问时清掉。
 */
export class LoginCodeStore {
  private readonly entries = new Map<string, LoginCodeGrant>();
  private readonly nowFn: () => number;

  constructor(options?: { now?: () => number }) {
    this.nowFn = options?.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  create(input: LoginCodeCreateInput): LoginCodeCreateResult {
    const now = this.sweep();
    if (this.entries.has(input.hashHex)) return { ok: false, reason: 'duplicate' };
    if (this.entries.size >= LOGIN_CODE_GLOBAL_CAP) return { ok: false, reason: 'limit' };
    if (this.pendingCount(input.uid, now) >= LOGIN_CODE_USER_PENDING_CAP) {
      return { ok: false, reason: 'limit' };
    }
    const grant: LoginCodeGrant = {
      ...input,
      createdAt: now,
      expiresAt: now + LOGIN_CODE_TTL_MS,
      state: 'pending',
      usedAt: null,
    };
    this.entries.set(input.hashHex, grant);
    return { ok: true, grant: { ...grant } };
  }

  get(hashHex: string): LoginCodeGrant | null {
    this.sweep();
    const grant = this.entries.get(hashHex);
    return grant ? { ...grant } : null;
  }

  /** 同步完成「检查 + 置为已用」，并发兑换只有第一个拿到 ok。 */
  consume(hashHex: string): LoginCodeConsumeResult {
    const now = this.sweep();
    const grant = this.entries.get(hashHex);
    if (!grant) return { ok: false, code: LOGIN_CODE_ERRORS.invalid };
    if (grant.state !== 'pending') return { ok: false, code: STATE_ERROR[grant.state] };
    grant.state = 'used';
    grant.usedAt = now;
    return { ok: true, grant: { ...grant } };
  }

  revoke(hashHex: string): LoginCodeGrant | null {
    this.sweep();
    const grant = this.entries.get(hashHex);
    if (!grant) return null;
    if (grant.state === 'pending') grant.state = 'revoked';
    return { ...grant };
  }

  revokeWhere(match: (grant: LoginCodeGrant) => boolean): number {
    this.sweep();
    let revoked = 0;
    for (const grant of this.entries.values()) {
      if (grant.state === 'pending' && match(grant)) {
        grant.state = 'revoked';
        revoked += 1;
      }
    }
    return revoked;
  }

  /** 先把到期的待兑换条目标记为过期，再删掉超出保留期的条目；返回本次使用的时刻。 */
  sweep(now = this.nowFn()): number {
    for (const [key, grant] of this.entries) {
      if (grant.state === 'pending' && now >= grant.expiresAt) grant.state = 'expired';
      if (now >= grant.expiresAt + LOGIN_CODE_TTL_MS) this.entries.delete(key);
    }
    return now;
  }

  private pendingCount(uid: string, now: number): number {
    let count = 0;
    for (const grant of this.entries.values()) {
      if (grant.uid === uid && grant.state === 'pending' && now < grant.expiresAt) count += 1;
    }
    return count;
  }
}
