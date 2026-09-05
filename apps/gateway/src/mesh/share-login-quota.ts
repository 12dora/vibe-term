import {
  SHARE_LOGIN_MAX_FAILURES,
  SHARE_LOGIN_WINDOW_MS,
  ShareLoginLimiter,
} from '../share/share-rate-limit';

export { SHARE_LOGIN_MAX_FAILURES, SHARE_LOGIN_WINDOW_MS };

const SHARE_LOGIN_PATH = /^\/api\/share-access\/([^/]+)\/login$/;

/** Hub 转发的分享登录路径；节点侧看到的来源恒为 `peer:<hubNodeId>`，限速必须在这一侧按真实 IP 做。 */
export function shareLoginShareId(method: string, path: string): string | null {
  if (method !== 'POST') return null;
  const matched = SHARE_LOGIN_PATH.exec(path);
  if (!matched) return null;
  const id = decodeURIComponent(matched[1] ?? '');
  return id.length > 0 && id.length <= 128 ? id : null;
}

/** 按（来源 IP，分享 id）计失败：窗口内累计到上限即 429，语义与节点侧 `SHARE_LOGIN_LOCKED` 一致。 */
export class ShareLoginQuota {
  private readonly limiter: ShareLoginLimiter;

  constructor(now: () => number = Date.now) {
    this.limiter = new ShareLoginLimiter(now);
  }

  get size(): number {
    return this.limiter.size;
  }

  lockedFor(shareId: string, clientIp: string): number {
    return this.limiter.lockedFor(shareId, clientIp);
  }

  recordFailure(shareId: string, clientIp: string): void {
    this.limiter.recordFailure(shareId, clientIp);
  }

  reset(shareId: string, clientIp: string): void {
    this.limiter.reset(shareId, clientIp);
  }

  clear(): void {
    this.limiter.clear();
  }
}
