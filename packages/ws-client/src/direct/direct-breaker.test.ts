import { afterEach, describe, expect, test } from 'bun:test';
import {
  DIRECT_BREAKER_BASE_MS,
  DIRECT_BREAKER_HEALTHY_MS,
  DIRECT_BREAKER_MAX_MS,
  DIRECT_UNAVAILABLE_COOLDOWN_MS,
  beginDirectAttempt,
  clearDirectUnavailable,
  directBreakerGate,
  directBreakerSnapshot,
  forceDirectProbe,
  noteDirectAuthorized,
  noteDirectEstablished,
  noteDirectFailure,
  noteDirectHealthy,
  resetDirectBreakerFor,
  resetDirectBreakers,
} from './direct-breaker';

afterEach(() => resetDirectBreakers());

describe('直连熔断（每 node 唯一一份）', () => {
  test('连续 3 次进冷却，30 s 起逐档翻倍；强制探测放行一次，attempt 开始即消耗', () => {
    const node = 'node-a';
    noteDirectFailure(node, 'timeout', 'a1', 0);
    noteDirectFailure(node, 'ice', 'a2', 0);
    expect(directBreakerGate(node, 1).allow).toBe(true);
    noteDirectFailure(node, 'authorize-unavailable', 'a3', 0);
    const gate = directBreakerGate(node, 1);
    expect(gate).toEqual({ allow: false, until: DIRECT_BREAKER_BASE_MS, hard: false });

    forceDirectProbe(node);
    expect(directBreakerGate(node, 1).allow).toBe(true);
    beginDirectAttempt(node, 'probe');
    expect(directBreakerGate(node, 1).allow).toBe(false);
    noteDirectFailure(node, 'timeout', 'probe', DIRECT_BREAKER_BASE_MS);
    expect(directBreakerGate(node, DIRECT_BREAKER_BASE_MS).until).toBe(DIRECT_BREAKER_BASE_MS * 3);
  });

  test('同一 attempt 只记一次（不再双重记账）', () => {
    const node = 'node-b';
    noteDirectFailure(node, 'direct-busy', 'x', 0);
    noteDirectFailure(node, 'authorization', 'x', 0);
    expect(directBreakerSnapshot(node, 1)).toMatchObject({
      failures: 1,
      lastFailureKind: 'direct-busy',
    });
  });

  test('短命通道不清零；active 满 60 s 清零', () => {
    const node = 'node-c';
    noteDirectFailure(node, 'timeout', '1', 0);
    noteDirectFailure(node, 'timeout', '2', 0);
    noteDirectEstablished(node, '3', 10);
    expect(noteDirectHealthy(node, 10 + DIRECT_BREAKER_HEALTHY_MS - 1)).toBe(false);
    expect(noteDirectHealthy(node, 10 + DIRECT_BREAKER_HEALTHY_MS)).toBe(true);
    expect(directBreakerSnapshot(node, 20 + DIRECT_BREAKER_HEALTHY_MS)).toMatchObject({
      failures: 0,
      level: 0,
      cooling: false,
    });
  });

  test('DIRECT_UNAVAILABLE：不计次，整段停放 10 min；强制探测越不过，只有显式清掉或 authorize 成功才解', () => {
    const node = 'node-d';
    noteDirectFailure(node, 'direct-unavailable', 'u1', 0);
    expect(directBreakerGate(node, 1)).toEqual({
      allow: false,
      until: DIRECT_UNAVAILABLE_COOLDOWN_MS,
      hard: true,
    });
    expect(directBreakerSnapshot(node, 1)).toMatchObject({
      failures: 0,
      cooling: true,
      lastFailureKind: 'direct-unavailable',
    });
    forceDirectProbe(node);
    expect(directBreakerGate(node, 1).allow).toBe(false);
    expect(directBreakerGate(node, DIRECT_UNAVAILABLE_COOLDOWN_MS).allow).toBe(true);

    noteDirectFailure(node, 'direct-unavailable', 'u2', 0);
    clearDirectUnavailable(node);
    expect(directBreakerGate(node, 1).allow).toBe(true);
    noteDirectFailure(node, 'direct-unavailable', 'u3', 0);
    noteDirectAuthorized(node);
    expect(directBreakerGate(node, 1).allow).toBe(true);
  });

  test('DIRECT_BUSY：计次，retryAfterMs 是强制探测也越不过的最短间隔，封顶到熔断上限', () => {
    const node = 'node-e';
    noteDirectFailure(node, 'direct-busy', 'b1', 1_000, 5_000);
    forceDirectProbe(node);
    expect(directBreakerGate(node, 2_000)).toEqual({ allow: false, until: 6_000, hard: true });
    expect(directBreakerGate(node, 6_000).allow).toBe(true);

    noteDirectFailure('node-f', 'direct-busy', 'b2', 0, 24 * 3600_000);
    expect(directBreakerGate('node-f', 1).until).toBe(DIRECT_BREAKER_MAX_MS);
  });

  test('重置：只清一台 node / 登录世代变化全部作废', () => {
    for (const node of ['node-g', 'node-h']) {
      for (let i = 0; i < 3; i += 1) noteDirectFailure(node, 'timeout', `${node}-${i}`, 0);
    }
    resetDirectBreakerFor('node-g');
    expect(directBreakerGate('node-g', 1).allow).toBe(true);
    expect(directBreakerGate('node-h', 1).allow).toBe(false);
    resetDirectBreakers();
    expect(directBreakerGate('node-h', 1).allow).toBe(true);
  });
});
