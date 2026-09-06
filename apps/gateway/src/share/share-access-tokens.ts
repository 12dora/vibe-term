// 分享的访问凭证：口令登录发凭证、请求侧校验与续期、退出即作废。
//
// 从 share-service 拆出来单放一处，是因为登录这条路上有两处竞态要一起看：限流窗口的开合，
// 以及「校验口令的这段时间里站长把口令改了」——后者必须在发凭证之前再看一眼库里的哈希。

import { ShareLoginLimiter } from './share-rate-limit';
import { accessExpiry } from './share-service-support';
import { type ShareRow, type ShareStore, verifySharePassword } from './share-store';
import {
  SHARE_ACCESS_TTL_MS,
  generateShareToken,
  hashShareToken,
  parseShareToken,
} from './share-token';
import type { ShareLoginResult, ShareServiceDeps, VerifiedShareAccess } from './types';

type ShareAccessDeps = Pick<ShareServiceDeps, 'verifyPassword'>;

type LoginFailure = { ok: false; code: 'SHARE_NOT_FOUND' | 'SHARE_ENDED' };

export class ShareAccessManager {
  private readonly limiter: ShareLoginLimiter;

  constructor(
    private readonly store: ShareStore,
    private readonly deps: ShareAccessDeps,
    private readonly now: () => number,
    /** 发现分享已到期时回调服务层收尾（结束录屏、广播 ended）。 */
    private readonly onExpired: (shareId: string) => void
  ) {
    this.limiter = new ShareLoginLimiter(now);
  }

  verify(token: string, now: number): VerifiedShareAccess | null {
    const parsed = parseShareToken(token);
    if (!parsed) return null;
    const raw = `${parsed.shareId}.${parsed.secret}`;
    const access = this.store.findAccessToken(hashShareToken(raw));
    if (!access || access.shareId !== parsed.shareId) return null;
    const share = this.store.get(access.shareId);
    if (!share || share.state !== 'active') return null;
    if (share.expiresAt !== null && share.expiresAt <= now) {
      this.onExpired(share.id);
      return null;
    }
    if (access.expiresAt <= now) {
      this.store.deleteAccessToken(hashShareToken(raw));
      return null;
    }
    const expiresAt = this.renew(access.id, access.expiresAt, share.expiresAt, now);
    return {
      scope: { shareId: share.id, deviceId: share.deviceId, windowId: share.windowId },
      accessId: access.id,
      expiresAt,
      renewed: expiresAt !== access.expiresAt,
      maxAgeSec: Math.max(1, Math.ceil((expiresAt - now) / 1000)),
    };
  }

  async login(shareId: string, password: string, clientIp: string): Promise<ShareLoginResult> {
    const opening = this.usableShare(shareId);
    if (!opening.ok) return opening;
    const attempt = this.limiter.begin(shareId, clientIp);
    if (!attempt.ok) {
      return { ok: false, code: 'SHARE_LOGIN_LOCKED', retryAfterMs: attempt.retryAfterMs };
    }
    const stored = this.store.passwordHash(shareId);
    let valid = false;
    try {
      const verify = this.deps.verifyPassword ?? verifySharePassword;
      valid = stored ? await verify(stored, password ?? '') : false;
    } finally {
      this.limiter.settle(shareId, clientIp, valid);
    }
    if (!valid) {
      const retryAfterMs = this.limiter.lockedFor(shareId, clientIp);
      return retryAfterMs > 0
        ? { ok: false, code: 'SHARE_LOGIN_LOCKED', retryAfterMs }
        : { ok: false, code: 'SHARE_PASSWORD_INVALID' };
    }
    // 校验 argon2 要几十到几百毫秒，站长的改密可能正好落在这中间：改密会作废全部凭证，
    // 若这里照发不误，拿旧口令的人反而绕过了改密。发凭证前必须再确认哈希还是刚才那一份。
    const settled = this.usableShare(shareId);
    if (!settled.ok) return settled;
    if (this.store.passwordHash(shareId) !== stored) {
      return { ok: false, code: 'SHARE_PASSWORD_INVALID' };
    }
    return this.issue(settled.share, clientIp);
  }

  logout(token: string): void {
    const parsed = parseShareToken(token);
    if (!parsed) return;
    this.store.deleteAccessToken(hashShareToken(`${parsed.shareId}.${parsed.secret}`));
  }

  private usableShare(shareId: string): { ok: true; share: ShareRow } | LoginFailure {
    const share = this.store.get(shareId);
    if (!share) return { ok: false, code: 'SHARE_NOT_FOUND' };
    if (share.state !== 'active') return { ok: false, code: 'SHARE_ENDED' };
    if (share.expiresAt !== null && share.expiresAt <= this.now()) {
      this.onExpired(shareId);
      return { ok: false, code: 'SHARE_ENDED' };
    }
    return { ok: true, share };
  }

  private issue(share: ShareRow, clientIp: string): ShareLoginResult {
    const now = this.now();
    const token = generateShareToken(share.id);
    const expiresAt = accessExpiry(share.expiresAt, now);
    this.store.createAccessToken({
      id: hashShareToken(token).slice(0, 32),
      shareId: share.id,
      tokenHash: hashShareToken(token),
      clientIp: clientIp || null,
      createdAt: now,
      expiresAt,
    });
    return {
      ok: true,
      token,
      expiresAt,
      maxAgeSec: Math.max(1, Math.ceil((expiresAt - now) / 1000)),
    };
  }

  private renew(
    accessId: string,
    current: number,
    shareExpiresAt: number | null,
    now: number
  ): number {
    if (current - now > SHARE_ACCESS_TTL_MS / 2) return current;
    const target = accessExpiry(shareExpiresAt, now);
    if (target <= current) return current;
    this.store.renewAccessToken(accessId, target, now);
    return target;
  }
}
