import { describe, expect, test } from 'bun:test';
import type { RelayQuota } from '@vibeterm/shared/relay';
import { minQuotaFileBytes } from './relay-multi-attach';

function quota(over: Partial<RelayQuota> = {}): RelayQuota {
  return {
    maxNodes: 8,
    maxStreams: 16,
    bandwidthBytesPerSec: null,
    ...over,
  };
}

describe('minQuotaFileBytes', () => {
  test('primary 在线时取所有已连接中继的最小 maxFileBytes', () => {
    expect(
      minQuotaFileBytes(quota({ maxFileBytes: 100 }), [
        { quota: quota({ maxFileBytes: 40 }) },
        { quota: quota({ maxFileBytes: 80 }) },
      ])?.maxFileBytes
    ).toBe(40);
  });

  test('primary 掉线时仍返回 secondary 的有限上限', () => {
    expect(
      minQuotaFileBytes(null, [{ quota: quota({ maxFileBytes: 50 * 1024 * 1024 }) }])?.maxFileBytes
    ).toBe(50 * 1024 * 1024);
  });

  test('没有任何有限上限时 primary 为 null 则返回 null', () => {
    expect(minQuotaFileBytes(null, [{ quota: quota() }])).toBeNull();
    expect(minQuotaFileBytes(null, [])).toBeNull();
  });
});
