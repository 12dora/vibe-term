// toast 身份去重：同一事件经直投 / 转发两条路抵达时只弹一次。

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  TOAST_DEDUPE_COALESCE_MS,
  claimToast,
  claimToastFor,
  resetToastDedupeForTest,
  toastDedupeKey,
} from './toast-dedupe';

const NODE_B = 'bb'.repeat(16);

beforeEach(() => {
  resetToastDedupeForTest();
});

describe('身份键', () => {
  test('缺席字段折成空串，字段顺序固定', () => {
    expect(toastDedupeKey({ eventType: 'terminal_notification' })).toBe(
      'terminal_notification||||'
    );
    expect(
      toastDedupeKey({
        eventType: 'watch_triggered',
        nodeId: NODE_B,
        deviceId: 'd1',
        paneId: '%2',
        ruleId: 'r1',
      })
    ).toBe(`watch_triggered|${NODE_B}|d1|%2|r1`);
  });

  test('两条路只要 id 对得上就是同一个键', () => {
    const direct = toastDedupeKey({
      eventType: 'watch_triggered',
      nodeId: NODE_B,
      deviceId: 'd1',
      paneId: '%2',
      ruleId: 'r1',
    });
    const forwarded = toastDedupeKey({
      eventType: 'watch_triggered',
      nodeId: NODE_B,
      deviceId: 'd1',
      paneId: '%2',
      ruleId: 'r1',
    });
    expect(direct).toBe(forwarded);
  });
});

describe('认领', () => {
  test('先到的认领成功，窗口内的后来者被判重复', () => {
    expect(claimToast('k', { now: 1_000 })).toBe(true);
    expect(claimToast('k', { now: 1_000 + TOAST_DEDUPE_COALESCE_MS })).toBe(false);
  });

  test('不同身份互不影响', () => {
    expect(claimToast('a', { now: 1_000 })).toBe(true);
    expect(claimToast('b', { now: 1_000 })).toBe(true);
  });

  test('超过合并窗口的是真·再次发生，照常认领', () => {
    expect(claimToast('k', { now: 1_000 })).toBe(true);
    expect(claimToast('k', { now: 1_000 + TOAST_DEDUPE_COALESCE_MS + 1 })).toBe(true);
  });

  test('重复认领不刷新时间戳：一串重复不会把下一次事件吃掉', () => {
    expect(claimToast('k', { now: 0 })).toBe(true);
    expect(claimToast('k', { now: 1_500 })).toBe(false);
    expect(claimToast('k', { now: 2_001 })).toBe(true);
  });

  test('TTL 过后记录被清掉', () => {
    expect(claimToast('k', { now: 0, ttlMs: 100, coalesceMs: 100 })).toBe(true);
    expect(claimToast('other', { now: 500, ttlMs: 100, coalesceMs: 100 })).toBe(true);
    expect(claimToast('k', { now: 500, ttlMs: 100, coalesceMs: 100 })).toBe(true);
  });

  test('claimToastFor 等价于拼键后认领', () => {
    const identity = { eventType: 'terminal_notification', nodeId: NODE_B, deviceId: 'd1' };
    expect(claimToastFor(identity, { now: 0 })).toBe(true);
    expect(claimToast(toastDedupeKey(identity), { now: 0 })).toBe(false);
  });
});
