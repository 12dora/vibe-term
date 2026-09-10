import { WS_SESSION_VERIFY_MS } from './mesh-deps';

type SessionExpiry = { expiresAt: number; hardExpiresAt: number };

/**
 * 下一次复验的绝对时刻：最长 `WS_SESSION_VERIFY_MS`，但绝不越过会话自己的过期时刻——
 * 否则 TTL / 硬过期会被节流窗口拖软最多一个窗口。拿不到过期字段（测试替身）时按整窗处理。
 */
export function sessionVerifyDeadline(session: SessionExpiry, now: number): number {
  const expiry = Math.min(session.expiresAt, session.hardExpiresAt);
  const remaining = Number.isFinite(expiry) ? Math.max(0, expiry - now) : WS_SESSION_VERIFY_MS;
  return now + Math.min(WS_SESSION_VERIFY_MS, remaining);
}

/** 到期即复验；时钟往回跳（NTP 校正、休眠唤醒）也立刻复验，否则复验会被永远推后。 */
export function sessionVerifyDue(
  window: { lastVerifyAt: number; nextVerifyAt: number },
  now: number
): boolean {
  return now >= window.nextVerifyAt || now < window.lastVerifyAt;
}
