import { afterEach, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { createRelayTurnService } from './relay-turn-service';
import type { TurnServer, TurnServerOptions, TurnServerStats } from './turn';
import type { RelayRuntimeConfig } from './types';

const dbs: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function baseConfig(over: Partial<RelayRuntimeConfig> = {}): RelayRuntimeConfig {
  return {
    publicUrl: 'https://relay.example',
    stun: [],
    turnPort: 3478,
    turnExternalIp: '203.0.113.9',
    turnHost: 'relay.example',
    turnRelayPortRange: { begin: 49160, end: 49259 },
    peerPort: 39001,
    ...over,
  };
}

function fakeStats(over: Partial<TurnServerStats> = {}): TurnServerStats {
  return {
    listening: true,
    port: 3478,
    bindHost: '127.0.0.1',
    externalIp: '203.0.113.9',
    allocations: 0,
    permissions: 0,
    channels: 0,
    bytesRelayedIn: 0,
    bytesRelayedOut: 0,
    authFailures: 0,
    deniedPeers: 0,
    bindingRequests: 0,
    startedAt: 1,
    ...over,
  };
}

function fakeServer(
  over: Partial<TurnServer> = {},
  stats: Partial<TurnServerStats> = {}
): TurnServer {
  let current = fakeStats(stats);
  return {
    start: async () => {
      current = { ...current, listening: true };
      return { port: current.port };
    },
    stop: async () => {
      current = { ...current, listening: false, allocations: 0 };
    },
    snapshot: () => ({ ...current }),
    setExternalIp: (ip: string) => {
      current = { ...current, externalIp: ip };
    },
    ...over,
  };
}

describe('RelayTurnService mode', () => {
  test('external triple does not start a server', async () => {
    const handle = createMigratedAuthDb();
    dbs.push(handle);
    let created = 0;
    const logs: string[] = [];
    const svc = createRelayTurnService({
      db: handle.db,
      config: baseConfig({
        turn: { url: 'turn:ext.example:3478', username: 'u', credential: 'p' },
      }),
      log: (line) => logs.push(line),
      createServer: () => {
        created += 1;
        return fakeServer();
      },
    });
    await svc.start();
    expect(created).toBe(0);
    expect(svc.advertisement()).toEqual({
      url: 'turn:ext.example:3478',
      username: 'u',
      credential: 'p',
    });
    expect(svc.status()).toMatchObject({ source: 'external', enabled: true, listening: false });
    await svc.stop();
  });

  test('port 0 stays off', async () => {
    const handle = createMigratedAuthDb();
    dbs.push(handle);
    const logs: string[] = [];
    const svc = createRelayTurnService({
      db: handle.db,
      config: baseConfig({ turnPort: 0 }),
      log: (line) => logs.push(line),
    });
    await svc.start();
    expect(svc.advertisement()).toBeNull();
    expect(svc.status().source).toBe('off');
    expect(logs.some((line) => line.includes('builtin turn disabled reason=port disabled'))).toBe(
      true
    );
    await svc.stop();
  });
});

describe('RelayTurnService builtin', () => {
  test('starts before advertising turn: url and persists credentials', async () => {
    const handle = createMigratedAuthDb();
    dbs.push(handle);
    const logs: string[] = [];
    let captured: TurnServerOptions | undefined;
    const svc = createRelayTurnService({
      db: handle.db,
      config: baseConfig(),
      log: (line) => logs.push(line),
      createServer: (opts) => {
        captured = opts;
        return fakeServer({}, { bindHost: opts.listenHost ?? 'auto' });
      },
    });
    await svc.start();
    const adv = svc.advertisement();
    expect(adv?.url).toBe('turn:relay.example:3478?transport=udp');
    expect(svc.status().url).toBe('turn:relay.example:3478?transport=udp');
    expect(adv?.username.startsWith('vt-')).toBe(true);
    expect(captured?.listenHost).toBe('auto');
    expect(svc.status()).toMatchObject({
      enabled: true,
      source: 'builtin',
      listening: true,
      port: 3478,
      bindHost: 'auto',
      externalIp: '203.0.113.9',
      relayPortRange: '49160-49259',
      error: null,
    });
    expect(logs.some((line) => line.includes('[relay][turn] builtin turn listening'))).toBe(true);
    expect(logs.some((line) => line.includes('bind=auto'))).toBe(true);
    const again = createRelayTurnService({
      db: handle.db,
      config: baseConfig(),
      createServer: () => fakeServer(),
    });
    await again.start();
    expect(again.advertisement()?.username).toBe(adv?.username);
    expect(again.advertisement()?.credential).toBe(adv?.credential);
    await svc.stop();
    await again.stop();
  });

  test('refuses builtin when ports overlap the RTC range', async () => {
    const handle = createMigratedAuthDb();
    dbs.push(handle);
    const logs: string[] = [];
    const svc = createRelayTurnService({
      db: handle.db,
      config: baseConfig({ rtcPortRange: { begin: 3470, end: 3480 } }),
      log: (line) => logs.push(line),
      createServer: () => fakeServer(),
    });
    await svc.start();
    expect(svc.advertisement()).toBeNull();
    expect(svc.status().error).toContain('VIBETERM_RTC_PORT_RANGE');
    expect(logs.some((line) => line.includes('builtin turn disabled reason='))).toBe(true);
    await svc.stop();
  });

  test('keeps turn null when external IP cannot be resolved', async () => {
    const handle = createMigratedAuthDb();
    dbs.push(handle);
    const svc = createRelayTurnService({
      db: handle.db,
      config: baseConfig({ turnExternalIp: null }),
      resolveHost: async () => null,
      probeStun: async () => ({ ok: false }),
      stunServers: ['stun:example:3478'],
      createServer: () => fakeServer(),
    });
    await svc.start();
    expect(svc.advertisement()).toBeNull();
    expect(svc.status()).toMatchObject({ source: 'builtin', enabled: false, listening: false });
    expect(svc.status().error).toContain('unable to resolve TURN external IPv4');
    await svc.stop();
  });

  test('retries EADDRINUSE with 5s→60s backoff then advertises', async () => {
    const handle = createMigratedAuthDb();
    dbs.push(handle);
    const sleeps: number[] = [];
    let attempts = 0;
    const inUse = Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    const svc = createRelayTurnService({
      db: handle.db,
      config: baseConfig(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      createServer: () =>
        fakeServer({
          start: async () => {
            attempts += 1;
            if (attempts === 1) throw inUse;
            return { port: 3478 };
          },
        }),
    });
    await svc.start();
    await Bun.sleep(20);
    expect(attempts).toBeGreaterThan(1);
    expect(sleeps[0]).toBe(5_000);
    expect(svc.advertisement()?.url).toBe('turn:relay.example:3478?transport=udp');
    expect(svc.status().error).toBeNull();
    await svc.stop();
  });

  test('refresh starts the server once an external IP becomes available', async () => {
    const handle = createMigratedAuthDb();
    dbs.push(handle);
    let ip: string | null = null;
    const created: TurnServerOptions[] = [];
    const svc = createRelayTurnService({
      db: handle.db,
      config: baseConfig({ turnExternalIp: null, turnHost: null }),
      refreshIntervalMs: 15,
      resolveHost: async () => ip,
      probeStun: async () => ({ ok: false }),
      stunServers: ['stun:example:3478'],
      createServer: (opts) => {
        created.push(opts);
        return fakeServer({}, { externalIp: opts.externalIp, port: opts.listenPort });
      },
    });
    await svc.start();
    expect(svc.advertisement()).toBeNull();
    expect(created).toHaveLength(0);
    ip = '203.0.113.9';
    await Bun.sleep(50);
    expect(created).toHaveLength(1);
    expect(svc.advertisement()?.url).toBe('turn:203.0.113.9:3478?transport=udp');
    expect(svc.status().listening).toBe(true);
    await svc.stop();
  });

  test('passes a literal turnBindHost through as listenHost', async () => {
    const handle = createMigratedAuthDb();
    dbs.push(handle);
    const logs: string[] = [];
    let captured: TurnServerOptions | undefined;
    const svc = createRelayTurnService({
      db: handle.db,
      config: baseConfig({ turnBindHost: '10.0.0.3' }),
      log: (line) => logs.push(line),
      createServer: (opts) => {
        captured = opts;
        return fakeServer({}, { bindHost: opts.listenHost ?? 'auto' });
      },
    });
    await svc.start();
    expect(captured?.listenHost).toBe('10.0.0.3');
    expect(svc.status().bindHost).toBe('10.0.0.3');
    expect(logs.some((line) => line.includes('bind=10.0.0.3'))).toBe(true);
    await svc.stop();
  });

  test('without TURN_HOST advertises the resolved IPv4 literal', async () => {
    const handle = createMigratedAuthDb();
    dbs.push(handle);
    const svc = createRelayTurnService({
      db: handle.db,
      config: baseConfig({ turnHost: null }),
      createServer: () => fakeServer(),
    });
    await svc.start();
    expect(svc.advertisement()?.url).toBe('turn:203.0.113.9:3478?transport=udp');
    expect(svc.status().url).toBe('turn:203.0.113.9:3478?transport=udp');
    await svc.stop();
  });

  test('IP change calls setExternalIp and does not re-bind', async () => {
    const handle = createMigratedAuthDb();
    dbs.push(handle);
    const created: TurnServerOptions[] = [];
    const setIps: string[] = [];
    let stops = 0;
    let ip = '203.0.113.9';
    const svc = createRelayTurnService({
      db: handle.db,
      config: baseConfig({ turnExternalIp: null, turnHost: 'relay.example' }),
      refreshIntervalMs: 15,
      resolveHost: async () => ip,
      createServer: (opts) => {
        created.push(opts);
        const server = fakeServer({}, { externalIp: opts.externalIp, port: opts.listenPort });
        const stop = server.stop;
        const setExternalIp = server.setExternalIp;
        server.stop = async () => {
          stops += 1;
          await stop();
        };
        server.setExternalIp = (next) => {
          setIps.push(next);
          setExternalIp(next);
        };
        return server;
      },
    });
    await svc.start();
    expect(svc.advertisement()?.url).toBe('turn:relay.example:3478?transport=udp');
    ip = '203.0.113.10';
    await Bun.sleep(50);
    expect(created).toHaveLength(1);
    expect(stops).toBe(0);
    expect(setIps).toContain('203.0.113.10');
    expect(svc.status().externalIp).toBe('203.0.113.10');
    expect(svc.advertisement()?.url).toBe('turn:relay.example:3478?transport=udp');
    await svc.stop();
  });

  test('IP change without TURN_HOST re-advertises the new IPv4 URL', async () => {
    const handle = createMigratedAuthDb();
    dbs.push(handle);
    const created: TurnServerOptions[] = [];
    let ip = '203.0.113.9';
    const ads: string[] = [];
    const svc = createRelayTurnService({
      db: handle.db,
      config: baseConfig({ turnExternalIp: null, turnHost: null }),
      refreshIntervalMs: 15,
      resolveHost: async () => ip,
      onAdvertisementChange: () => {
        const url = svc.advertisement()?.url;
        if (url) ads.push(url);
      },
      createServer: (opts) => {
        created.push(opts);
        return fakeServer({}, { externalIp: opts.externalIp, port: opts.listenPort });
      },
    });
    await svc.start();
    expect(svc.advertisement()?.url).toBe('turn:203.0.113.9:3478?transport=udp');
    ip = '203.0.113.10';
    await Bun.sleep(50);
    expect(created).toHaveLength(1);
    expect(svc.advertisement()?.url).toBe('turn:203.0.113.10:3478?transport=udp');
    expect(svc.status()).toMatchObject({
      url: 'turn:203.0.113.10:3478?transport=udp',
      externalIp: '203.0.113.10',
      listening: true,
    });
    expect(ads).toContain('turn:203.0.113.10:3478?transport=udp');
    await svc.stop();
  });
});
