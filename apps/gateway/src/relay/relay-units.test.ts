import { describe, expect, test } from 'bun:test';
import { MIN_RELAY_CLIENT_VERSION, RELAY_KEYLOG_SEQ_MISMATCH } from '@tmex/shared/relay';
import { nodeVersionMeets } from '../hub/hub-authorization';
import { RelayEnrollLimiter } from './relay-enroll-limiter';
import { RelayErrorCode, relayError } from './relay-http';
import { trimRelayKeyLogPage } from './relay-key-log-page';
import {
  constantTimeEqual,
  generateRelayTenantId,
  generateRelayToken,
  hashRelayPassword,
  sha256Hex,
  verifyRelayPassword,
} from './relay-password';
import {
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
      }
    );
    expect(normalizeRelayQuota({ maxNodes: 2, maxStreams: 4 })).toEqual({
      maxNodes: 2,
      maxStreams: 4,
      bandwidthBytesPerSec: null,
    });
    expect(normalizeRelayQuota({ maxNodes: 0, maxStreams: 4 })).toBeNull();
    expect(
      normalizeRelayQuota({ maxNodes: 2, maxStreams: 4, bandwidthBytesPerSec: -1 })
    ).toBeNull();
    expect(normalizeRelayQuota(null)).toBeNull();
  });

  test('round-trips through JSON and falls back to the default', () => {
    const quota = { maxNodes: 3, maxStreams: 5, bandwidthBytesPerSec: 1024 };
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
      100,
      () => clock,
      async (ms) => {
        slept += ms;
        clock += ms;
      }
    );
    await bucket.take(100);
    expect(slept).toBe(0);
    await bucket.take(100);
    expect(slept).toBeGreaterThan(0);
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
