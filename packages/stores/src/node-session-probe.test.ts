import { describe, expect, test } from 'bun:test';
import { SESSION_PROBE_TIMEOUT_MS, sessionProbeTimeoutMs } from './node-session-probe';

describe('sessionProbeTimeoutMs', () => {
  test('clamps 8×RTT into [8s, 30s]', () => {
    expect(sessionProbeTimeoutMs(null)).toBe(SESSION_PROBE_TIMEOUT_MS);
    expect(sessionProbeTimeoutMs(undefined)).toBe(8_000);
    expect(sessionProbeTimeoutMs(1_000)).toBe(8_000);
    expect(sessionProbeTimeoutMs(2_000)).toBe(16_000);
    expect(sessionProbeTimeoutMs(10_000)).toBe(30_000);
  });
});
