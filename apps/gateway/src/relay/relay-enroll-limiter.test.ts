import { describe, expect, test } from 'bun:test';
import {
  RELAY_KDF_MAX_IN_FLIGHT,
  RELAY_KDF_RATE_LIMIT,
  RelayEnrollLimiter,
} from './relay-enroll-limiter';
import { RELAY_ENROLL_FAILURE_LIMIT } from './types';

describe('RelayEnrollLimiter', () => {
  test('匿名失败只锁来源 IP，不会锁住租户', () => {
    const lines: string[] = [];
    const limiter = new RelayEnrollLimiter(
      () => 1_000,
      RELAY_ENROLL_FAILURE_LIMIT,
      60_000,
      4096,
      (line) => lines.push(line)
    );
    const tenant = 'aa'.repeat(16);
    for (let n = 0; n < RELAY_ENROLL_FAILURE_LIMIT; n += 1) {
      limiter.recordFailure(`203.0.113.${n + 1}`, tenant);
    }
    expect(limiter.isLimited('198.51.100.7')).toBe(false);
    expect(lines.some((line) => line.includes(tenant))).toBe(true);
    for (let n = 0; n < RELAY_ENROLL_FAILURE_LIMIT; n += 1) limiter.recordFailure('203.0.113.9');
    expect(limiter.isLimited('203.0.113.9')).toBe(true);
  });

  test('IPv6 按 /64 归桶：轮换地址后缀绕不过去', () => {
    const limiter = new RelayEnrollLimiter(() => 1_000);
    for (let n = 0; n < RELAY_ENROLL_FAILURE_LIMIT; n += 1) {
      limiter.recordFailure(`2001:db8:1:2::${(n + 1).toString(16)}`);
    }
    expect(limiter.isLimited('2001:db8:1:2::ffff')).toBe(true);
    expect(limiter.isLimited('2001:db8:1:3::1')).toBe(false);
  });

  test('高基数来源不会让桶表无限增长', () => {
    const limiter = new RelayEnrollLimiter(() => 1_000, RELAY_ENROLL_FAILURE_LIMIT, 60_000, 4);
    for (let i = 0; i < 64; i += 1) limiter.recordFailure(`203.0.113.${i + 1}`);
    expect(limiter.size).toBe(4);
  });
});

describe('RelayEnrollLimiter.reserveKdf', () => {
  test('开算前先记一次失败；口令对了才清掉', () => {
    const limiter = new RelayEnrollLimiter(() => 1_000);
    const first = limiter.reserveKdf('203.0.113.1');
    if (!first.ok) throw new Error('expected a slot');
    expect(limiter.count('203.0.113.1')).toBe(1);
    first.done(false);
    expect(limiter.count('203.0.113.1')).toBe(1);
    const second = limiter.reserveKdf('203.0.113.1');
    if (!second.ok) throw new Error('expected a slot');
    second.done(true);
    expect(limiter.count('203.0.113.1')).toBe(0);
  });

  test('同一来源同时只允许一个在算，失败计数在并发时也拦得住', () => {
    const limiter = new RelayEnrollLimiter(() => 1_000);
    const held = limiter.reserveKdf('203.0.113.1');
    expect(held.ok).toBe(true);
    expect(limiter.reserveKdf('203.0.113.1').ok).toBe(false);
    if (held.ok) held.done(false);
    for (let n = 1; n < RELAY_ENROLL_FAILURE_LIMIT; n += 1) {
      const slot = limiter.reserveKdf('203.0.113.1');
      if (slot.ok) slot.done(false);
    }
    const blocked = limiter.reserveKdf('203.0.113.1');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test('全中继并发上限：超出立即拒绝，不排队', () => {
    const limiter = new RelayEnrollLimiter(() => 1_000);
    const held = Array.from({ length: RELAY_KDF_MAX_IN_FLIGHT }, (_, i) =>
      limiter.reserveKdf(`203.0.113.${i + 1}`)
    );
    expect(held.every((slot) => slot.ok)).toBe(true);
    expect(limiter.reserveKdf('198.51.100.1').ok).toBe(false);
    const first = held[0];
    if (first?.ok) first.done(true);
    expect(limiter.reserveKdf('198.51.100.1').ok).toBe(true);
  });

  test('全中继速率上限：窗口内 KDF 次数有上界', () => {
    let now = 1_000;
    const limiter = new RelayEnrollLimiter(() => now);
    for (let i = 0; i < RELAY_KDF_RATE_LIMIT; i += 1) {
      const slot = limiter.reserveKdf(`198.51.100.${(i % 200) + 1}`);
      if (!slot.ok) throw new Error(`slot ${i} refused`);
      slot.done(true);
    }
    expect(limiter.reserveKdf('203.0.113.200').ok).toBe(false);
    now += 60_001;
    expect(limiter.reserveKdf('203.0.113.200').ok).toBe(true);
  });
});
