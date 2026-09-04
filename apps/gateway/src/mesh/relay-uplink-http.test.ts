// 中继健康探测的拨号改写：`relay,node` 机器探自己的中继时必须走回环。

import { afterEach, describe, expect, test } from 'bun:test';
import type { RelayDialContext } from './relay-dial';
import { probeRelayHealth, relayUplinkWsUrl } from './relay-uplink-http';

const SELF: RelayDialContext = {
  roles: { relay: true },
  relayPublicUrl: 'https://relay.example',
  gatewayPort: 19993,
};

const originalFetch = globalThis.fetch;

function captureFetch(ok = true): { urls: string[]; inits: (RequestInit | undefined)[] } {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    inits.push(init);
    return new Response(null, { status: ok ? 200 : 503 });
  }) as typeof fetch;
  return { urls, inits };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('probeRelayHealth', () => {
  test('本机就是这条中继时探回环，不走公网地址', async () => {
    const seen = captureFetch();
    expect(await probeRelayHealth('https://relay.example', null, 1_000, SELF)).toBe(true);
    expect(seen.urls).toEqual(['http://127.0.0.1:19993/api/relay/health']);
  });

  test('回环探测不带自签 CA（那是给公网 TLS 用的）', async () => {
    const seen = captureFetch();
    await probeRelayHealth('https://relay.example', ['-----BEGIN CERTIFICATE-----'], 1_000, SELF);
    expect(seen.inits[0]).toEqual({
      method: 'GET',
      signal: expect.anything(),
      redirect: 'error',
    });
  });

  test('别人的中继照旧打公网地址，并保留自签 CA', async () => {
    const seen = captureFetch();
    await probeRelayHealth('https://other.example/', ['pem'], 1_000, SELF);
    expect(seen.urls).toEqual(['https://other.example/api/relay/health']);
    expect((seen.inits[0] as { tls?: unknown } | undefined)?.tls).toBeDefined();
  });

  test('非 2xx 与网络错误都判为不健康', async () => {
    captureFetch(false);
    expect(await probeRelayHealth('https://other.example', null, 1_000, SELF)).toBe(false);
    globalThis.fetch = (() => Promise.reject(new Error('boom'))) as unknown as typeof fetch;
    expect(await probeRelayHealth('https://other.example', null, 1_000, SELF)).toBe(false);
  });
});

describe('relayUplinkWsUrl', () => {
  test('http/https 换成 ws/wss 并固定路径', () => {
    expect(relayUplinkWsUrl('https://relay.example/x?y=1')).toBe(
      'wss://relay.example/relay/uplink'
    );
    expect(relayUplinkWsUrl('http://127.0.0.1:19993')).toBe('ws://127.0.0.1:19993/relay/uplink');
  });
});
