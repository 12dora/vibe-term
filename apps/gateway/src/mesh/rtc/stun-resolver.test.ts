import { afterEach, describe, expect, test } from 'bun:test';
import {
  STUN_RESOLVE_CACHE_MAX,
  STUN_RESOLVE_CACHE_TTL_MS,
  STUN_RESOLVE_NEGATIVE_TTL_MAX_MS,
  STUN_RESOLVE_NEGATIVE_TTL_MID_MS,
  STUN_RESOLVE_NEGATIVE_TTL_MS,
  formatHostForIceUrl,
  resetStunResolverForTest,
  resolveIceServers,
  splitIceServerUrl,
  stunResolveSnapshot,
} from './stun-resolver';

afterEach(() => {
  resetStunResolverForTest();
});

function lookupOf(map: Record<string, string[] | Error>): (hostname: string) => Promise<string[]> {
  return async (hostname) => {
    const value = map[hostname];
    if (value instanceof Error) throw value;
    if (!value) throw new Error(`unexpected lookup ${hostname}`);
    return value;
  };
}

function dohOf(map: Record<string, string[] | Error>): (hostname: string) => Promise<string[]> {
  return async (hostname) => {
    const value = map[hostname];
    if (value instanceof Error) throw value;
    if (!value) throw new Error(`unexpected doh ${hostname}`);
    return value;
  };
}

describe('splitIceServerUrl / formatHostForIceUrl', () => {
  test('keeps scheme, port and transport query', () => {
    expect(splitIceServerUrl('stun:stun.l.google.com:19302')).toEqual({
      scheme: 'stun:',
      host: 'stun.l.google.com',
      portPart: ':19302',
      query: '',
    });
    expect(splitIceServerUrl('turns:relay.example:5349?transport=tcp')).toEqual({
      scheme: 'turns:',
      host: 'relay.example',
      portPart: ':5349',
      query: '?transport=tcp',
    });
    expect(splitIceServerUrl('stun:[2001:db8::1]:3478')).toEqual({
      scheme: 'stun:',
      host: '2001:db8::1',
      portPart: ':3478',
      query: '',
    });
    expect(splitIceServerUrl('not-a-url')).toBeNull();
    expect(formatHostForIceUrl('1.2.3.4')).toBe('1.2.3.4');
    expect(formatHostForIceUrl('2001:db8::1')).toBe('[2001:db8::1]');
  });
});

describe('resolveIceServers', () => {
  test('passes IP literals through untouched', async () => {
    const lookup = async () => {
      throw new Error('lookup should not run');
    };
    const servers = await resolveIceServers(['stun:1.2.3.4:3478', 'stun:[2001:db8::1]:3478'], {
      lookup,
      doh: async () => [],
    });
    expect(servers).toEqual(['stun:1.2.3.4:3478', 'stun:[2001:db8::1]:3478']);
  });

  test('leaves healthy system-DNS URLs untouched', async () => {
    const servers = await resolveIceServers(['stun:stun.example:19302', 'stun:v6.example:3478'], {
      lookup: lookupOf({
        'stun.example': ['74.125.200.1'],
        'v6.example': ['2001:db8::53'],
      }),
      doh: async () => {
        throw new Error('doh should not run');
      },
    });
    expect(servers).toEqual(['stun:stun.example:19302', 'stun:v6.example:3478']);
    expect(stunResolveSnapshot().map((row) => row.via)).toEqual(['system', 'system']);
  });

  test('falls over to DoH when system returns fake-IP or fails', async () => {
    const servers = await resolveIceServers(
      [
        'stun:fake.example:19302',
        'turn:down.example:3478?transport=udp',
        {
          hostname: 'turn.example',
          port: 3478,
          relayType: 'TurnUdp',
          username: 'u',
          password: 'p',
        },
      ],
      {
        lookup: lookupOf({
          'fake.example': ['198.18.0.24'],
          'down.example': new Error('ENOTFOUND'),
          'turn.example': ['198.19.1.1'],
        }),
        doh: dohOf({
          'fake.example': ['8.8.8.8'],
          'down.example': ['9.9.9.9'],
          'turn.example': ['1.1.1.1'],
        }),
      }
    );
    expect(servers).toEqual([
      'stun:8.8.8.8:19302',
      'turn:9.9.9.9:3478?transport=udp',
      {
        hostname: '1.1.1.1',
        port: 3478,
        relayType: 'TurnUdp',
        username: 'u',
        password: 'p',
      },
    ]);
    const snap = stunResolveSnapshot();
    expect(snap.map((row) => row.via)).toEqual(['doh', 'doh', 'doh']);
    expect(snap.every((row) => row.fakeIp || row.host === 'down.example')).toBe(true);
  });

  test('treats unusable-only system answers as absent and uses DoH', async () => {
    const servers = await resolveIceServers(['stun:blocked.example:3478'], {
      lookup: async () => [
        '0.0.0.0',
        '127.0.0.1',
        '10.1.2.3',
        '192.168.0.1',
        '100.64.0.1',
        '172.16.0.1',
      ],
      doh: async () => ['1.1.1.1'],
    });
    expect(servers).toEqual(['stun:1.1.1.1:3478']);
    expect(stunResolveSnapshot()[0]?.via).toBe('doh');
  });

  test('keeps the original URL when DoH also fails', async () => {
    const original = 'stun:stun.example:19302';
    const servers = await resolveIceServers([original], {
      lookup: async () => ['198.18.9.9'],
      doh: async () => {
        throw new Error('blocked');
      },
    });
    expect(servers).toEqual([original]);
  });

  test('does not rewrite a healthy dual-stack system answer', async () => {
    const servers = await resolveIceServers(['stun:dual.example:3478'], {
      lookup: async () => ['2001:db8::1', '203.0.113.8'],
      doh: async () => {
        throw new Error('doh should not run');
      },
    });
    expect(servers).toEqual(['stun:dual.example:3478']);
  });

  test('preserves family order when substituting a DoH answer', async () => {
    const servers = await resolveIceServers(['stun:dual.example:3478'], {
      lookup: async () => ['198.18.0.1'],
      doh: async () => ['2001:db8::1', '203.0.113.8'],
    });
    expect(servers).toEqual(['stun:[2001:db8::1]:3478']);
  });

  test('passes mixed fake+usable system answers through with fake_ip=true', async () => {
    const servers = await resolveIceServers(['stun:mix.example:3478'], {
      lookup: async () => ['198.18.0.9', '203.0.113.7'],
      doh: async () => {
        throw new Error('doh should not run');
      },
    });
    expect(servers).toEqual(['stun:mix.example:3478']);
    expect(stunResolveSnapshot()).toEqual([
      expect.objectContaining({
        host: 'mix.example',
        ip: '203.0.113.7',
        via: 'system',
        fakeIp: true,
      }),
    ]);
  });

  test('does not substitute turns/stuns URLs or TurnTls entries', async () => {
    const seen: string[] = [];
    const servers = await resolveIceServers(
      [
        'stuns:secure.example:5349',
        'turns:relay.example:5349?transport=tcp',
        { hostname: 'tls.example', port: 5349, relayType: 'TurnTls', username: 'u', password: 'p' },
        'stun:plain.example:3478',
      ],
      {
        lookup: async (hostname) => {
          seen.push(hostname);
          return ['198.18.0.1'];
        },
        doh: async () => ['2.2.2.2'],
      }
    );
    expect(seen).toEqual(['plain.example']);
    expect(servers).toEqual([
      'stuns:secure.example:5349',
      'turns:relay.example:5349?transport=tcp',
      { hostname: 'tls.example', port: 5349, relayType: 'TurnTls', username: 'u', password: 'p' },
      'stun:2.2.2.2:3478',
    ]);
  });

  test('lower-cases cache and inflight keys', async () => {
    let lookups = 0;
    const lookup = async () => {
      lookups += 1;
      return ['203.0.113.1'];
    };
    const opts = { lookup, doh: async () => [] };
    await resolveIceServers(['stun:STUN.Example:3478'], opts);
    await resolveIceServers(['stun:stun.example:3478'], opts);
    expect(lookups).toBe(1);
  });

  test('caches a successful answer for the TTL', async () => {
    let lookups = 0;
    let now = 1_000;
    const lookup = async () => {
      lookups += 1;
      return ['203.0.113.1'];
    };
    const opts = { lookup, doh: async () => [], now: () => now };
    expect(await resolveIceServers(['stun:cached.example:3478'], opts)).toEqual([
      'stun:cached.example:3478',
    ]);
    expect(await resolveIceServers(['stun:cached.example:3478'], opts)).toEqual([
      'stun:cached.example:3478',
    ]);
    expect(lookups).toBe(1);
    now += STUN_RESOLVE_CACHE_TTL_MS + 1;
    expect(await resolveIceServers(['stun:cached.example:3478'], opts)).toEqual([
      'stun:cached.example:3478',
    ]);
    expect(lookups).toBe(2);
  });

  test('returns last-known immediately while a refresh runs in the background', async () => {
    let now = 1_000;
    expect(
      await resolveIceServers(['stun:stale.example:3478'], {
        lookup: async () => ['198.18.0.1'],
        doh: async () => ['9.9.9.9'],
        now: () => now,
      })
    ).toEqual(['stun:9.9.9.9:3478']);

    now += STUN_RESOLVE_CACHE_TTL_MS + 1;
    let release!: (ips: string[]) => void;
    const blocked = new Promise<string[]>((resolve) => {
      release = resolve;
    });
    const started = Date.now();
    const staleHit = await resolveIceServers(['stun:stale.example:3478'], {
      lookup: async () => ['198.18.0.2'],
      doh: async () => blocked,
      now: () => now,
      budgetMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(80);
    expect(staleHit).toEqual(['stun:9.9.9.9:3478']);

    release(['8.8.8.8']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      await resolveIceServers(['stun:stale.example:3478'], {
        lookup: async () => ['198.18.0.3'],
        doh: async () => ['8.8.8.8'],
        now: () => now,
      })
    ).toEqual(['stun:8.8.8.8:3478']);
  });

  test('in-flight joiners use their own deadline', async () => {
    let resolveLookup!: (ips: string[]) => void;
    const lookupPromise = new Promise<string[]>((resolve) => {
      resolveLookup = resolve;
    });
    const lookup = () => lookupPromise;
    const original = 'stun:join.example:3478';
    const first = resolveIceServers([original], {
      lookup,
      doh: async () => [],
      budgetMs: 250,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    const second = await resolveIceServers([original], {
      lookup,
      doh: async () => [],
      budgetMs: 30,
    });
    expect(Date.now() - started).toBeLessThan(120);
    expect(second).toEqual([original]);
    resolveLookup(['203.0.113.5']);
    expect(await first).toEqual([original]);
  });

  test('backs off negative TTL exponentially after repeated failures', async () => {
    let lookups = 0;
    let now = 1_000;
    const opts = {
      lookup: async () => {
        lookups += 1;
        return ['198.18.0.1'];
      },
      doh: async () => [],
      now: () => now,
    };
    const url = 'stun:down.example:3478';
    await resolveIceServers([url], opts);
    expect(lookups).toBe(1);

    now += STUN_RESOLVE_NEGATIVE_TTL_MS - 1;
    await resolveIceServers([url], opts);
    expect(lookups).toBe(1);

    now += 2;
    await resolveIceServers([url], opts);
    expect(lookups).toBe(2);

    now += STUN_RESOLVE_NEGATIVE_TTL_MID_MS - 1;
    await resolveIceServers([url], opts);
    expect(lookups).toBe(2);

    now += 2;
    await resolveIceServers([url], opts);
    expect(lookups).toBe(3);

    now += STUN_RESOLVE_NEGATIVE_TTL_MAX_MS - 1;
    await resolveIceServers([url], opts);
    expect(lookups).toBe(3);

    now += 2;
    await resolveIceServers([url], opts);
    expect(lookups).toBe(4);
  });

  test('evicts the oldest cache entry past the LRU cap', async () => {
    const now = 5_000;
    const lookup = async (hostname: string) => {
      const n = Number(/^h(\d+)\./.exec(hostname)?.[1] ?? 0);
      return [`203.0.113.${(n % 250) + 1}`];
    };
    const opts = { lookup, doh: async () => [], now: () => now };
    for (let i = 1; i <= STUN_RESOLVE_CACHE_MAX + 1; i += 1) {
      await resolveIceServers([`stun:h${i}.example:3478`], opts);
    }
    let lookups = 0;
    const counting = async (hostname: string) => {
      lookups += 1;
      return [`9.9.9.${hostname === 'h1.example' ? 1 : 33}`];
    };
    await resolveIceServers(['stun:h1.example:3478'], {
      lookup: counting,
      doh: async () => [],
      now: () => now,
    });
    expect(lookups).toBe(1);
    lookups = 0;
    await resolveIceServers([`stun:h${STUN_RESOLVE_CACHE_MAX + 1}.example:3478`], {
      lookup: counting,
      doh: async () => [],
      now: () => now,
    });
    expect(lookups).toBe(0);
  });

  test('falls back to the original URL when the budget elapses', async () => {
    const original = 'stun:slow.example:3478';
    const servers = await resolveIceServers([original], {
      budgetMs: 20,
      lookup: () => new Promise(() => {}),
      doh: () => new Promise(() => {}),
    });
    expect(servers).toEqual([original]);
  });

  test('stunResolveSnapshot returns a copy', async () => {
    await resolveIceServers(['stun:snap.example:3478'], {
      lookup: async () => ['203.0.113.1'],
      doh: async () => [],
    });
    const first = stunResolveSnapshot();
    const second = stunResolveSnapshot();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first).toHaveLength(1);
  });

  test('rate-limits the info line and warns when DoH fails', async () => {
    const logs: string[] = [];
    const warns: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const prevLevel = process.env.VIBETERM_LOG_LEVEL;
    process.env.VIBETERM_LOG_LEVEL = 'info';
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      const now = 10_000;
      await resolveIceServers(['stun:ok.example:3478'], {
        lookup: async () => ['203.0.113.9'],
        doh: async () => [],
        now: () => now,
      });
      resetStunResolverForTest({ retainLogTimes: true });
      await resolveIceServers(['stun:ok.example:3478'], {
        lookup: async () => ['203.0.113.9'],
        doh: async () => [],
        now: () => now + 1_000,
      });
      expect(logs.filter((line) => line.includes('stun resolve host=ok.example')).length).toBe(1);
      expect(
        logs.some((line) => line.includes('via=system') && line.includes('fake_ip=false'))
      ).toBe(true);

      resetStunResolverForTest();
      await resolveIceServers(['stun:bad.example:3478'], {
        lookup: async () => ['198.18.0.1'],
        doh: async () => {
          throw new Error('nope');
        },
        now: () => 20_000,
      });
      expect(warns.some((line) => line.includes('stun resolve host=bad.example'))).toBe(true);
      expect(warns.some((line) => line.includes('via=doh') && line.includes('fake_ip=true'))).toBe(
        true
      );
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      if (prevLevel === undefined) delete process.env.VIBETERM_LOG_LEVEL;
      else process.env.VIBETERM_LOG_LEVEL = prevLevel;
    }
  });
});
