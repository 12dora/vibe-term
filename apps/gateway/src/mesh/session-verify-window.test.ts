import { describe, expect, test } from 'bun:test';
import { WS_SESSION_VERIFY_MS } from './mesh-deps';
import { sessionVerifyDeadline, sessionVerifyDue } from './session-verify-window';

describe('会话复验窗口', () => {
  test('离过期还远时按整窗复验', () => {
    const now = 10_000;
    const deadline = sessionVerifyDeadline(
      { expiresAt: now + 18 * 60 * 60 * 1000, hardExpiresAt: now + 7 * 24 * 60 * 60 * 1000 },
      now
    );
    expect(deadline).toBe(now + WS_SESSION_VERIFY_MS);
  });

  test('窗口不越过会话自己的过期时刻（TTL 与硬过期取更早的那个）', () => {
    const now = 10_000;
    expect(sessionVerifyDeadline({ expiresAt: now + 30_000, hardExpiresAt: now + 1e9 }, now)).toBe(
      now + 30_000
    );
    expect(sessionVerifyDeadline({ expiresAt: now + 1e9, hardExpiresAt: now + 45_000 }, now)).toBe(
      now + 45_000
    );
  });

  test('已经过期（负差）就是「立刻复验」', () => {
    const now = 10_000;
    expect(sessionVerifyDeadline({ expiresAt: now - 5_000, hardExpiresAt: now + 1e9 }, now)).toBe(
      now
    );
  });

  test('拿不到过期字段（测试替身）时退回整窗，不会算出 NaN 把复验永久关掉', () => {
    const now = 10_000;
    const partial = {} as { expiresAt: number; hardExpiresAt: number };
    expect(sessionVerifyDeadline(partial, now)).toBe(now + WS_SESSION_VERIFY_MS);
  });

  test('到期才复验；时钟往回跳立刻复验', () => {
    const window = { lastVerifyAt: 1_000, nextVerifyAt: 5_000 };
    expect(sessionVerifyDue(window, 4_999)).toBe(false);
    expect(sessionVerifyDue(window, 5_000)).toBe(true);
    // NTP 校正 / 休眠唤醒把 now 拨回到上次复验之前：不能再等下去
    expect(sessionVerifyDue(window, 999)).toBe(true);
  });

  test('初始窗口（全 0）第一次就复验', () => {
    expect(sessionVerifyDue({ lastVerifyAt: 0, nextVerifyAt: 0 }, Date.now())).toBe(true);
  });
});
