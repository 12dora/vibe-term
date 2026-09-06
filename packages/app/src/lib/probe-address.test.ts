import { describe, expect, test } from 'bun:test';
import type { FetchLike } from './fetch-like';
import { probeAddressForCli, probeNotFoundMessage } from './probe-address';

function healthOn(ports: number[], seen: string[] = []): FetchLike {
  return ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    seen.push(`${port}${url.pathname}`);
    if (ports.includes(port)) {
      return Promise.resolve(Response.json({ ok: true, status: 'ok' }));
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }) as FetchLike;
}

describe('probeAddressForCli', () => {
  test('a portless https address is probed and rewritten', async () => {
    const logs: string[] = [];
    const result = await probeAddressForCli('https://relay.example.com', {
      kind: 'relay',
      fetcher: healthOn([13443]),
      log: (message) => logs.push(message),
      timeoutMs: 150,
    });
    expect(result.url).toBe('https://relay.example.com:13443');
    expect(result.probed).toBe(true);
    expect(result.found).toBe(true);
    expect(logs.join('\n')).toContain('13443');
  });

  test('an explicit port is left alone and never probed', async () => {
    const seen: string[] = [];
    const result = await probeAddressForCli('https://relay.example.com:13443', {
      kind: 'relay',
      fetcher: healthOn([13443], seen),
      timeoutMs: 150,
    });
    expect(result).toEqual({
      url: 'https://relay.example.com:13443',
      probed: false,
      found: false,
      triedPorts: [],
    });
    expect(seen).toEqual([]);
  });

  test('an explicit :443 is treated as explicit and never swept', async () => {
    const seen: string[] = [];
    const result = await probeAddressForCli('https://hub.example.com:443', {
      kind: 'hub',
      fetcher: healthOn([443], seen),
      timeoutMs: 150,
    });
    expect(result).toEqual({
      url: 'https://hub.example.com:443',
      probed: false,
      found: false,
      triedPorts: [],
    });
    expect(seen).toEqual([]);
  });

  test('loopback and skip both bypass probing', async () => {
    const seen: string[] = [];
    const local = await probeAddressForCli('https://localhost', {
      kind: 'hub',
      fetcher: healthOn([443], seen),
      timeoutMs: 150,
    });
    expect(local.probed).toBe(false);
    const skipped = await probeAddressForCli('https://hub.example.com', {
      kind: 'hub',
      fetcher: healthOn([443], seen),
      skip: true,
      timeoutMs: 150,
    });
    expect(skipped.probed).toBe(false);
    expect(seen).toEqual([]);
  });

  test('nothing answering keeps the original address and lists the ports', async () => {
    const result = await probeAddressForCli('https://hub.example.com', {
      kind: 'hub',
      fetcher: healthOn([]),
      timeoutMs: 100,
    });
    expect(result.url).toBe('https://hub.example.com');
    expect(result.probed).toBe(true);
    expect(result.found).toBe(false);
    expect(result.triedPorts).toContain(443);
    expect(probeNotFoundMessage(result.triedPorts)).toContain('443');
  });

  test('hub probing uses /healthz and relay probing uses /api/relay/health', async () => {
    const hubSeen: string[] = [];
    await probeAddressForCli('https://hub.example.com', {
      kind: 'hub',
      fetcher: healthOn([443], hubSeen),
      timeoutMs: 150,
    });
    expect(hubSeen).toEqual(['443/healthz']);
    const relaySeen: string[] = [];
    await probeAddressForCli('https://relay.example.com', {
      kind: 'relay',
      fetcher: healthOn([443], relaySeen),
      timeoutMs: 150,
    });
    expect(relaySeen).toEqual(['443/api/relay/health']);
  });
});
