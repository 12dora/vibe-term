import { afterEach, describe, expect, test } from 'bun:test';
import {
  SMALL_HOST_TOTAL_MEM_BYTES,
  getMemoryProfile,
  resolveMemoryProfile,
} from './memory-profile';
import { fanoutMaxPendingBytes } from './mesh/rtc/channel-fanout';
import { defaultEmulatorMaxEntries } from './tmux-client/pane-emulator';
import { canonicalMaxHeldPaneBytes } from './tmux-client/pane-retention';
import { RetentionKernel } from './tmux-client/retention/kernel';
import {
  DEFAULT_MAX_RETENTION_BYTES,
  SMALL_MAX_RETENTION_BYTES,
  paneRetentionLimitsFor,
} from './tmux-client/retention/types';
import {
  MAX_SESSION_ACTIVE_WRITES,
  maxSessionActiveWrites,
  transferChunkBytes,
} from './transfer/limits';

const ENV_KEY = 'VIBETERM_MEMORY_PROFILE';

afterEach(() => {
  delete process.env[ENV_KEY];
  delete process.env.VIBETERM_TRANSFER_CHUNK_BYTES;
});

describe('resolveMemoryProfile', () => {
  test('explicit small / standard 覆盖自动探测', () => {
    expect(resolveMemoryProfile({ VIBETERM_MEMORY_PROFILE: 'small' }, 64 * 1024 ** 3)).toBe(
      'small'
    );
    expect(resolveMemoryProfile({ VIBETERM_MEMORY_PROFILE: 'standard' }, 1)).toBe('standard');
    expect(resolveMemoryProfile({ VIBETERM_MEMORY_PROFILE: ' SMALL ' }, 1)).toBe('small');
  });

  test('未设置时按主机内存自动 small / standard', () => {
    expect(resolveMemoryProfile({}, SMALL_HOST_TOTAL_MEM_BYTES, Number.POSITIVE_INFINITY)).toBe(
      'small'
    );
    expect(resolveMemoryProfile({}, SMALL_HOST_TOTAL_MEM_BYTES + 1, Number.POSITIVE_INFINITY)).toBe(
      'standard'
    );
  });

  test('cgroup 约束内存低于阈值时即使用大宿主机也选 small', () => {
    const host8GiB = 8 * 1024 ** 3;
    expect(resolveMemoryProfile({}, host8GiB, 512 * 1024 ** 2)).toBe('small');
    expect(resolveMemoryProfile({}, host8GiB, Number.POSITIVE_INFINITY)).toBe('standard');
  });

  test('显式 env 仍覆盖 cgroup / 宿主机探测', () => {
    expect(resolveMemoryProfile({ VIBETERM_MEMORY_PROFILE: 'standard' }, 1, 512 * 1024 ** 2)).toBe(
      'standard'
    );
    expect(
      resolveMemoryProfile(
        { VIBETERM_MEMORY_PROFILE: 'small' },
        8 * 1024 ** 3,
        Number.POSITIVE_INFINITY
      )
    ).toBe('small');
  });

  test('非法值抛错', () => {
    expect(() => resolveMemoryProfile({ VIBETERM_MEMORY_PROFILE: 'tiny' })).toThrow(
      'VIBETERM_MEMORY_PROFILE must be standard | small'
    );
  });
});

describe('profile limits', () => {
  test('paneRetentionLimitsFor 给出 standard / small 硬顶', () => {
    const standard = paneRetentionLimitsFor('standard');
    expect(standard.maxRetentionBytes).toBe(DEFAULT_MAX_RETENTION_BYTES);
    expect(standard.maxReplayBytesPerPane).toBe(2 * 1024 * 1024);
    expect(standard.maxCheckpointBytesPerPane).toBe(512 * 1024);
    expect(standard.maxHotPanes).toBe(8);
    const small = paneRetentionLimitsFor('small');
    expect(small.maxRetentionBytes).toBe(SMALL_MAX_RETENTION_BYTES);
    expect(small.maxReplayBytesPerPane).toBe(512 * 1024);
    expect(small.maxCheckpointBytesPerPane).toBe(256 * 1024);
    expect(small.maxHotPanes).toBe(4);
    expect(small.maxActivePanes).toBe(32);
  });

  test('small profile 收紧 kernel / emulator / transfer / fanout / held pane', () => {
    const kernel = new RetentionKernel({ scheduleTimers: false, memoryProfile: 'small' });
    expect(kernel.maxRetentionBytes).toBe(16 * 1024 * 1024);
    expect(kernel.maxReplayBytesPerPane).toBe(512 * 1024);
    expect(kernel.maxCheckpointBytesPerPane).toBe(256 * 1024);
    expect(kernel.maxHotPanes).toBe(4);
    expect(defaultEmulatorMaxEntries('small')).toBe(8);
    expect(maxSessionActiveWrites('small')).toBe(4);
    expect(fanoutMaxPendingBytes('small')).toBe(16 * 1024 * 1024);
    expect(canonicalMaxHeldPaneBytes('small')).toBe(1024 * 1024);
  });

  test('standard profile 保持现网默认，chunk env 仍可覆盖', () => {
    expect(
      new RetentionKernel({ scheduleTimers: false, memoryProfile: 'standard' }).maxRetentionBytes
    ).toBe(DEFAULT_MAX_RETENTION_BYTES);
    expect(defaultEmulatorMaxEntries('standard')).toBe(32);
    expect(maxSessionActiveWrites('standard')).toBe(MAX_SESSION_ACTIVE_WRITES);
    process.env[ENV_KEY] = 'small';
    expect(getMemoryProfile()).toBe('small');
    expect(transferChunkBytes()).toBe(1024 * 1024);
    process.env[ENV_KEY] = 'standard';
    expect(transferChunkBytes()).toBe(8 * 1024 * 1024);
    process.env.VIBETERM_TRANSFER_CHUNK_BYTES = '65536';
    expect(transferChunkBytes()).toBe(65536);
  });
});
