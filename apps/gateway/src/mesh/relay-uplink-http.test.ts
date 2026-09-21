// 中继健康探测的拨号改写：`relay,node` 机器探自己的中继时必须走回环。

import { afterEach, describe, expect, test } from 'bun:test';
import type { LinkSession } from '@vibeterm/shared/link';
import type { RelayDialContext } from './relay-dial';
import {
  defaultRelayWsFactory,
  openRelayLink,
  probeRelayHealth,
  relayUplinkWsUrl,
  remainingMs,
} from './relay-uplink-http';

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

type Listener = (ev: Event) => void;

class FakeSocket {
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();
  private pending: { type: string; payload: Record<string, unknown> } | null = null;

  addEventListener(type: string, fn: Listener): void {
    if (this.pending?.type === type) {
      const payload = this.pending.payload;
      this.pending = null;
      queueMicrotask(() => fn(payload as unknown as Event));
      return;
    }
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  fail(err: string | Error): void {
    this.readyState = 3;
    const error = err instanceof Error ? err : new Error(err);
    this.emit('error', { error, message: error.message });
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    const list = this.listeners.get(type) ?? [];
    if (list.length === 0) {
      this.pending = { type, payload };
      return;
    }
    this.listeners.set(type, []);
    for (const fn of list) fn(payload as unknown as Event);
  }
}

describe('probeRelayHealth dns fallback', () => {
  test('DNS 失败后按 IP 重探并带上 serverName 与 Host', async () => {
    const urls: string[] = [];
    const inits: Array<RequestInit | undefined> = [];
    let n = 0;
    expect(
      await probeRelayHealth('https://other.example/', ['pem'], 1_000, SELF, {
        enabled: true,
        resolve: async () => ({ ip: '1.2.3.4', via: 'doh' }),
        fetchImpl: async (url, init) => {
          n += 1;
          urls.push(url);
          inits.push(init);
          if (n === 1) {
            const err = new Error('getaddrinfo ENOTFOUND');
            (err as Error & { code: string }).code = 'ENOTFOUND';
            throw err;
          }
          return new Response(null, { status: 200 });
        },
      })
    ).toBe(true);
    expect(urls).toEqual([
      'https://other.example/api/relay/health',
      'https://1.2.3.4/api/relay/health',
    ]);
    expect((inits[1] as { tls?: { serverName?: string; ca?: string[] } }).tls).toEqual({
      ca: ['pem'],
      serverName: 'other.example',
    });
    expect((inits[1] as { headers?: { host?: string } }).headers?.host).toBe('other.example');
  });

  test('探测不会超过 timeoutMs，即使 fetch 忽略 abort', async () => {
    const started = Date.now();
    expect(
      await probeRelayHealth('https://other.example', null, 40, SELF, {
        enabled: false,
        fetchImpl: () => new Promise(() => undefined),
      })
    ).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('openRelayLink staged timeouts', () => {
  const dummyLink = {} as LinkSession;
  const dummyAttach = async () => {};

  function open(
    factory: () => FakeSocket | Promise<FakeSocket>,
    attach: (link: LinkSession, signal: AbortSignal) => Promise<void>,
    extra?: { timeoutMs?: number; authTimeoutMs?: number }
  ) {
    return openRelayLink(
      factory as never,
      'https://relay.example',
      new AbortController().signal,
      attach,
      {
        timeoutMs: extra?.timeoutMs ?? 200,
        ...(extra?.authTimeoutMs != null ? { authTimeoutMs: extra.authTimeoutMs } : {}),
        createLink: () => dummyLink,
      }
    );
  }

  test('WS 已开但 attach 挂起记 auth-timeout，不记 connect-timeout', async () => {
    const ws = new FakeSocket();
    ws.readyState = 1;
    const started = Date.now();
    await expect(
      open(
        async () => ws,
        () => new Promise(() => undefined),
        { authTimeoutMs: 40 }
      )
    ).rejects.toThrow('auth-timeout');
    expect(Date.now() - started).toBeLessThan(180);
  });

  test('连接段挂起记 connect-timeout，不消耗 auth 预算', async () => {
    const started = Date.now();
    await expect(
      open(async () => new FakeSocket(), dummyAttach, { timeoutMs: 50, authTimeoutMs: 400 })
    ).rejects.toThrow('connect-timeout');
    expect(Date.now() - started).toBeLessThan(250);
  });

  test('DNS 失败记 dns-failed', async () => {
    await expect(
      open(async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      }, dummyAttach)
    ).rejects.toThrow('dns-failed');
  });

  test('TLS 失败记 tls-failed', async () => {
    await expect(
      open(async () => {
        throw new Error('unable to verify the first certificate');
      }, dummyAttach)
    ).rejects.toThrow('tls-failed');
  });

  test('auth 失败不 remap 成 connect-timeout', async () => {
    const ws = new FakeSocket();
    ws.readyState = 1;
    await expect(
      open(
        async () => ws,
        async () => {
          throw new Error('auth-rejected');
        }
      )
    ).rejects.toThrow('auth-rejected');
  });

  test('waitSocketOpen 只用连接段剩余预算', async () => {
    const started = Date.now();
    await expect(
      open(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return new FakeSocket();
        },
        dummyAttach,
        { timeoutMs: 70, authTimeoutMs: 400 }
      )
    ).rejects.toThrow('connect-timeout');
    expect(Date.now() - started).toBeLessThan(200);
  });

  test('remainingMs 用剩余预算而不是每段满额', () => {
    expect(remainingMs(20_000, 1_000, 6_000)).toBe(15_000);
    expect(remainingMs(10_000, 1_000, 20_000)).toBe(1);
  });

  test('已 open 的 socket 跳过二次 wait 并进入 attach', async () => {
    const ws = new FakeSocket();
    ws.readyState = 1;
    let attached = 0;
    await open(
      async () => ws,
      async () => {
        attached += 1;
      }
    );
    expect(attached).toBe(1);
  });
});

describe('defaultRelayWsFactory dns fallback', () => {
  test('DNS 失败才按 IP 重拨，ECONNREFUSED / 4401 不重拨', async () => {
    const identity: string[] = [];
    const dnsCalls: string[] = [];
    const dnsFactory = defaultRelayWsFactory(['pem'], {
      raceCount: 1,
      enabled: true,
      resolve: async () => ({ ip: '9.9.9.9', via: 'doh' }),
      fetchImpl: async (url) => {
        identity.push(url);
        return new Response(null, { status: 204 });
      },
      wsCtor: (url, opts) => {
        dnsCalls.push(url);
        const ws = new FakeSocket();
        if (url.includes('9.9.9.9')) {
          expect((opts as { tls?: { serverName?: string; ca?: string[] } }).tls).toEqual({
            ca: ['pem'],
            serverName: 'relay.example',
          });
          ws.open();
        } else {
          ws.fail(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
        }
        return ws as never;
      },
    });
    await dnsFactory('wss://relay.example/relay/uplink');
    expect(identity).toEqual(['https://9.9.9.9/api/relay/health']);
    expect(dnsCalls).toEqual(['wss://relay.example/relay/uplink', 'wss://9.9.9.9/relay/uplink']);

    for (const fail of [
      Object.assign(new Error('connect ECONNREFUSED 9.9.9.9:443'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('ws-closed 4401 unauthorized'), { closeCode: 4401 }),
    ]) {
      const calls: string[] = [];
      const factory = defaultRelayWsFactory(null, {
        raceCount: 1,
        enabled: true,
        resolve: async () => ({ ip: '1.2.3.4', via: 'doh' }),
        wsCtor: (url) => {
          calls.push(url);
          const ws = new FakeSocket();
          ws.fail(fail);
          return ws as never;
        },
      });
      await expect(factory('wss://relay.example/relay/uplink')).rejects.toBeDefined();
      expect(calls).toEqual(['wss://relay.example/relay/uplink']);
    }
  });
});
