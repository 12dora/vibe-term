import { afterEach, describe, expect, test } from 'bun:test';
import { ApiClient } from '@vibeterm/api-client';
import { PROBE_TIMEOUT_MS, probeNodeSessionByDevices } from './node-session-guard';
import {
  SESSION_PROBE_TIMEOUT_MS,
  probeNodeSession,
  sessionProbeTimeoutMs,
} from './node-session-probe';

const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('sessionProbeTimeoutMs', () => {
  test('clamps 8×RTT into [8s, 30s]', () => {
    expect(sessionProbeTimeoutMs(null)).toBe(SESSION_PROBE_TIMEOUT_MS);
    expect(sessionProbeTimeoutMs(undefined)).toBe(8_000);
    expect(sessionProbeTimeoutMs(1_000)).toBe(8_000);
    expect(sessionProbeTimeoutMs(2_000)).toBe(16_000);
    expect(sessionProbeTimeoutMs(10_000)).toBe(30_000);
    expect(PROBE_TIMEOUT_MS).toBe(SESSION_PROBE_TIMEOUT_MS);
  });
});

describe('probeNodeSession / probeNodeSessionByDevices adaptive timeout', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function expectTimeout(
    run: () => Promise<unknown>,
    latencyMs: number | null,
    expected: number
  ) {
    globalThis.fetch = (async () => jsonResponse({ devices: [] })) as unknown as typeof fetch;
    const seen: number[] = [];
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const originalLatency = ApiClient.prototype.lastLatencyMs;
    AbortSignal.timeout = ((ms: number) => {
      seen.push(ms);
      return originalTimeout(ms);
    }) as typeof AbortSignal.timeout;
    ApiClient.prototype.lastLatencyMs = () => latencyMs;
    try {
      await run();
      expect(seen).toContain(expected);
    } finally {
      AbortSignal.timeout = originalTimeout;
      ApiClient.prototype.lastLatencyMs = originalLatency;
    }
  }

  test('probeNodeSession 无 EWMA 时用 8s 下限，高 RTT 放大到 16s', async () => {
    await expectTimeout(() => probeNodeSession(NODE_A), null, 8_000);
    await expectTimeout(() => probeNodeSession(NODE_A), 2_000, 16_000);
  });

  test('probeNodeSessionByDevices 走同一套自适应期限', async () => {
    await expectTimeout(() => probeNodeSessionByDevices(NODE_A), null, 8_000);
    await expectTimeout(() => probeNodeSessionByDevices(NODE_A), 2_000, 16_000);
  });
});
