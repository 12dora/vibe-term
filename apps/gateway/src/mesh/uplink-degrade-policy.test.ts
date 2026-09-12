import { describe, expect, test } from 'bun:test';
import {
  UPLINK_DEGRADE_MAX_PER_HOUR,
  UPLINK_DEGRADE_MIN_INTERVAL_MS,
  UPLINK_DEGRADE_WINDOW_MS,
  type UplinkDegradeInput,
  decideUplinkDegrade,
  isUplinkHeartbeatSlow,
  uplinkDegradeSlowThresholdMs,
  uplinkReraceBudgetInWindow,
} from './uplink-degrade-policy';

const NOW = 10_000_000;

function input(patch: Partial<UplinkDegradeInput> = {}): UplinkDegradeInput {
  return {
    heartbeatRttMs: 200,
    consecutiveSlow: 3,
    bestKnownMs: 100,
    linkAgeMs: 60_000,
    inFlightStreams: 0,
    lastReraceAt: null,
    reraces: { count: 0, windowStartedAt: NOW },
    now: NOW,
    ...patch,
  };
}

function reasonOf(patch: Partial<UplinkDegradeInput>): string {
  const decision = decideUplinkDegrade(input(patch));
  return decision.rerace ? 'rerace' : decision.reason;
}

describe('uplinkDegradeSlowThresholdMs', () => {
  test('小 RTT 用绝对增量，大 RTT 用倍数', () => {
    expect(uplinkDegradeSlowThresholdMs(20)).toBe(60);
    expect(uplinkDegradeSlowThresholdMs(90)).toBe(135);
  });
});

describe('isUplinkHeartbeatSlow', () => {
  test('严格大于阈值才算慢', () => {
    expect(isUplinkHeartbeatSlow(150, 100)).toBe(false);
    expect(isUplinkHeartbeatSlow(151, 100)).toBe(true);
  });
});

describe('decideUplinkDegrade', () => {
  test('慢路径触发并带上当前值与最佳值', () => {
    expect(decideUplinkDegrade(input())).toEqual({
      rerace: true,
      reason: 'slow-path',
      currentMs: 200,
      bestMs: 100,
    });
  });

  test('测量门：rtt / 连续慢心跳 / 链路年龄 / 最佳值', () => {
    expect(reasonOf({ heartbeatRttMs: null })).toBe('no-rtt');
    expect(reasonOf({ heartbeatRttMs: Number.NaN })).toBe('no-rtt');
    expect(reasonOf({ consecutiveSlow: 2 })).toBe('consecutive');
    expect(reasonOf({ linkAgeMs: 59_999 })).toBe('age');
    expect(reasonOf({ bestKnownMs: null })).toBe('no-best');
  });

  test('有在途流时等待，不消耗预算', () => {
    expect(reasonOf({ inFlightStreams: 1 })).toBe('busy');
    expect(reasonOf({ inFlightStreams: 2 })).toBe('busy');
  });

  test('阈值：max(1.5×best, best+40) 之内不动', () => {
    expect(reasonOf({ heartbeatRttMs: 150, bestKnownMs: 100 })).toBe('within-threshold');
    expect(reasonOf({ heartbeatRttMs: 151, bestKnownMs: 100 })).toBe('rerace');
    expect(reasonOf({ heartbeatRttMs: 59, bestKnownMs: 20 })).toBe('within-threshold');
    expect(reasonOf({ heartbeatRttMs: 61, bestKnownMs: 20 })).toBe('rerace');
  });

  test('预算：窗口内满 3 次拦住，窗口过期自动归零', () => {
    const full = { count: UPLINK_DEGRADE_MAX_PER_HOUR, windowStartedAt: NOW - 1_000 };
    expect(reasonOf({ reraces: full })).toBe('budget');
    const stale = {
      count: UPLINK_DEGRADE_MAX_PER_HOUR,
      windowStartedAt: NOW - UPLINK_DEGRADE_WINDOW_MS,
    };
    expect(reasonOf({ reraces: stale })).toBe('rerace');
  });

  test('两次之间至少 2 分钟', () => {
    expect(reasonOf({ lastReraceAt: NOW - UPLINK_DEGRADE_MIN_INTERVAL_MS + 1 })).toBe('cooldown');
    expect(reasonOf({ lastReraceAt: NOW - UPLINK_DEGRADE_MIN_INTERVAL_MS })).toBe('rerace');
  });
});

describe('uplinkReraceBudgetInWindow', () => {
  test('窗口未过期原样返回，过期归零并重开窗口', () => {
    const fresh = { count: 2, windowStartedAt: NOW - 1 };
    expect(uplinkReraceBudgetInWindow(fresh, NOW)).toBe(fresh);
    expect(
      uplinkReraceBudgetInWindow({ count: 2, windowStartedAt: NOW - UPLINK_DEGRADE_WINDOW_MS }, NOW)
    ).toEqual({
      count: 0,
      windowStartedAt: NOW,
    });
  });
});
