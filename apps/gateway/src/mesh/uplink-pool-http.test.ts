import { describe, expect, test } from 'bun:test';
import { defaultFetchCaPem, defaultProbeHealthz, joinHubPath } from './uplink-pool-http';

function dnsErr(): Error {
  const err = new Error('Unable to connect. Is the computer able to access the url?');
  (err as Error & { code: string }).code = 'ConnectionRefused';
  return err;
}

describe('joinHubPath', () => {
  test('strips trailing slashes before appending', () => {
    expect(joinHubPath('https://hub.example/', '/healthz')).toBe('https://hub.example/healthz');
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
});

describe('defaultFetchCaPem', () => {
  test('DNS failure still fetches CA with rejectUnauthorized=false and original serverName', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const pem = await defaultFetchCaPem('https://hub.example', {
      enabled: true,
      resolve: async () => ({ ip: '8.8.8.8', via: 'doh' }),
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (!url.includes('8.8.8.8')) throw dnsErr();
        return new Response('-----BEGIN CERTIFICATE-----\n');
      },
    });
    expect(pem).toContain('BEGIN CERTIFICATE');
    expect(calls.map((row) => row.url)).toEqual([
      'https://hub.example/api/tls/ca.crt',
      'https://8.8.8.8/api/tls/ca.crt',
    ]);
    expect(
      (calls[1]?.init as { tls?: { rejectUnauthorized?: boolean; serverName?: string } }).tls
    ).toEqual({
      rejectUnauthorized: false,
      serverName: 'hub.example',
    });
    expect((calls[1]?.init as { headers?: { host?: string } }).headers?.host).toBe('hub.example');
  });
});
