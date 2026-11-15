import {
  SHARE_LOGIN_BACKOFF_CAP_MS,
  SHARE_LOGIN_GRACE_FAILURES,
  SHARE_LOGIN_SHARE_MAX_FAILURES,
  ShareLoginLimiter,
} from '../share/share-rate-limit';

export { SHARE_LOGIN_BACKOFF_CAP_MS, SHARE_LOGIN_GRACE_FAILURES, SHARE_LOGIN_SHARE_MAX_FAILURES };

const SHARE_LOGIN_PATH = /^\/api\/share-access\/([^/]+)\/login$/;

/** 转发的分享登录路径；节点侧看到的来源恒为 `peer:<nodeId>`，限速必须在这一侧按真实 IP 做。 */
export function shareLoginShareId(method: string, path: string): string | null {
  if (method !== 'POST') return null;
  const matched = SHARE_LOGIN_PATH.exec(path);
  if (!matched) return null;
  const id = decodeURIComponent(matched[1] ?? '');
  return id.length > 0 && id.length <= 128 ? id : null;
}

/**
 * 入口侧与节点共用 `ShareLoginLimiter`：干净 IP 不被其它来源的失败 429。
 * 只在上游 401 时记失败；节点进程另有一份计数，阈值各自按完整宽限计算、并不对半。
 */
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
