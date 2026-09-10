import { afterEach, describe, expect, test } from 'bun:test';
import {
  STUN_RESOLVE_CACHE_MAX,
  STUN_RESOLVE_CACHE_TTL_MS,
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

  test('substitutes a system A record and brackets IPv6', async () => {
    const servers = await resolveIceServers(['stun:stun.example:19302', 'stun:v6.example:3478'], {
      lookup: lookupOf({
        'stun.example': ['74.125.200.1'],
        'v6.example': ['2001:db8::53'],
      }),
      doh: async () => {
        throw new Error('doh should not run');
      },
    });
    expect(servers).toEqual(['stun:74.125.200.1:19302', 'stun:[2001:db8::53]:3478']);
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

  test('prefers IPv4 when system returns both families', async () => {
    const servers = await resolveIceServers(['stun:dual.example:3478'], {
      lookup: async () => ['2001:db8::1', '203.0.113.8'],
      doh: async () => [],
    });
    expect(servers).toEqual(['stun:203.0.113.8:3478']);
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
      'stun:203.0.113.1:3478',
    ]);
    expect(await resolveIceServers(['stun:cached.example:3478'], opts)).toEqual([
      'stun:203.0.113.1:3478',
    ]);
    expect(lookups).toBe(1);
    now += STUN_RESOLVE_CACHE_TTL_MS + 1;
    expect(await resolveIceServers(['stun:cached.example:3478'], opts)).toEqual([
      'stun:203.0.113.1:3478',
    ]);
    expect(lookups).toBe(2);
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
      await resolveIceServers(['stun:ok.example:3478'], {
        lookup: async () => ['203.0.113.9'],
        doh: async () => [],
        now: () => now,
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
