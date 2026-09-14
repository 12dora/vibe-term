import { describe, expect, test } from 'bun:test';
import { defaultProbeHealthz, joinUplinkPath } from './uplink-pool-http';

function dnsErr(): Error {
  const err = new Error('getaddrinfo ENOTFOUND');
  (err as Error & { code: string }).code = 'ENOTFOUND';
  return err;
}

describe('joinUplinkPath', () => {
  test('strips trailing slashes before appending', () => {
    expect(joinUplinkPath('https://hub.example/', '/healthz')).toBe('https://hub.example/healthz');
  });
});

describe('defaultProbeHealthz', () => {
  test('system-ok fetch does not rewrite', async () => {
    const urls: string[] = [];
    expect(
      await defaultProbeHealthz('https://hub.example', ['pem'], 1_000, {
        enabled: true,
        fetchImpl: async (url) => {
          urls.push(url);
          return new Response(null, { status: 200 });
        },
      })
    ).toBe(true);
    expect(urls).toEqual(['https://hub.example/healthz']);
  });

  test('DNS failure redials by IP with serverName and Host', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    expect(
      await defaultProbeHealthz('https://hub.example', ['pem'], 1_000, {
        enabled: true,
        resolve: async () => ({ ip: '9.9.9.9', via: 'doh' }),
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          if (!url.includes('9.9.9.9')) throw dnsErr();
          return new Response(null, { status: 200 });
        },
      })
    ).toBe(true);
    expect(calls.map((row) => row.url)).toEqual([
      'https://hub.example/healthz',
      'https://9.9.9.9/healthz',
    ]);
    expect((calls[1]?.init as { tls?: { ca?: string[]; serverName?: string } }).tls).toEqual({
      ca: ['pem'],
      serverName: 'hub.example',
    });
    expect((calls[1]?.init as { headers?: { host?: string } }).headers?.host).toBe('hub.example');
  });

  test('ECONNREFUSED does not redial', async () => {
    let n = 0;
    expect(
      await defaultProbeHealthz('https://hub.example', null, 1_000, {
        enabled: true,
        resolve: async () => ({ ip: '1.2.3.4', via: 'doh' }),
        fetchImpl: async () => {
          n += 1;
          throw Object.assign(new Error('connect ECONNREFUSED 9.9.9.9:443'), {
            code: 'ECONNREFUSED',
          });
        },
      })
    ).toBe(false);
    expect(n).toBe(1);
  });

  test('cannot exceed timeoutMs even if fetch ignores abort', async () => {
    const started = Date.now();
    expect(
      await defaultProbeHealthz('https://hub.example', null, 40, {
        enabled: false,
        fetchImpl: () => new Promise(() => undefined),
      })
    ).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
