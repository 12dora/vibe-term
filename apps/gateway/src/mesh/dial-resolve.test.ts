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
  isConnectClassFailure,
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

  test('isConnectClassFailure matches timeout / refused / unreach, not TLS or 101', () => {
    expect(isConnectClassFailure(new Error('connect-timeout'))).toBe(true);
    expect(
      isConnectClassFailure(
        Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' })
      )
    ).toBe(true);
    expect(
      isConnectClassFailure(Object.assign(new Error('no route'), { code: 'EHOSTUNREACH' }))
    ).toBe(true);
    expect(isConnectClassFailure(Object.assign(new Error('net'), { code: 'ENETUNREACH' }))).toBe(
      true
    );
    const aborted = new Error('The operation was aborted.');
    (aborted as Error & { reason: Error }).reason = new Error('connect-timeout');
    expect(isConnectClassFailure(aborted)).toBe(true);
    expect(isConnectClassFailure(new Error('TLS handshake failed'))).toBe(false);
    expect(isConnectClassFailure(new Error('Expected 101 status but got 200'))).toBe(false);
    expect(isConnectClassFailure(new Error('auth-timeout'))).toBe(false);
    expect(isConnectClassFailure(dnsErr())).toBe(false);
  });

  test('Bun Failed to connect / TimeoutError / AbortError shapes', async () => {
    const failed = new Error(
      "WebSocket connection to 'wss://hub.example/uplink' failed: Failed to connect"
    );
    expect(isConnectClassFailure(failed)).toBe(true);
    expect(isDnsClassFailure(failed)).toBe(true);

    const timeout = AbortSignal.timeout(1);
    await Bun.sleep(20);
    expect((timeout.reason as DOMException).name).toBe('TimeoutError');
    expect(isConnectClassFailure(timeout.reason)).toBe(true);

    const plain = new AbortController();
    plain.abort();
    expect((plain.signal.reason as DOMException).name).toBe('AbortError');
    expect(isConnectClassFailure(plain.signal.reason)).toBe(false);

    const timed = new AbortController();
    timed.abort(new Error('connect-timeout'));
    expect(isConnectClassFailure(timed.signal.reason)).toBe(true);
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

  test('system fake-IP is returned as via=system with fake; DoH is not called yet', async () => {
    const result = await resolveDialHost('hub.example', {
      lookup: async () => ['198.18.32.196', '10.0.0.1', '100.64.1.2'],
      doh: async () => {
        throw new Error('doh should not run');
      },
    });
    expect(result).toEqual({ ip: '198.18.32.196', via: 'system', fake: true });
  });

  test('preferDoh after a fake system answer returns the real IP and caches it', async () => {
    let now = 1_000;
    let lookups = 0;
    let dohs = 0;
    const opts = {
      lookup: async () => {
        lookups += 1;
        return ['198.18.0.180'];
      },
      doh: async () => {
        dohs += 1;
        return ['9.9.9.9'];
      },
      now: () => now,
    };
    expect(await resolveDialHost('hub.example', opts)).toEqual({
      ip: '198.18.0.180',
      via: 'system',
      fake: true,
    });
    expect(await resolveDialHost('hub.example', { ...opts, preferDoh: true })).toEqual({
      ip: '9.9.9.9',
      via: 'doh',
    });
    expect(lookups).toBe(1);
    expect(dohs).toBe(1);
    expect(await resolveDialHost('hub.example', opts)).toEqual({ ip: '9.9.9.9', via: 'doh' });
    expect(lookups).toBe(1);
    expect(dohs).toBe(1);
    now += DIAL_RESOLVE_TTL_MS + 1;
    expect(await resolveDialHost('hub.example', opts)).toEqual({
      ip: '198.18.0.180',
      via: 'system',
      fake: true,
    });
    expect(lookups).toBe(2);
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
    expect(resolved).toBeGreaterThanOrEqual(1);
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

const FAKE_IP = '198.18.0.180';
const REAL_IP = '9.9.9.9';

function connectTimeout(): Error {
  return new Error('connect-timeout');
}

function resolveFakeThenDoh(opts?: { now?: () => number; doh?: () => Promise<string[]> }): {
  resolve: typeof resolveDialHost;
  lookups: { n: number };
  dohs: { n: number };
} {
  const lookups = { n: 0 };
  const dohs = { n: 0 };
  const lookup = async () => {
    lookups.n += 1;
    return [FAKE_IP];
  };
  const doh = async () => {
    dohs.n += 1;
    return opts?.doh ? await opts.doh() : [REAL_IP];
  };
  return {
    lookups,
    dohs,
    resolve: (host, resolveOpts) =>
      resolveDialHost(host, { lookup, doh, now: opts?.now, ...resolveOpts }),
  };
}

describe('createDialWsFactory fake-IP redial', () => {
  test('system fake-IP + connect-timeout redials via DoH and then prefers DoH', async () => {
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((msg: unknown) => {
      lines.push(String(msg));
    });
    const { resolve, lookups, dohs } = resolveFakeThenDoh();
    const calls: string[] = [];
    const factory = createDialWsFactory(null, {
      raceCount: 1,
      enabled: true,
      resolve,
      fetchImpl: async () => new Response(null, { status: 200 }),
      wsCtor: (url) => {
        calls.push(url);
        const ws = new FakeSocket();
        if (url.includes(REAL_IP)) ws.open();
        else ws.fail(connectTimeout());
        return ws as never;
      },
    });
    try {
      await factory('wss://hub.example/uplink');
      expect(calls).toEqual(['wss://hub.example/uplink', `wss://${REAL_IP}/uplink`]);
      expect(dohs.n).toBe(1);
      const redial = lines.filter((line) => line.includes('fake-ip redial'));
      expect(redial).toHaveLength(1);
      expect(redial[0]).toContain('host=hub.example');
      expect(redial[0]).toContain(`fake=${FAKE_IP}`);
      expect(redial[0]).toContain(`real=${REAL_IP}`);
      expect(redial[0]).toContain('via=doh');
      expect(redial[0]).toContain('reason=connect-timeout');

      calls.length = 0;
      await factory('wss://hub.example/uplink');
      expect(calls).toEqual([`wss://${REAL_IP}/uplink`]);
      expect(lookups.n).toBe(1);
      expect(dohs.n).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  test('system fake-IP + connect OK does not call DoH', async () => {
    const { resolve, dohs } = resolveFakeThenDoh();
    const calls: string[] = [];
    const factory = createDialWsFactory(null, {
      raceCount: 1,
      enabled: true,
      resolve,
      wsCtor: (url) => {
        calls.push(url);
        const ws = new FakeSocket();
        ws.open();
        return ws as never;
      },
    });
    await factory('wss://hub.example/uplink');
    expect(calls).toEqual(['wss://hub.example/uplink']);
    expect(dohs.n).toBe(0);
  });

  test('system real IP + connect-timeout does not redial via DoH', async () => {
    let dohs = 0;
    const calls: string[] = [];
    const factory = createDialWsFactory(null, {
      raceCount: 1,
      enabled: true,
      resolve: (host, opts) =>
        resolveDialHost(host, {
          lookup: async () => ['8.8.8.8'],
          doh: async () => {
            dohs += 1;
            return [REAL_IP];
          },
          ...opts,
        }),
      wsCtor: (url) => {
        calls.push(url);
        const ws = new FakeSocket();
        ws.fail(connectTimeout());
        return ws as never;
      },
    });
    await expect(factory('wss://hub.example/uplink')).rejects.toBeDefined();
    expect(calls).toEqual(['wss://hub.example/uplink']);
    expect(dohs).toBe(0);
  });

  test('DoH disabled leaves fake-IP connect-timeout unchanged', async () => {
    const { resolve, dohs } = resolveFakeThenDoh();
    const calls: string[] = [];
    const factory = createDialWsFactory(null, {
      raceCount: 1,
      enabled: false,
      resolve,
      wsCtor: (url) => {
        calls.push(url);
        const ws = new FakeSocket();
        ws.fail(connectTimeout());
        return ws as never;
      },
    });
    await expect(factory('wss://hub.example/uplink')).rejects.toBeDefined();
    expect(calls).toEqual(['wss://hub.example/uplink']);
    expect(dohs.n).toBe(0);
  });

  test('later DoH IP failure falls back to the system hostname', async () => {
    const { resolve } = resolveFakeThenDoh();
    let realOpen = true;
    const calls: string[] = [];
    const factory = createDialWsFactory(null, {
      raceCount: 1,
      enabled: true,
      resolve,
      fetchImpl: async () => new Response(null, { status: 200 }),
      wsCtor: (url) => {
        calls.push(url);
        const ws = new FakeSocket();
        if (url.includes(REAL_IP)) {
          if (realOpen) ws.open();
          else ws.fail(connectTimeout());
        } else if (realOpen) ws.fail(connectTimeout());
        else ws.open();
        return ws as never;
      },
    });
    await factory('wss://hub.example/uplink');
    realOpen = false;
    calls.length = 0;
    await factory('wss://hub.example/uplink');
    expect(calls).toEqual([`wss://${REAL_IP}/uplink`, 'wss://hub.example/uplink']);
  });

  test('Bun Failed to connect on fake-IP redials via DoH', async () => {
    const { resolve, dohs } = resolveFakeThenDoh();
    const calls: string[] = [];
    const factory = createDialWsFactory(null, {
      raceCount: 1,
      enabled: true,
      resolve,
      fetchImpl: async () => new Response(null, { status: 200 }),
      wsCtor: (url) => {
        calls.push(url);
        const ws = new FakeSocket();
        if (url.includes(REAL_IP)) ws.open();
        else {
          ws.fail(
            new Error(
              "WebSocket connection to 'wss://hub.example/uplink' failed: Failed to connect"
            )
          );
        }
        return ws as never;
      },
    });
    await factory('wss://hub.example/uplink');
    expect(calls).toEqual(['wss://hub.example/uplink', `wss://${REAL_IP}/uplink`]);
    expect(dohs.n).toBe(1);
  });

  test('fake-IP hang uses a short budget then redials DoH within ~3s', async () => {
    const { resolve, dohs } = resolveFakeThenDoh();
    const calls: string[] = [];
    const factory = createDialWsFactory(null, {
      raceCount: 1,
      enabled: true,
      resolve,
      fetchImpl: async () => new Response(null, { status: 200 }),
      wsCtor: (url) => {
        calls.push(url);
        const ws = new FakeSocket();
        if (url.includes(REAL_IP)) ws.open();
        return ws as never;
      },
    });
    const parent = new AbortController();
    const t0 = Date.now();
    await factory('wss://hub.example/uplink', { signal: parent.signal, timeoutMs: 20_000 });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(6_000);
    expect(ms).toBeGreaterThan(2_000);
    expect(calls).toEqual(['wss://hub.example/uplink', `wss://${REAL_IP}/uplink`]);
    expect(dohs.n).toBe(1);
    expect(parent.signal.aborted).toBe(false);
  }, 10_000);

  test('real IP hang keeps the full budget and does not call DoH', async () => {
    let dohs = 0;
    const factory = createDialWsFactory(null, {
      raceCount: 1,
      enabled: true,
      resolve: (host, opts) =>
        resolveDialHost(host, {
          lookup: async () => ['8.8.8.8'],
          doh: async () => {
            dohs += 1;
            return [REAL_IP];
          },
          ...opts,
        }),
      wsCtor: () => new FakeSocket() as never,
    });
    const t0 = Date.now();
    await expect(factory('wss://hub.example/uplink', { timeoutMs: 180 })).rejects.toBeDefined();
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThan(140);
    expect(ms).toBeLessThan(800);
    expect(dohs).toBe(0);
  });

  test('DoH connect failure cools down without a second fake-ip redial log', async () => {
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((msg: unknown) => {
      lines.push(String(msg));
    });
    const { resolve, dohs } = resolveFakeThenDoh();
    let realOpen = true;
    const calls: string[] = [];
    const factory = createDialWsFactory(null, {
      raceCount: 1,
      enabled: true,
      resolve,
      fetchImpl: async () => new Response(null, { status: 200 }),
      wsCtor: (url) => {
        calls.push(url);
        const ws = new FakeSocket();
        if (url.includes(REAL_IP)) {
          if (realOpen) ws.open();
          else ws.fail(connectTimeout());
        } else ws.fail(connectTimeout());
        return ws as never;
      },
    });
    try {
      await factory('wss://hub.example/uplink');
      expect(dohs.n).toBe(1);
      expect(lines.filter((line) => line.includes('fake-ip redial'))).toHaveLength(1);
      realOpen = false;
      calls.length = 0;
      await expect(factory('wss://hub.example/uplink')).rejects.toBeDefined();
      expect(dohs.n).toBe(1);
      expect(calls).toEqual([`wss://${REAL_IP}/uplink`, 'wss://hub.example/uplink']);
      expect(lines.filter((line) => line.includes('fake-ip redial'))).toHaveLength(1);
      calls.length = 0;
      await expect(factory('wss://hub.example/uplink')).rejects.toBeDefined();
      expect(dohs.n).toBe(1);
      expect(calls).toEqual(['wss://hub.example/uplink']);
      expect(lines.filter((line) => line.includes('fake-ip redial'))).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  test('TLS handshake failed on a fake-IP answer does not redial', async () => {
    const { resolve, dohs } = resolveFakeThenDoh();
    const calls: string[] = [];
    const factory = createDialWsFactory(null, {
      raceCount: 1,
      enabled: true,
      resolve,
      wsCtor: (url) => {
        calls.push(url);
        const ws = new FakeSocket();
        ws.fail(new Error('TLS handshake failed'));
        return ws as never;
      },
    });
    await expect(factory('wss://hub.example/uplink')).rejects.toBeDefined();
    expect(calls).toEqual(['wss://hub.example/uplink']);
    expect(dohs.n).toBe(0);
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

  test('system fake-IP + connect-timeout redials via DoH and then prefers DoH', async () => {
    const { resolve, lookups, dohs } = resolveFakeThenDoh();
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (!url.includes(REAL_IP)) throw connectTimeout();
      return new Response(null, { status: 200 });
    };
    const opts = { enabled: true, resolve, fetchImpl };
    expect((await fetchWithDnsFallback('https://hub.example/healthz', {}, opts)).ok).toBe(true);
    expect(calls).toEqual(['https://hub.example/healthz', `https://${REAL_IP}/healthz`]);
    expect(dohs.n).toBe(1);
    calls.length = 0;
    expect((await fetchWithDnsFallback('https://hub.example/healthz', {}, opts)).ok).toBe(true);
    expect(calls).toEqual([`https://${REAL_IP}/healthz`]);
    expect(lookups.n).toBe(1);
    expect(dohs.n).toBe(1);
  });

  test('system fake-IP + connect OK does not call DoH', async () => {
    const { resolve, dohs } = resolveFakeThenDoh();
    const calls: string[] = [];
    await fetchWithDnsFallback(
      'https://hub.example/healthz',
      {},
      {
        enabled: true,
        resolve,
        fetchImpl: async (url) => {
          calls.push(url);
          return new Response(null, { status: 200 });
        },
      }
    );
    expect(calls).toEqual(['https://hub.example/healthz']);
    expect(dohs.n).toBe(0);
  });

  test('system real IP + connect-timeout does not redial via DoH', async () => {
    let dohs = 0;
    let n = 0;
    await expect(
      fetchWithDnsFallback(
        'https://hub.example/healthz',
        {},
        {
          enabled: true,
          resolve: (host, opts) =>
            resolveDialHost(host, {
              lookup: async () => ['8.8.8.8'],
              doh: async () => {
                dohs += 1;
                return [REAL_IP];
              },
              ...opts,
            }),
          fetchImpl: async () => {
            n += 1;
            throw connectTimeout();
          },
        }
      )
    ).rejects.toThrow('connect-timeout');
    expect(n).toBe(1);
    expect(dohs).toBe(0);
  });

  test('DoH disabled leaves fake-IP connect-timeout unchanged', async () => {
    const { resolve, dohs } = resolveFakeThenDoh();
    let n = 0;
    await expect(
      fetchWithDnsFallback(
        'https://hub.example/healthz',
        {},
        {
          enabled: false,
          resolve,
          fetchImpl: async () => {
            n += 1;
            throw connectTimeout();
          },
        }
      )
    ).rejects.toThrow('connect-timeout');
    expect(n).toBe(1);
    expect(dohs.n).toBe(0);
  });

  test('fake-IP fetch hang uses a short budget then redials DoH within ~3s', async () => {
    const { resolve, dohs } = resolveFakeThenDoh();
    const calls: string[] = [];
    const parent = new AbortController();
    const t0 = Date.now();
    const res = await fetchWithDnsFallback(
      'https://hub.example/healthz',
      { signal: parent.signal },
      {
        enabled: true,
        resolve,
        timeoutMs: 20_000,
        fetchImpl: async (url, init) => {
          calls.push(url);
          if (url.includes(REAL_IP)) return new Response(null, { status: 200 });
          await new Promise<never>((_, reject) => {
            const signal = init?.signal;
            const fail = () => reject(signal?.reason ?? new Error('hung'));
            if (signal?.aborted) fail();
            else signal?.addEventListener('abort', fail, { once: true });
          });
          return new Response(null, { status: 200 });
        },
      }
    );
    const ms = Date.now() - t0;
    expect(res.ok).toBe(true);
    expect(ms).toBeLessThan(6_000);
    expect(ms).toBeGreaterThan(2_000);
    expect(calls).toEqual(['https://hub.example/healthz', `https://${REAL_IP}/healthz`]);
    expect(dohs.n).toBe(1);
    expect(parent.signal.aborted).toBe(false);
  }, 10_000);

  test('fetch TimeoutError on fake-IP redials via DoH', async () => {
    const { resolve, dohs } = resolveFakeThenDoh();
    const calls: string[] = [];
    const timeout = AbortSignal.timeout(1);
    await Bun.sleep(20);
    expect((timeout.reason as DOMException).name).toBe('TimeoutError');
    const res = await fetchWithDnsFallback(
      'https://hub.example/healthz',
      {},
      {
        enabled: true,
        resolve,
        fetchImpl: async (url) => {
          calls.push(url);
          if (!url.includes(REAL_IP)) throw timeout.reason;
          return new Response(null, { status: 200 });
        },
      }
    );
    expect(res.ok).toBe(true);
    expect(calls).toEqual(['https://hub.example/healthz', `https://${REAL_IP}/healthz`]);
    expect(dohs.n).toBe(1);
  });

  test('plain AbortError on fake-IP does not redial', async () => {
    const { resolve, dohs } = resolveFakeThenDoh();
    const ac = new AbortController();
    ac.abort();
    expect((ac.signal.reason as DOMException).name).toBe('AbortError');
    let n = 0;
    await expect(
      fetchWithDnsFallback(
        'https://hub.example/healthz',
        {},
        {
          enabled: true,
          resolve,
          fetchImpl: async () => {
            n += 1;
            throw ac.signal.reason;
          },
        }
      )
    ).rejects.toBeDefined();
    expect(n).toBe(1);
    expect(dohs.n).toBe(0);
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
    let lookups = 0;
    const lookup = async () => {
      lookups += 1;
      return ['9.9.9.9'];
    };
    const doh = async () => {
      throw new Error('doh should not run');
    };
    const result = await resolveDialHost('hub.example', {
      signal: ac.signal,
      lookup,
      doh,
    });
    expect(result).toBeNull();
    expect(lookups).toBe(0);
    expect(await resolveDialHost('hub.example', { lookup, doh })).toEqual({
      ip: '9.9.9.9',
      via: 'system',
    });
    expect(lookups).toBe(1);
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
