import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  TCP_CANARY_PORT,
  TCP_TRUST_TTL_MS,
  ensureTcpSamplingTrust,
  resetTcpSamplingTrustForTest,
  tcpSamplingTrusted,
} from './tcp-sampling-trust';

describe('tcp sampling trust canary', () => {
  beforeEach(() => resetTcpSamplingTrustForTest());
  afterEach(() => resetTcpSamplingTrustForTest());

  test('a canary handshake that succeeds marks TCP sampling untrusted and logs once', async () => {
    const lines: string[] = [];
    const probe = async (_host: string, port: number) => {
      expect(port).toBe(TCP_CANARY_PORT);
      return { verdict: 'ok' as const, connectMs: 8 };
    };
    expect(await ensureTcpSamplingTrust('relay.example', 1_000, probe, (l) => lines.push(l))).toBe(
      false
    );
    expect(await ensureTcpSamplingTrust('relay.example', 2_000, probe, (l) => lines.push(l))).toBe(
      false
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('canary host=relay.example port=1 connect_ms=8');
    expect(tcpSamplingTrusted(2_000)).toBe(false);
  });

  test('refused or timeout canaries keep sampling trusted; the verdict expires after the TTL', async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return { verdict: 'refused' as const, connectMs: null };
    };
    expect(await ensureTcpSamplingTrust('relay.example', 1_000, probe)).toBe(true);
    expect(await ensureTcpSamplingTrust('relay.example', 1_000 + TCP_TRUST_TTL_MS / 2, probe)).toBe(
      true
    );
    expect(calls).toBe(1);
    expect(tcpSamplingTrusted(1_000 + TCP_TRUST_TTL_MS + 1)).toBeNull();
    expect(await ensureTcpSamplingTrust('relay.example', 1_000 + TCP_TRUST_TTL_MS + 1, probe)).toBe(
      true
    );
    expect(calls).toBe(2);
  });

  test('a probe that throws is treated as trusted', async () => {
    expect(
      await ensureTcpSamplingTrust('relay.example', 1_000, async () => {
        throw new Error('boom');
      })
    ).toBe(true);
  });
});
