import { afterEach, describe, expect, test } from 'bun:test';
import {
  currentRelayQuota,
  effectiveTransferMaxBytes,
  setRelayQuotaProvider,
  transferMaxBytesNow,
} from './transfer-limit';

const QUOTA = { maxNodes: 8, maxStreams: 32, bandwidthBytesPerSec: null };

afterEach(() => setRelayQuotaProvider(null));

describe('effectiveTransferMaxBytes', () => {
  test('falls back to the local config when the relay publishes no limit', () => {
    expect(effectiveTransferMaxBytes(2048, null)).toBe(2048);
    expect(effectiveTransferMaxBytes(2048, undefined)).toBe(2048);
    expect(effectiveTransferMaxBytes(2048, { ...QUOTA, maxFileBytes: null })).toBe(2048);
    expect(effectiveTransferMaxBytes(2048, {})).toBe(2048);
  });

  test('takes the smaller of the two limits', () => {
    expect(effectiveTransferMaxBytes(2048, { ...QUOTA, maxFileBytes: 1024 })).toBe(1024);
    expect(effectiveTransferMaxBytes(1024, { ...QUOTA, maxFileBytes: 4096 })).toBe(1024);
  });
});

describe('relay quota provider', () => {
  test('reads through the registered provider and survives a throwing one', () => {
    expect(currentRelayQuota()).toBeNull();
    setRelayQuotaProvider(() => ({ ...QUOTA, maxFileBytes: 512 }));
    expect(currentRelayQuota()?.maxFileBytes).toBe(512);
    expect(transferMaxBytesNow(4096)).toBe(512);
    setRelayQuotaProvider(() => {
      throw new Error('uplink gone');
    });
    expect(currentRelayQuota()).toBeNull();
    expect(transferMaxBytesNow(4096)).toBe(4096);
  });
});
