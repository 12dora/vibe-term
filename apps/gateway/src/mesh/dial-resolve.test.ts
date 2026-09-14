import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  DIAL_IDENTITY_PATH_HEALTHZ,
  DIAL_RESOLVE_NEGATIVE_TTL_MS,
  DIAL_RESOLVE_TTL_MS,
  checkDialIdentity,
  createDialWsFactory,
  dialTlsForHost,
  fetchWithDnsFallback,
  hostHeaderOfDialUrl,
  hostOfDialUrl,
  identityCheckUrl,
  isDialDnsFallbackEnabled,
  isDnsClassFailure,
  resetDialResolveForTest,
  resolveDialHost,
  rewriteDialUrl,
} from './dial-resolve';

afterEach(() => {
  resetDialResolveForTest();
  delete process.env.VIBETERM_DIAL_DNS_FALLBACK;
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

function dnsErr(message = 'getaddrinfo ENOTFOUND', code = 'ENOTFOUND'): Error {
  const err = new Error(message);
  (err as Error & { code: string }).code = code;
  return err;
}

describe('rewriteDialUrl / dialTlsForHost', () => {
  test('replaces host with IPv4 or bracketed IPv6 and keeps path/query', () => {
    expect(rewriteDialUrl('wss://tmexhub-sh.jiefakj.com/relay/uplink?x=1', '122.51.254.148')).toBe(
      'wss://122.51.254.148/relay/uplink?x=1'
    );
    expect(rewriteDialUrl('wss://relay.example:8443/relay/uplink', '2001:db8::1')).toBe(
      'wss://[2001:db8::1]:8443/relay/uplink'
    );
    expect(hostOfDialUrl('wss://Relay.Example/relay/uplink')).toBe('relay.example');
    expect(hostHeaderOfDialUrl('wss://Relay.Example:9883/relay/uplink')).toBe('relay.example:9883');
  });

  test('tls object keeps CA, serverName is hostname-only, Host carries the port', () => {
    expect(
      dialTlsForHost('hub.example', 'hub.example:9883', { ca: ['pem'], rejectUnauthorized: true })
    ).toEqual({
      tls: { ca: ['pem'], rejectUnauthorized: true, serverName: 'hub.example' },
      headers: { host: 'hub.example:9883' },
    });
    expect(dialTlsForHost('', 'hub.example')).toBeUndefined();
  });
});

describe('isDnsClassFailure / env knob', () => {
  test('recognizes Bun DNS-mapped fetch/ws errors and Node ENOTFOUND', () => {
    const refused = new Error('Unable to connect. Is the computer able to access the url?');
    (refused as Error & { code: string }).code = 'ConnectionRefused';
    expect(isDnsClassFailure(refused)).toBe(true);
    const typo = new Error('Was there a typo in the url or port?');
    (typo as Error & { code: string }).code = 'FailedToOpenSocket';
    expect(isDnsClassFailure(typo)).toBe(true);
    expect(
      isDnsClassFailure(new Error("WebSocket connection to 'wss://x/' failed: Failed to connect"))
    ).toBe(true);
    expect(isDnsClassFailure(dnsErr())).toBe(true);
    const bunLookup = dnsErr('getaddrinfo ENOTFOUND', 'DNS_ENOTFOUND');
    expect(isDnsClassFailure(bunLookup)).toBe(true);
    expect(isDnsClassFailure(new Error('connect ECONNREFUSED 1.2.3.4:443'))).toBe(false);
  });

  test('VIBETERM_DIAL_DNS_FALLBACK=off disables the knob', () => {
    expect(isDialDnsFallbackEnabled()).toBe(true);
    process.env.VIBETERM_DIAL_DNS_FALLBACK = 'off';
    expect(isDialDnsFallbackEnabled()).toBe(false);
  });
});

describe('resolveDialHost', () => {
  test('system ok uses the IPv4 and does not call DoH', async () => {
    const result = await resolveDialHost('hub.example', {
      lookup: lookupOf({ 'hub.example': ['9.9.9.9', '2001:db8::9'] }),
      doh: async () => {
        throw new Error('doh should not run');
      },
    });
    expect(result).toEqual({ ip: '9.9.9.9', via: 'system' });
  });

  test('system ENOTFOUND falls over to DoH IPv4', async () => {
    const result = await resolveDialHost('hub.example', {
      lookup: lookupOf({ 'hub.example': dnsErr() }),
      doh: dohOf({ 'hub.example': ['122.51.254.148'] }),
    });
    expect(result).toEqual({ ip: '122.51.254.148', via: 'doh' });
  });

  test('DoH fake-IP only is treated as failure', async () => {
    const result = await resolveDialHost('hub.example', {
      lookup: async () => [],
      doh: async () => ['198.18.0.24', '198.19.1.1'],
    });
    expect(result).toBeNull();
  });

  test('system fake-IP / unusable answers are skipped so DoH can run', async () => {
    const result = await resolveDialHost('hub.example', {
      lookup: async () => ['198.18.32.196', '10.0.0.1', '100.64.1.2'],
      doh: async () => ['1.1.1.1'],
    });
    expect(result).toEqual({ ip: '1.1.1.1', via: 'doh' });
  });

  test('memoizes success for ~60s and failures for ~15s', async () => {
    let now = 1_000;
    let lookups = 0;
    const lookup = async () => {
      lookups += 1;
      throw dnsErr();
    };
    const doh = async () => ['8.8.8.8'];
    const opts = { lookup, doh, now: () => now };
    expect(await resolveDialHost('hub.example', opts)).toEqual({ ip: '8.8.8.8', via: 'doh' });
    now += DIAL_RESOLVE_TTL_MS - 1;
    expect(await resolveDialHost('hub.example', opts)).toEqual({ ip: '8.8.8.8', via: 'doh' });
    expect(lookups).toBe(1);
    now += 2;
    expect(await resolveDialHost('hub.example', opts)).toEqual({ ip: '8.8.8.8', via: 'doh' });
    expect(lookups).toBe(2);

    resetDialResolveForTest();
    lookups = 0;
    now = 1_000;
    const failOpts = {
      lookup: async () => {
        lookups += 1;
        throw dnsErr();
      },
      doh: async () => [] as string[],
      now: () => now,
    };
    expect(await resolveDialHost('down.example', failOpts)).toBeNull();
    now += DIAL_RESOLVE_NEGATIVE_TTL_MS - 1;
    expect(await resolveDialHost('down.example', failOpts)).toBeNull();
    expect(lookups).toBe(1);
    now += 2;
    expect(await resolveDialHost('down.example', failOpts)).toBeNull();
    expect(lookups).toBe(2);
  });

  test('logs fallback once then recovered when system DNS works again', async () => {
    const lines: string[] = [];
    const warn = spyOn(console, 'warn').mockImplementation((msg: unknown) => {
      lines.push(String(msg));
    });
    let now = 1_000;
    let systemOk = false;
    const opts = {
      lookup: async () => {
        if (!systemOk) throw dnsErr();
        return ['9.9.9.9'];
      },
      doh: async () => ['1.1.1.1'],
      now: () => now,
    };
    try {
      await resolveDialHost('hub.example', opts);
      await resolveDialHost('hub.example', opts);
      now += DIAL_RESOLVE_TTL_MS + 1;
      systemOk = true;
      await resolveDialHost('hub.example', opts);
      const fallback = lines.filter((line) => line.includes('[uplink] dns fallback'));
      const recovered = lines.filter((line) => line.includes('[uplink] dns recovered'));
      expect(fallback).toHaveLength(1);
      expect(fallback[0]).toContain('host=hub.example');
      expect(fallback[0]).toContain('ip=1.1.1.1');
      expect(fallback[0]).toContain('via=doh');
      expect(recovered).toEqual([
        expect.stringContaining('[uplink] dns recovered host=hub.example'),
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test('lookup timeout falls over to DoH', async () => {
    const result = await resolveDialHost('hub.example', {
      lookup: () => new Promise(() => undefined),
      doh: async () => ['4.4.4.4'],
      timeoutMs: 20,
    });
    expect(result).toEqual({ ip: '4.4.4.4', via: 'doh' });
  });

  test('IP literals skip lookup', async () => {
    const result = await resolveDialHost('122.51.254.148', {
      lookup: async () => {
        throw new Error('lookup should not run');
      },
    });
    expect(result).toEqual({ ip: '122.51.254.148', via: 'system' });
  });
});

describe('createDialWsFactory', () => {
  test('identity-checks with fetch before WS redial and keeps serverName + Host', async () => {
    const identity: Array<{ url: string; init?: RequestInit }> = [];
    const calls: Array<{
      url: string;
      opts?: { tls?: { serverName?: string; ca?: string[] }; headers?: { host?: string } };
    }> = [];
    const factory = createDialWsFactory(['-----BEGIN CERTIFICATE-----'], {
      raceCount: 1,
      enabled: true,
      resolve: async () => ({ ip: '122.51.254.148', via: 'doh' }),
      fetchImpl: async (url, init) => {
        identity.push({ url, init });
        return new Response(null, { status: 503 });
      },
      wsCtor: (url, opts) => {
        calls.push({ url, opts });
        const ws = new FakeSocket();
        if (url.includes('122.51.254.148')) ws.open();
        else ws.fail(dnsErr());
        return ws as never;
      },
    });
    await factory('wss://tmexhub-sh.jiefakj.com/relay/uplink');
    expect(identity.map((row) => row.url)).toEqual(['https://122.51.254.148/healthz']);
    expect((identity[0]?.init as { tls?: { serverName?: string; ca?: string[] } }).tls).toEqual({
      ca: ['-----BEGIN CERTIFICATE-----'],
      serverName: 'tmexhub-sh.jiefakj.com',
    });
    expect((identity[0]?.init as { headers?: { host?: string } }).headers?.host).toBe(
      'tmexhub-sh.jiefakj.com'
    );
    expect(calls.map((row) => row.url)).toEqual([
      'wss://tmexhub-sh.jiefakj.com/relay/uplink',
      'wss://122.51.254.148/relay/uplink',
    ]);
    expect(calls[1]?.opts?.tls).toEqual({
      ca: ['-----BEGIN CERTIFICATE-----'],
      serverName: 'tmexhub-sh.jiefakj.com',
    });
    expect(calls[1]?.opts?.headers).toEqual({ host: 'tmexhub-sh.jiefakj.com' });
  });

  test('skips WS redial when the identity check rejects', async () => {
    const lines: string[] = [];
    const warn = spyOn(console, 'warn').mockImplementation((msg: unknown) => {
      lines.push(String(msg));
    });
    const calls: string[] = [];
    const factory = createDialWsFactory(null, {
      raceCount: 1,
      enabled: true,
      resolve: async () => ({ ip: '122.51.254.148', via: 'doh' }),
      fetchImpl: async () => {
        throw Object.assign(new Error('ERR_TLS_CERT_ALTNAME_INVALID'), {
          code: 'ERR_TLS_CERT_ALTNAME_INVALID',
        });
      },
      wsCtor: (url) => {
        calls.push(url);
        const ws = new FakeSocket();
        ws.fail(dnsErr());
        return ws as never;
      },
    });
    try {
      await expect(factory('wss://hub.example/uplink')).rejects.toBeDefined();
      expect(calls).toEqual(['wss://hub.example/uplink']);
      expect(lines.some((line) => line.includes('dns fallback identity check failed'))).toBe(true);
      expect(lines.some((line) => line.includes('host=hub.example'))).toBe(true);
      expect(lines.some((line) => line.includes('ip=122.51.254.148'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('Host header keeps a non-443 port on the primary path', async () => {
    const calls: Array<{
      url: string;
      opts?: { tls?: { serverName?: string }; headers?: { host?: string } };
    }> = [];
    const factory = createDialWsFactory(null, {
      raceCount: 1,
      enabled: true,
      wsCtor: (url, opts) => {
        calls.push({ url, opts });
        const ws = new FakeSocket();
        ws.open();
        return ws as never;
      },
    });
    await factory('wss://hub.example:9883/uplink');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts?.tls?.serverName).toBe('hub.example');
    expect(calls[0]?.opts?.headers?.host).toBe('hub.example:9883');
  });

  test('does not redial after ECONNREFUSED, ConnectionRefused, or 4401', async () => {
    for (const fail of [
      Object.assign(new Error('connect ECONNREFUSED 9.9.9.9:443'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), {
        code: 'ConnectionRefused',
      }),
      Object.assign(new Error('ws-closed 4401 unauthorized'), { closeCode: 4401 }),
    ]) {
      const calls: string[] = [];
      const factory = createDialWsFactory(null, {
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
      await expect(factory('wss://hub.example/uplink')).rejects.toBeDefined();
      expect(calls).toEqual(['wss://hub.example/uplink']);
    }
  });

  test('does not redial when system DNS succeeded (via=system)', async () => {
    const calls: string[] = [];
    let resolved = 0;
    const factory = createDialWsFactory(null, {
      raceCount: 1,
      enabled: true,
      resolve: async () => {
        resolved += 1;
        return { ip: '9.9.9.9', via: 'system' };
      },
      wsCtor: (url) => {
        calls.push(url);
        const ws = new FakeSocket();
        ws.fail(dnsErr());
        return ws as never;
      },
    });
    await expect(factory('wss://hub.example/uplink')).rejects.toBeDefined();
    expect(resolved).toBe(1);
    expect(calls).toEqual(['wss://hub.example/uplink']);
  });

  test('system-ok first dial does not rewrite the URL', async () => {
    const calls: string[] = [];
    const factory = createDialWsFactory(null, {
      raceCount: 1,
      enabled: true,
      resolve: async () => ({ ip: '9.9.9.9', via: 'system' }),
      wsCtor: (url) => {
        calls.push(url);
        const ws = new FakeSocket();
        ws.open();
        return ws as never;
      },
    });
    await factory('wss://hub.example/uplink');
    expect(calls).toEqual(['wss://hub.example/uplink']);
  });
});

describe('fetchWithDnsFallback', () => {
  test('retries the IP URL with SNI + Host after a DNS-class fetch failure', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const res = await fetchWithDnsFallback(
      'https://hub.example/healthz',
      { method: 'GET', tls: { ca: ['pem'] } } as RequestInit,
      {
        enabled: true,
        resolve: async () => ({ ip: '1.2.3.4', via: 'doh' }),
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          if (!url.includes('1.2.3.4')) throw dnsErr();
          return new Response(null, { status: 200 });
        },
      }
    );
    expect(res.ok).toBe(true);
    expect(calls.map((row) => row.url)).toEqual([
      'https://hub.example/healthz',
      'https://1.2.3.4/healthz',
    ]);
    expect((calls[1]?.init as { tls?: { serverName?: string; ca?: string[] } }).tls).toEqual({
      ca: ['pem'],
      serverName: 'hub.example',
    });
    expect((calls[1]?.init as { headers?: { host?: string } }).headers?.host).toBe('hub.example');
  });

  test('retries a non-443 URL with Host including the port and preserves Headers', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const res = await fetchWithDnsFallback(
      'https://hub.example:8443/healthz',
      { method: 'GET', headers: new Headers({ 'x-a': '1' }) },
      {
        enabled: true,
        resolve: async () => ({ ip: '1.2.3.4', via: 'doh' }),
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          if (!url.includes('1.2.3.4')) throw dnsErr();
          return new Response(null, { status: 200 });
        },
      }
    );
    expect(res.ok).toBe(true);
    expect(calls.map((row) => row.url)).toEqual([
      'https://hub.example:8443/healthz',
      'https://1.2.3.4:8443/healthz',
    ]);
    expect((calls[1]?.init as { tls?: { serverName?: string } }).tls).toEqual({
      serverName: 'hub.example',
    });
    expect((calls[1]?.init as { headers?: { host?: string; 'x-a'?: string } }).headers).toEqual({
      'x-a': '1',
      host: 'hub.example:8443',
    });
  });

  test('does not retry a non-DNS boom', async () => {
    let n = 0;
    await expect(
      fetchWithDnsFallback(
        'https://hub.example/healthz',
        {},
        {
          enabled: true,
          resolve: async () => ({ ip: '1.2.3.4', via: 'doh' }),
          fetchImpl: async () => {
            n += 1;
            throw new Error('boom');
          },
        }
      )
    ).rejects.toThrow('boom');
    expect(n).toBe(1);
  });
});

describe('resolveDialHost extras', () => {
  test('logs dns fallback failed once per host when system and DoH both miss', async () => {
    const lines: string[] = [];
    const warn = spyOn(console, 'warn').mockImplementation((msg: unknown) => {
      lines.push(String(msg));
    });
    try {
      await resolveDialHost('down.example', {
        lookup: async () => {
          throw dnsErr();
        },
        doh: async () => [] as string[],
      });
      await resolveDialHost('down.example', {
        lookup: async () => {
          throw dnsErr();
        },
        doh: async () => [] as string[],
      });
      const failed = lines.filter((line) => line.includes('[uplink] dns fallback failed'));
      expect(failed).toHaveLength(1);
      expect(failed[0]).toContain('host=down.example');
      expect(failed[0]).toContain('reason=');
    } finally {
      warn.mockRestore();
    }
  });

  test('aborted signal skips lookup and DoH', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await resolveDialHost('hub.example', {
      signal: ac.signal,
      lookup: async () => {
        throw new Error('lookup should not run');
      },
      doh: async () => {
        throw new Error('doh should not run');
      },
    });
    expect(result).toBeNull();
  });

  test('does not call network DoH in test without dohEnabled/doh/fetchImpl', async () => {
    const result = await resolveDialHost('hub.example', {
      lookup: async () => {
        throw dnsErr();
      },
    });
    expect(result).toBeNull();
  });
});

describe('checkDialIdentity', () => {
  test('builds https://ip/path and treats any HTTP status as success', async () => {
    expect(
      identityCheckUrl({
        ip: '122.51.254.148',
        hostname: 'hub.example',
        path: DIAL_IDENTITY_PATH_HEALTHZ,
      })
    ).toBe('https://122.51.254.148/healthz');
    const ok = await checkDialIdentity({
      ip: '1.2.3.4',
      hostname: 'hub.example',
      headerHost: 'hub.example:9883',
      path: '/healthz',
      originalUrl: 'wss://hub.example:9883/uplink',
      fetchImpl: async (url, init) => {
        expect(url).toBe('https://1.2.3.4:9883/healthz');
        expect((init as { tls?: { serverName?: string } }).tls?.serverName).toBe('hub.example');
        expect((init as { headers?: { host?: string } }).headers?.host).toBe('hub.example:9883');
        return new Response(null, { status: 404 });
      },
    });
    expect(ok).toBe(true);
  });
});
