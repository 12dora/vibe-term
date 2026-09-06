import { describe, expect, test } from 'bun:test';
import { MIN_RELAY_CLIENT_VERSION, RELAY_KEYLOG_SEQ_MISMATCH } from '@tmex/shared/relay';
import { nodeVersionMeets } from '../hub/hub-authorization';
import { RelayBandwidthLimiter } from './relay-bandwidth';
import { RelayEnrollLimiter } from './relay-enroll-limiter';
import { RelayErrorCode, relayError } from './relay-http';
import { trimRelayKeyLogPage } from './relay-key-log-page';
import { type RelayLimits, defaultRelayLimits, normalizeRelayLimits } from './relay-limits';
import {
  constantTimeEqual,
  generateRelayTenantId,
  generateRelayToken,
  hashRelayPassword,
  sha256Hex,
  verifyRelayPassword,
} from './relay-password';
import {
  RELAY_QUOTA_MAX_FILE_BYTES,
  RELAY_TOKEN_BUCKET_BYPASS_BYTES,
  RelayTokenBucket,
  defaultRelayQuota,
  effectiveRelayQuota,
  normalizeRelayQuota,
  parseRelayQuotaJson,
  serializeRelayQuota,
} from './relay-quota';

const FAST_ARGON = { memoryKib: 512, iterations: 1, parallelism: 1 };

describe('relay password hashing', () => {
  test('verifies the right password and rejects the wrong one', async () => {
    const stored = await hashRelayPassword('correct horse', FAST_ARGON);
    expect(await verifyRelayPassword(stored, 'correct horse')).toBe(true);
    expect(await verifyRelayPassword(stored, 'correct horse ')).toBe(false);
    expect(await verifyRelayPassword(stored, '')).toBe(false);
  });

  test('rejects malformed stored hashes instead of throwing', async () => {
    expect(await verifyRelayPassword('not json', 'x')).toBe(false);
    expect(await verifyRelayPassword('{"kdf":"scrypt"}', 'x')).toBe(false);
    expect(await verifyRelayPassword('{"kdf":"argon2id","salt":"zz","hash":"aa"}', 'x')).toBe(
      false
    );
  });

  test('token / tenant id generators produce the documented shapes', () => {
    expect(generateRelayTenantId()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateRelayToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
  });
});

describe('relay quota', () => {
  test('normalizes valid quotas and rejects malformed ones', () => {
    expect(normalizeRelayQuota({ maxNodes: 2, maxStreams: 4, bandwidthBytesPerSec: null })).toEqual(
      {
        maxNodes: 2,
        maxStreams: 4,
        bandwidthBytesPerSec: null,
        maxFileBytes: null,
      }
    );
    expect(normalizeRelayQuota({ maxNodes: 2, maxStreams: 4 })).toEqual({
      maxNodes: 2,
      maxStreams: 4,
      bandwidthBytesPerSec: null,
      maxFileBytes: null,
    });
    expect(normalizeRelayQuota({ maxNodes: 0, maxStreams: 4 })).toBeNull();
    expect(
      normalizeRelayQuota({ maxNodes: 2, maxStreams: 4, bandwidthBytesPerSec: -1 })
    ).toBeNull();
    expect(normalizeRelayQuota(null)).toBeNull();
  });

  test('normalizes maxFileBytes and rejects out-of-range values', () => {
    expect(
      normalizeRelayQuota({ maxNodes: 2, maxStreams: 4, maxFileBytes: 1024 })?.maxFileBytes
    ).toBe(1024);
    expect(
      normalizeRelayQuota({ maxNodes: 2, maxStreams: 4, maxFileBytes: null })?.maxFileBytes
    ).toBeNull();
    expect(normalizeRelayQuota({ maxNodes: 2, maxStreams: 4, maxFileBytes: 0 })).toBeNull();
    expect(normalizeRelayQuota({ maxNodes: 2, maxStreams: 4, maxFileBytes: 1.5 })).toBeNull();
    expect(
      normalizeRelayQuota({
        maxNodes: 2,
        maxStreams: 4,
        maxFileBytes: RELAY_QUOTA_MAX_FILE_BYTES + 1,
      })
    ).toBeNull();
  });

  test('round-trips through JSON and falls back to the default', () => {
    const quota = {
      maxNodes: 3,
      maxStreams: 5,
      bandwidthBytesPerSec: 1024,
      maxFileBytes: 2048,
    };
    expect(parseRelayQuotaJson(serializeRelayQuota(quota))).toEqual(quota);
    expect(parseRelayQuotaJson(null)).toBeNull();
    expect(parseRelayQuotaJson('{')).toBeNull();
    expect(effectiveRelayQuota(null, defaultRelayQuota())).toEqual(defaultRelayQuota());
    expect(effectiveRelayQuota(quota, defaultRelayQuota())).toEqual(quota);
  });

  test('token bucket delays instead of dropping and never exceeds the rate', async () => {
    let clock = 0;
    let slept = 0;
    const bucket = new RelayTokenBucket(
      8_192,
      () => clock,
      async (ms) => {
        slept += ms;
        clock += ms;
      }
    );
    await bucket.take(8_192);
    expect(slept).toBe(0);
    await bucket.take(8_192);
    expect(slept).toBeGreaterThan(0);
  });

  test('token bucket rotates grants across relay streams', async () => {
    let clock = 0;
    const bucket = new RelayTokenBucket(
      8_192,
      () => clock,
      async (ms) => {
        clock += ms;
        await Promise.resolve();
      }
    );
    const first = bucket.createStream();
    const second = bucket.createStream();
    const completed: string[] = [];
    const large = first
      .take(RELAY_TOKEN_BUCKET_BYPASS_BYTES * 5)
      .then(() => completed.push('large'));
    const smaller = second
      .take(RELAY_TOKEN_BUCKET_BYPASS_BYTES * 2)
      .then(() => completed.push('smaller'));
    await Promise.all([large, smaller]);
    expect(completed).toEqual(['smaller', 'large']);
  });

  test('frames up to 4 KiB bypass an occupied bandwidth queue', async () => {
    let clock = 0;
    const sleepers: Array<() => void> = [];
    const bucket = new RelayTokenBucket(
      4_096,
      () => clock,
      () =>
        new Promise<void>((resolve) => {
          sleepers.push(resolve);
        })
    );
    let largeDone = false;
    const large = bucket
      .createStream()
      .take(8_192)
      .then(() => {
        largeDone = true;
      });
    const small = bucket.createStream().take(RELAY_TOKEN_BUCKET_BYPASS_BYTES);
    expect(sleepers).toHaveLength(1);
    clock += 1_000;
    sleepers[0]?.();
    await small;
    expect(largeDone).toBe(false);
    clock += 1_000;
    sleepers[1]?.();
    await large;
  });

  test('sustained small frames cannot starve an already queued stream', async () => {
    let clock = 0;
    const bucket = new RelayTokenBucket(
      8_192,
      () => clock,
      async (ms) => {
        clock += ms;
        await Promise.resolve();
      }
    );
    const largeStream = bucket.createStream();
    const smallStream = bucket.createStream();
    const completed: string[] = [];
    const large = largeStream
      .take(RELAY_TOKEN_BUCKET_BYPASS_BYTES * 6)
      .then(() => completed.push('large'));
    const small = (async () => {
      for (let i = 0; i < 6; i++) {
        await smallStream.take(RELAY_TOKEN_BUCKET_BYPASS_BYTES);
      }
      completed.push('small');
    })();
    await Promise.all([large, small]);
    expect(completed).toEqual(['large', 'small']);
  });

  test('closing a stream limiter removes and rejects its queued take', async () => {
    let clock = 0;
    let wake: (() => void) | undefined;
    const bucket = new RelayTokenBucket(
      4_096,
      () => clock,
      () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        })
    );
    const stream = bucket.createStream();
    const pending = stream.take(8_192);
    stream.close();
    await expect(pending).rejects.toThrow('relay token stream closed');
    clock += 1_000;
    wake?.();
    await Promise.resolve();
  });

  test('unlimited rate never sleeps', async () => {
    let slept = 0;
    const bucket = new RelayTokenBucket(
      null,
      () => 0,
      async (ms) => {
        slept += ms;
      }
    );
    await bucket.take(1_000_000);
    expect(slept).toBe(0);
    bucket.setRate(10);
    expect(bucket.rateBytesPerSec).toBe(10);
  });
});

describe('relay limits', () => {
  test('normalizes limits and rejects malformed ones', () => {
    expect(normalizeRelayLimits({})).toEqual(defaultRelayLimits());
    expect(
      normalizeRelayLimits({ maxTenants: 4, totalBandwidthBytesPerSec: 1024, fairShare: false })
    ).toEqual({ maxTenants: 4, totalBandwidthBytesPerSec: 1024, fairShare: false });
    expect(normalizeRelayLimits({ maxTenants: null, totalBandwidthBytesPerSec: null })).toEqual(
      defaultRelayLimits()
    );
    expect(normalizeRelayLimits({ maxTenants: 0 })).toBeNull();
    expect(normalizeRelayLimits({ maxTenants: 1.5 })).toBeNull();
    expect(normalizeRelayLimits({ totalBandwidthBytesPerSec: -1 })).toBeNull();
    expect(normalizeRelayLimits({ fairShare: 'yes' })).toBeNull();
    expect(normalizeRelayLimits(null)).toBeNull();
  });
});

function bandwidthHarness(limits: RelayLimits): {
  limiter: RelayBandwidthLimiter;
  clock: () => number;
} {
  let clock = 0;
  const limiter = new RelayBandwidthLimiter(
    limits,
    () => clock,
    async (ms) => {
      clock += ms;
    }
  );
  return { limiter, clock: () => clock };
}

describe('relay bandwidth limiter', () => {
  test('fair share splits the relay rate evenly between two tenants', async () => {
    const { limiter, clock } = bandwidthHarness({
      maxTenants: null,
      totalBandwidthBytesPerSec: 64 * 1024,
      fairShare: true,
    });
    const drive = async (tenantId: string): Promise<number> => {
      const handle = limiter.acquire(tenantId);
      let bytes = 0;
      while (clock() < 5_000) {
        await handle.take(8 * 1024);
        bytes += 8 * 1024;
      }
      handle.close();
      return bytes;
    };
    const [a, b] = await Promise.all([drive('tenant-a'), drive('tenant-b')]);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(Math.min(a, b) / Math.max(a, b)).toBeGreaterThan(0.8);
  });

  test('an idle relay does not throttle the only active tenant', async () => {
    const { limiter, clock } = bandwidthHarness({
      maxTenants: null,
      totalBandwidthBytesPerSec: 8 * 1024,
      fairShare: true,
    });
    // 另外两个租户持有把手但不发字节：空闲租户不该占走轮转位。
    const idle = [limiter.acquire('idle-a'), limiter.acquire('idle-b')];
    const active = limiter.acquire('active');
    for (let i = 0; i < 4; i++) await active.take(8 * 1024);
    active.close();
    for (const handle of idle) handle.close();
    // 首秒的桶存量算一次，其余三次各等一秒；三分带宽的话要 9 秒。
    expect(clock()).toBeLessThan(4_000);
  });

  /**
   * 两租户各排一笔，看谁先完成。先用一笔预热把桶里的初始额度花光——
   * 否则先调用的那一方会在第二方入队之前把整秒的存量吃掉，结果只反映调用顺序。
   */
  const raceTwoTenants = async (fairShare: boolean): Promise<string[]> => {
    const { limiter } = bandwidthHarness({
      maxTenants: null,
      totalBandwidthBytesPerSec: 8 * 1024,
      fairShare,
    });
    const warm = limiter.acquire('warmup');
    await warm.take(8 * 1024);
    warm.close();
    const order: string[] = [];
    const first = limiter.acquire('tenant-a');
    const second = limiter.acquire('tenant-b');
    await Promise.all([
      first.take(16 * 1024).then(() => order.push('a')),
      second.take(8 * 1024).then(() => order.push('b')),
    ]);
    first.close();
    second.close();
    limiter.clear();
    return order;
  };

  test('fair share off falls back to first-come-first-served', async () => {
    expect(await raceTwoTenants(false)).toEqual(['a', 'b']);
  });

  test('fair share on lets the smaller take finish first', async () => {
    expect(await raceTwoTenants(true)).toEqual(['b', 'a']);
  });

  test('unlimited never sleeps and setLimits hot-updates the rate', async () => {
    const { limiter, clock } = bandwidthHarness(defaultRelayLimits());
    const handle = limiter.acquire('tenant-a');
    await handle.take(64 * 1024 * 1024);
    expect(clock()).toBe(0);
    expect(limiter.rateBytesPerSec).toBeNull();
    limiter.setLimits({
      maxTenants: 2,
      totalBandwidthBytesPerSec: 4_096,
      fairShare: false,
    });
    expect(limiter.rateBytesPerSec).toBe(4_096);
    expect(limiter.fairShare).toBe(false);
    handle.close();
    limiter.clear();
  });
});

describe('relay enroll limiter', () => {
  test('locks after the fifth failure inside the window and expires after it', () => {
    let clock = 0;
    const limiter = new RelayEnrollLimiter(() => clock, 5, 1_000);
    for (let i = 0; i < 4; i++) limiter.recordFailure('1.2.3.4');
    expect(limiter.isLimited('1.2.3.4')).toBe(false);
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isLimited('1.2.3.4')).toBe(true);
    expect(limiter.isLimited('5.6.7.8')).toBe(false);
    clock += 1_001;
    expect(limiter.isLimited('1.2.3.4')).toBe(false);
    expect(limiter.size).toBe(0);
  });

  test('reset clears one address only', () => {
    const limiter = new RelayEnrollLimiter(() => 0, 1, 1_000);
    limiter.recordFailure('a');
    limiter.recordFailure('b');
    limiter.reset('a');
    expect(limiter.isLimited('a')).toBe(false);
    expect(limiter.isLimited('b')).toBe(true);
    limiter.clear();
    expect(limiter.size).toBe(0);
  });

  test('failures are also counted per tenant id', () => {
    const limiter = new RelayEnrollLimiter(() => 0, 5, 1_000);
    const tenantA = 'a'.repeat(32);
    const tenantB = 'b'.repeat(32);
    for (let i = 0; i < 5; i++) limiter.recordFailure('1.1.1.1', tenantA);
    expect(limiter.isLimited('9.9.9.9', tenantA)).toBe(true);
    expect(limiter.isLimited('9.9.9.9', tenantB)).toBe(false);
    expect(limiter.isLimited('9.9.9.9')).toBe(false);
    limiter.reset('1.1.1.1', tenantA);
    expect(limiter.isLimited('9.9.9.9', tenantA)).toBe(false);
  });
});

describe('relay key log paging', () => {
  const row = (seq: number, size: number) => ({
    seq: BigInt(seq),
    blob: JSON.stringify({ v: 1, n: 'AAAAAAAAAAAAAAAA', ct: 'x'.repeat(size) }),
  });

  test('keeps whole pages that fit', () => {
    const page = trimRelayKeyLogPage([row(1, 8), row(2, 8)], false);
    expect(page.records).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  test('drops records and sets has_more when the frame would overflow', () => {
    const rows = [row(1, 30_000), row(2, 30_000), row(3, 30_000)];
    const page = trimRelayKeyLogPage(rows, false, { maxBytes: 64 * 1024 });
    expect(page.records.length).toBeLessThan(3);
    expect(page.hasMore).toBe(true);
  });

  test('skips rows whose stored envelope is unparsable', () => {
    const page = trimRelayKeyLogPage([{ seq: 1n, blob: 'nope' }, row(2, 8)], false);
    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.seq).toBe(2);
  });
});

describe('relay error bodies', () => {
  test('always use the { error: { code, message } } contract shape', async () => {
    const res = relayError(RelayErrorCode.passwordInvalid, 401);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'RELAY_PASSWORD_INVALID', message: 'RELAY_PASSWORD_INVALID' },
    });
    expect(RELAY_KEYLOG_SEQ_MISMATCH).toBe('SEQ_MISMATCH');
  });
});

describe('relay client version gate', () => {
  test('接受 1.1.23 与开发态 1.1.23_dev，拒绝 1.1.22 与无法解析的版本', () => {
    expect(MIN_RELAY_CLIENT_VERSION).toBe('1.1.23');
    for (const version of ['1.1.23', '1.1.23_dev', '1.1.24', '1.2.0', '2.0.0_dev']) {
      expect(nodeVersionMeets(version, MIN_RELAY_CLIENT_VERSION)).toBe(true);
    }
    for (const version of ['1.1.22', '1.1.22_dev', '1.0.99', '', 'nightly', null, undefined]) {
      expect(nodeVersionMeets(version, MIN_RELAY_CLIENT_VERSION)).toBe(false);
    }
  });

  test('预发布版本低于正式版：1.1.23-rc.1 不满足 1.1.23', () => {
    expect(nodeVersionMeets('1.1.23-rc.1', MIN_RELAY_CLIENT_VERSION)).toBe(false);
  });
});
