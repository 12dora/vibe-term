import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCachedEdge } from './edge-cache';
import {
  type CachedEdge,
  EDGE_ADDRS_ENV,
  type EdgeCache,
  type EdgeFetch,
  describeEdge,
  isFakeIp,
  isUnusableEdgeIp,
  parseEdgeAddrsEnv,
  parseSrvData,
  resolveEdge,
  resolveEdgeViaDoh,
} from './edge-resolver';
import { FakeSpawner } from './fake-spawn';
import { CloudflaredProvider, edgeArgs } from './provider';

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function srvAnswer(target: string, port = 7844) {
  return {
    name: '_v2-origintunneld._tcp.argotunnel.com',
    type: 33,
    data: `1 100 ${port} ${target}.`,
  };
}

function aAnswer(name: string, ip: string) {
  return { name, type: 1, data: ip };
}

type DohRoute = (name: string, type: string) => Response | Promise<Response>;

function dohFetch(route: DohRoute): { fetchImpl: EdgeFetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: EdgeFetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    return route(url.searchParams.get('name') ?? '', url.searchParams.get('type') ?? '');
  };
  return { fetchImpl, urls };
}

const HAPPY_ROUTE: DohRoute = (name, type) => {
  if (type === '33')
    return Response.json({
      Status: 0,
      Answer: [srvAnswer('region1.v2.argotunnel.com'), srvAnswer('region2.v2.argotunnel.com')],
    });
  if (name === 'region1.v2.argotunnel.com') {
    return Response.json({
      Status: 0,
      Answer: [aAnswer(name, '198.41.192.7'), aAnswer(name, '198.41.192.27')],
    });
  }
  return Response.json({
    Status: 0,
    Answer: [aAnswer(name, '198.41.200.13'), aAnswer(name, '198.41.200.53')],
  });
};

describe('isFakeIp', () => {
  test('matches 198.18.0.0/15 only', () => {
    expect(isFakeIp('198.18.91.209')).toBe(true);
    expect(isFakeIp('198.19.0.1')).toBe(true);
    expect(isFakeIp('198.41.192.7')).toBe(false);
    expect(isFakeIp('198.20.0.1')).toBe(false);
    expect(isFakeIp('198.17.255.255')).toBe(false);
  });

  test('does not crash on IPv6 or garbage', () => {
    for (const value of ['2606:4700::1', '::1', '', 'not-an-ip', '198.18', '198.18.1.999']) {
      expect(isFakeIp(value)).toBe(false);
    }
  });

  test('unusable ips cover fake, private and loopback', () => {
    expect(isUnusableEdgeIp('198.18.1.1')).toBe(true);
    expect(isUnusableEdgeIp('127.0.0.1')).toBe(true);
    expect(isUnusableEdgeIp('10.1.2.3')).toBe(true);
    expect(isUnusableEdgeIp('192.168.1.1')).toBe(true);
    expect(isUnusableEdgeIp('172.20.0.1')).toBe(true);
    expect(isUnusableEdgeIp('2606:4700::1')).toBe(true);
    expect(isUnusableEdgeIp('198.41.192.7')).toBe(false);
  });
});

describe('parseSrvData', () => {
  test('parses priority weight port target and strips the trailing dot', () => {
    expect(parseSrvData('1 100 7844 region1.v2.argotunnel.com.')).toEqual({
      target: 'region1.v2.argotunnel.com',
      port: 7844,
    });
    expect(parseSrvData('bad data')).toBeNull();
    expect(parseSrvData('1 100 0 region1.v2.argotunnel.com.')).toBeNull();
  });
});

describe('parseEdgeAddrsEnv', () => {
  test('splits, trims and validates host:port', () => {
    expect(parseEdgeAddrsEnv(' 198.41.192.7:7844 , 198.41.200.13:7844 ')).toEqual([
      '198.41.192.7:7844',
      '198.41.200.13:7844',
    ]);
    expect(parseEdgeAddrsEnv('nope, 1.2.3.4')).toEqual([]);
    expect(parseEdgeAddrsEnv(undefined)).toEqual([]);
    expect(parseEdgeAddrsEnv('1.1.1.1:1,1.1.1.1:1')).toEqual(['1.1.1.1:1']);
  });
});

describe('resolveEdgeViaDoh', () => {
  test('parses SRV + A answers and interleaves regions', async () => {
    const { fetchImpl, urls } = dohFetch(HAPPY_ROUTE);
    const { addrs } = await resolveEdgeViaDoh(fetchImpl);
    expect(addrs).toEqual([
      '198.41.192.7:7844',
      '198.41.200.13:7844',
      '198.41.192.27:7844',
      '198.41.200.53:7844',
    ]);
    expect(urls[0]).toContain('cloudflare-dns.com');
    expect(urls[0]).toContain('type=33');
  });

  test('falls back to the well-known region names when SRV fails', async () => {
    const asked: string[] = [];
    const { fetchImpl } = dohFetch((name, type) => {
      asked.push(`${name}/${type}`);
      if (type === '33') return new Response('nope', { status: 500 });
      return Response.json({ Status: 0, Answer: [aAnswer(name, '198.41.192.7')] });
    });
    const { addrs } = await resolveEdgeViaDoh(fetchImpl);
    expect(asked.filter((a) => a.endsWith('/33')).length).toBe(2);
    expect(asked).toContain('region1.v2.argotunnel.com/1');
    expect(asked).toContain('region2.v2.argotunnel.com/1');
    expect(addrs).toEqual(['198.41.192.7:7844']);
  });

  test('falls over to the second DoH endpoint', async () => {
    const hosts: string[] = [];
    const fetchImpl: EdgeFetch = async (input) => {
      const url = new URL(String(input));
      hosts.push(url.host);
      if (url.host === 'cloudflare-dns.com') throw new Error('blocked');
      const name = url.searchParams.get('name') ?? '';
      return HAPPY_ROUTE(name, url.searchParams.get('type') ?? '');
    };
    const { addrs } = await resolveEdgeViaDoh(fetchImpl);
    expect(hosts).toContain('dns.google');
    expect(addrs.length).toBeGreaterThan(0);
  });

  test('skips the endpoint that timed out and reuses the one that answered', async () => {
    const hosts: string[] = [];
    let clock = 1_000;
    const fetchImpl: EdgeFetch = async (input, init) => {
      const url = new URL(String(input));
      hosts.push(`${url.host}/${url.searchParams.get('type')}`);
      if (url.host === 'cloudflare-dns.com') {
        // 黑洞：只等自己的超时信号，并按真实开销推进预算时钟
        await new Promise<void>((resolve) => {
          init?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        clock += 5_000;
        throw new Error('aborted');
      }
      const name = url.searchParams.get('name') ?? '';
      return HAPPY_ROUTE(name, url.searchParams.get('type') ?? '');
    };
    const { addrs } = await resolveEdgeViaDoh(fetchImpl, undefined, () => clock, {
      requestTimeoutMs: 20,
    });
    expect(addrs.length).toBeGreaterThan(0);
    expect(hosts.filter((h) => h.startsWith('cloudflare-dns.com')).length).toBe(1);
    expect(hosts.filter((h) => h === 'dns.google/1').length).toBe(2);
  });

  test('throws when every answer is a fake ip', async () => {
    const { fetchImpl } = dohFetch((name, type) => {
      if (type === '33')
        return Response.json({ Status: 0, Answer: [srvAnswer('region1.v2.argotunnel.com')] });
      return Response.json({ Status: 0, Answer: [aAnswer(name, '198.18.91.209')] });
    });
    await expect(resolveEdgeViaDoh(fetchImpl)).rejects.toThrow();
  });

  test('caps the address list at 8 entries', async () => {
    const { fetchImpl } = dohFetch((name, type) => {
      if (type === '33')
        return Response.json({ Status: 0, Answer: [srvAnswer('region1.v2.argotunnel.com')] });
      return Response.json({
        Status: 0,
        Answer: Array.from({ length: 12 }, (_, i) => aAnswer(name, `198.41.192.${i + 1}`)),
      });
    });
    const { addrs } = await resolveEdgeViaDoh(fetchImpl);
    expect(addrs.length).toBe(8);
  });
});

describe('resolveEdge', () => {
  const fakeLookup = async () => ['198.18.91.209'];
  const realLookup = async () => ['198.41.192.7'];

  test('fake-IP lookup switches to a static edge list', async () => {
    const { fetchImpl } = dohFetch(HAPPY_ROUTE);
    const edge = await resolveEdge({ fetchImpl, lookup: fakeLookup, env: {}, now: () => 1_000 });
    expect(edge.fakeIpDetected).toBe(true);
    expect(edge.mode).toBe('static');
    expect(edge.edgeAddrs[0]).toBe('198.41.192.7:7844');
    expect(edge.lastError).toBeNull();
    expect(edge.checkedAt).toBe(new Date(1_000).toISOString());
  });

  test('clean lookup keeps system mode and never calls DoH', async () => {
    let calls = 0;
    const fetchImpl: EdgeFetch = async () => {
      calls += 1;
      return new Response('should not happen', { status: 500 });
    };
    const edge = await resolveEdge({ fetchImpl, lookup: realLookup, env: {} });
    expect(edge).toMatchObject({
      mode: 'system',
      fakeIpDetected: false,
      edgeAddrs: [],
      lastError: null,
    });
    expect(calls).toBe(0);
  });

  test('DoH failure degrades to system mode with a reason', async () => {
    const sleeps: number[] = [];
    const fetchImpl: EdgeFetch = async () => {
      throw new Error('network is unreachable');
    };
    const edge = await resolveEdge({
      fetchImpl,
      lookup: fakeLookup,
      env: {},
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(edge.mode).toBe('system');
    expect(edge.fakeIpDetected).toBe(true);
    expect(edge.edgeAddrs).toEqual([]);
    expect(edge.lastError).toContain('DoH edge resolution failed');
    expect(sleeps).toEqual([1_500, 1_500]);
  });

  test('a transient DoH failure is retried up to three times before giving up', async () => {
    let round = 1;
    const sleeps: number[] = [];
    const fetchImpl: EdgeFetch = async (input) => {
      if (round < 3) throw new Error('network is unreachable');
      const url = new URL(String(input));
      return HAPPY_ROUTE(url.searchParams.get('name') ?? '', url.searchParams.get('type') ?? '');
    };
    const edge = await resolveEdge({
      fetchImpl,
      lookup: fakeLookup,
      env: {},
      now: () => 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        round += 1;
      },
    });
    expect(sleeps).toEqual([1_500, 1_500]);
    expect(edge.mode).toBe('static');
    expect(edge.source).toBe('doh');
    expect(edge.edgeAddrs[0]).toBe('198.41.192.7:7844');
    expect(edge.lastError).toBeNull();
  });

  test('a successful static resolution is persisted and reused when DoH later fails', async () => {
    const now = Date.parse('2026-09-05T00:00:00.000Z');
    const writes: CachedEdge[] = [];
    const cache: EdgeCache = {
      read: async () => writes[writes.length - 1] ?? null,
      write: async (value) => {
        writes.push(value);
      },
    };
    const { fetchImpl } = dohFetch(HAPPY_ROUTE);
    const fresh = await resolveEdge({
      fetchImpl,
      lookup: fakeLookup,
      env: {},
      now: () => now,
      cache,
    });
    expect(fresh.source).toBe('doh');
    expect(writes).toEqual([
      { edgeAddrs: fresh.edgeAddrs, resolvedAt: new Date(now).toISOString() },
    ]);

    const later = now + 3 * 24 * 60 * 60 * 1_000;
    const cached = await resolveEdge({
      fetchImpl: async () => {
        throw new Error('network is unreachable');
      },
      lookup: fakeLookup,
      env: {},
      now: () => later,
      cache,
      sleep: async () => {},
    });
    expect(cached.mode).toBe('static');
    expect(cached.source).toBe('cache');
    expect(cached.edgeAddrs).toEqual(fresh.edgeAddrs);
    expect(cached.lastError).toContain('DoH edge resolution failed');
    expect(describeEdge(cached)).toContain('source=cache');
    expect(writes.length).toBe(1);
  });

  test('a persisted static edge older than seven days is not reused', async () => {
    const now = Date.parse('2026-09-05T00:00:00.000Z');
    const cache: EdgeCache = {
      read: async () => ({
        edgeAddrs: ['198.41.192.7:7844'],
        resolvedAt: new Date(now - 8 * 24 * 60 * 60 * 1_000).toISOString(),
      }),
      write: async () => {},
    };
    const edge = await resolveEdge({
      fetchImpl: async () => {
        throw new Error('network is unreachable');
      },
      lookup: fakeLookup,
      env: {},
      now: () => now,
      cache,
      sleep: async () => {},
    });
    expect(edge.mode).toBe('system');
    expect(edge.edgeAddrs).toEqual([]);
    expect(edge.lastError).toContain('DoH edge resolution failed');
  });

  test('a broken cache never breaks the resolution', async () => {
    const edge = await resolveEdge({
      fetchImpl: async () => {
        throw new Error('network is unreachable');
      },
      lookup: fakeLookup,
      env: {},
      sleep: async () => {},
      cache: {
        read: async () => {
          throw new Error('db is gone');
        },
        write: async () => {
          throw new Error('db is gone');
        },
      },
    });
    expect(edge.mode).toBe('system');
  });

  test('system lookup failure is not a fake ip and never throws', async () => {
    const fetchImpl: EdgeFetch = async () => new Response('', { status: 500 });
    const edge = await resolveEdge({
      fetchImpl,
      lookup: async () => {
        throw new Error('ENOTFOUND region1.v2.argotunnel.com');
      },
      env: {},
    });
    expect(edge.mode).toBe('system');
    expect(edge.fakeIpDetected).toBe(false);
    expect(edge.lastError).toContain('system DNS lookup failed');
  });

  test('env override wins and still reports fake-IP detection', async () => {
    let calls = 0;
    const fetchImpl: EdgeFetch = async () => {
      calls += 1;
      return new Response('', { status: 500 });
    };
    const edge = await resolveEdge({
      fetchImpl,
      lookup: fakeLookup,
      env: { [EDGE_ADDRS_ENV]: '198.41.192.7:7844,198.41.200.13:7844' },
    });
    expect(edge.mode).toBe('static');
    expect(edge.fakeIpDetected).toBe(true);
    expect(edge.edgeAddrs).toEqual(['198.41.192.7:7844', '198.41.200.13:7844']);
    expect(calls).toBe(0);
  });

  test('everything failing still resolves to a system-mode value', async () => {
    const edge = await resolveEdge({
      fetchImpl: async () => {
        throw new Error('boom');
      },
      lookup: async () => {
        throw new Error('boom');
      },
      env: {},
    });
    expect(edge.mode).toBe('system');
    expect(edge.edgeAddrs).toEqual([]);
  });
});

describe('provider --edge args', () => {
  test('edgeArgs only expands static resolutions', () => {
    expect(edgeArgs(null)).toEqual([]);
    expect(
      edgeArgs({
        mode: 'system',
        fakeIpDetected: true,
        edgeAddrs: ['1.2.3.4:7844'],
        checkedAt: null,
        lastError: null,
      })
    ).toEqual([]);
    expect(
      edgeArgs({
        mode: 'static',
        fakeIpDetected: true,
        edgeAddrs: ['1.2.3.4:7844', '5.6.7.8:7844'],
        checkedAt: null,
        lastError: null,
      })
    ).toEqual(['--edge', '1.2.3.4:7844', '--edge', '5.6.7.8:7844', '--protocol', 'http2']);
  });

  test('named and quick spawns append --edge in static mode only', async () => {
    const dir = await tempDir('tmex-tun-edge-');
    const staticSpawner = new FakeSpawner();
    const staticProvider = new CloudflaredProvider(staticSpawner.spawn, dir, async () => 4242, {
      resolveEdge: async () => ({
        mode: 'static',
        fakeIpDetected: true,
        edgeAddrs: ['198.41.192.7:7844'],
        checkedAt: null,
        lastError: null,
      }),
      log: () => {},
    });
    const quick = await staticProvider.spawnQuickRun('/usr/bin/cloudflared', 'http://127.0.0.1:1');
    expect(quick.edge?.mode).toBe('static');
    expect(staticSpawner.calls[0]?.args.join(' ')).toContain('--edge 198.41.192.7:7844');
    const named = await staticProvider.spawnNamedRun('/usr/bin/cloudflared', join(dir, 'c.yml'));
    expect(named.edge?.mode).toBe('static');
    const namedArgs = staticSpawner.calls[1]?.args ?? [];
    expect(namedArgs.join(' ')).toContain('--edge 198.41.192.7:7844');
    expect(namedArgs.indexOf('--edge')).toBeLessThan(namedArgs.indexOf('run'));

    const systemSpawner = new FakeSpawner();
    const systemProvider = new CloudflaredProvider(systemSpawner.spawn, dir, async () => 4242, {
      resolveEdge: async () => ({
        mode: 'system',
        fakeIpDetected: false,
        edgeAddrs: [],
        checkedAt: null,
        lastError: null,
      }),
      log: () => {},
    });
    await systemProvider.spawnQuickRun('/usr/bin/cloudflared', 'http://127.0.0.1:1');
    expect(systemSpawner.calls[0]?.args).not.toContain('--edge');

    const plainSpawner = new FakeSpawner();
    const plainProvider = new CloudflaredProvider(plainSpawner.spawn, dir, async () => 4242);
    const plain = await plainProvider.spawnQuickRun('/usr/bin/cloudflared', 'http://127.0.0.1:1');
    expect(plain.edge).toBeNull();
    expect(plainSpawner.calls[0]?.args).not.toContain('--edge');
  });

  test('a throwing resolver does not block the spawn', async () => {
    const dir = await tempDir('tmex-tun-edge-fail-');
    const spawner = new FakeSpawner();
    const provider = new CloudflaredProvider(spawner.spawn, dir, async () => 4242, {
      resolveEdge: async () => {
        throw new Error('boom');
      },
      log: () => {},
    });
    const handle = await provider.spawnQuickRun('/usr/bin/cloudflared', 'http://127.0.0.1:1');
    expect(handle.edge).toBeNull();
    expect(spawner.calls[0]?.args).not.toContain('--edge');
  });
});

describe('parseCachedEdge', () => {
  test('accepts a well-formed record and rejects the rest', () => {
    expect(
      parseCachedEdge(
        JSON.stringify({
          edgeAddrs: ['198.41.192.7:7844', 'x'],
          resolvedAt: '2026-09-05T00:00:00.000Z',
        })
      )
    ).toEqual({ edgeAddrs: ['198.41.192.7:7844'], resolvedAt: '2026-09-05T00:00:00.000Z' });
    expect(parseCachedEdge(null)).toBeNull();
    expect(parseCachedEdge('not json')).toBeNull();
    expect(
      parseCachedEdge(JSON.stringify({ edgeAddrs: [], resolvedAt: '2026-09-05T00:00:00.000Z' }))
    ).toBeNull();
    expect(
      parseCachedEdge(JSON.stringify({ edgeAddrs: ['198.41.192.7:7844'], resolvedAt: 'nope' }))
    ).toBeNull();
    expect(parseCachedEdge(JSON.stringify({ resolvedAt: '2026-09-05T00:00:00.000Z' }))).toBeNull();
  });
});
