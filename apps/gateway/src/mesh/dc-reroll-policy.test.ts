import { describe, expect, test } from 'bun:test';
import {
  DC_REROLL_MAX_PER_HOUR,
  DC_REROLL_MIN_INTERVAL_MS,
  DC_REROLL_WINDOW_MS,
  type DcRerollInput,
  dcRerollBudgetInWindow,
  dcRerollSlowThresholdMs,
  decideDcReroll,
} from './dc-reroll-policy';

const NOW = 10_000_000;

function input(patch: Partial<DcRerollInput> = {}): DcRerollInput {
  return {
    transport: 'dc',
    rttMs: 200,
    samples: 3,
    linkAgeMs: 20_000,
    bestKnownMs: 100,
    rerolls: { count: 0, windowStartedAt: NOW },
    lastRerollAt: null,
    quiesceCapable: true,
    peerCapable: true,
    isOfferer: true,
    breakerAllows: true,
    now: NOW,
    ...patch,
  };
}

function reasonOf(patch: Partial<DcRerollInput>): string {
  const decision = decideDcReroll(input(patch));
  return decision.reroll ? 'reroll' : decision.reason;
}

describe('dcRerollSlowThresholdMs', () => {
  test('小 RTT 用绝对增量，大 RTT 用倍数', () => {
    expect(dcRerollSlowThresholdMs(20)).toBe(60);
    expect(dcRerollSlowThresholdMs(90)).toBe(135);
  });
});

describe('decideDcReroll', () => {
  test('慢路径触发并带上当前值与最佳值', () => {
    expect(decideDcReroll(input())).toEqual({
      reroll: true,
      reason: 'slow-path',
      currentMs: 200,
      bestMs: 100,
    });
  });

  test('测量门：transport / rtt / 样本数 / 链路年龄 / 最佳值', () => {
    expect(reasonOf({ transport: 'ws-secure' })).toBe('transport');
    expect(reasonOf({ transport: 'relay' })).toBe('transport');
    expect(reasonOf({ rttMs: null })).toBe('no-rtt');
    expect(reasonOf({ rttMs: Number.NaN })).toBe('no-rtt');
    expect(reasonOf({ samples: 2 })).toBe('samples');
    expect(reasonOf({ linkAgeMs: 19_999 })).toBe('age');
    expect(reasonOf({ bestKnownMs: null })).toBe('no-best');
  });

  test('角色门：quiesce / 对端能力 / offerer / 熔断', () => {
    expect(reasonOf({ quiesceCapable: false })).toBe('quiesce');
    expect(reasonOf({ peerCapable: false })).toBe('peer-cap');
    expect(reasonOf({ isOfferer: false })).toBe('answerer');
    expect(reasonOf({ breakerAllows: false })).toBe('breaker');
  });

  test('阈值：max(1.5×best, best+40) 之内不动', () => {
    expect(reasonOf({ rttMs: 150, bestKnownMs: 100 })).toBe('within-threshold');
    expect(reasonOf({ rttMs: 151, bestKnownMs: 100 })).toBe('reroll');
    // 小 RTT 走绝对增量：20 → 阈值 60
    expect(reasonOf({ rttMs: 59, bestKnownMs: 20 })).toBe('within-threshold');
    expect(reasonOf({ rttMs: 61, bestKnownMs: 20 })).toBe('reroll');
  });

  test('预算：窗口内满 3 次拦住，窗口过期自动归零', () => {
    const full = { count: DC_REROLL_MAX_PER_HOUR, windowStartedAt: NOW - 1_000 };
    expect(reasonOf({ rerolls: full })).toBe('budget');
    const stale = { count: DC_REROLL_MAX_PER_HOUR, windowStartedAt: NOW - DC_REROLL_WINDOW_MS };
    expect(reasonOf({ rerolls: stale })).toBe('reroll');
  });

  test('两次之间至少 60 s', () => {
    expect(reasonOf({ lastRerollAt: NOW - DC_REROLL_MIN_INTERVAL_MS + 1 })).toBe('cooldown');
    expect(reasonOf({ lastRerollAt: NOW - DC_REROLL_MIN_INTERVAL_MS })).toBe('reroll');
  });
});

describe('dcRerollBudgetInWindow', () => {
  test('窗口未过期原样返回，过期归零并重开窗口', () => {
    const fresh = { count: 2, windowStartedAt: NOW - 1 };
    expect(dcRerollBudgetInWindow(fresh, NOW)).toBe(fresh);
    expect(
      dcRerollBudgetInWindow({ count: 2, windowStartedAt: NOW - DC_REROLL_WINDOW_MS }, NOW)
    ).toEqual({
      count: 0,
      windowStartedAt: NOW,
    });
  });
});
