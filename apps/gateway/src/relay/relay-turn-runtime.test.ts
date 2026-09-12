import { afterEach, describe, expect, test } from 'bun:test';
import { type RelayHarness, bootRelayHarness } from './relay-test-harness';
import type { TurnServer } from './turn';

let harness: RelayHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function fakeTurnServer(): TurnServer {
  let listening = false;
  let externalIp = '203.0.113.9';
  return {
    start: async () => {
      listening = true;
      return { port: 3478 };
    },
    stop: async () => {
      listening = false;
    },
    snapshot: () => ({
      listening,
      port: 3478,
      bindHost: '127.0.0.1',
      externalIp,
      allocations: 2,
      permissions: 0,
      channels: 0,
      bytesRelayedIn: 0,
      bytesRelayedOut: 0,
      authFailures: 0,
      deniedPeers: 0,
      bindingRequests: 0,
      startedAt: listening ? 1 : null,
    }),
    setExternalIp: (ip: string) => {
      externalIp = ip;
    },
  };
}

describe('relay runtime TURN wiring', () => {
  test('GET /api/relay/status and local snapshot include the turn block', async () => {
    harness = await bootRelayHarness({
      config: {
        turnPort: 3478,
        turnExternalIp: '203.0.113.9',
        turnHost: 'relay.example',
      },
      turnDeps: { createServer: () => fakeTurnServer() },
    });
    const snap = harness.runtime.snapshotForLocalStatus();
    expect(snap.turn).toMatchObject({
      enabled: true,
      source: 'builtin',
      url: 'turn:relay.example:3478?transport=udp',
      listening: true,
      allocations: 2,
    });
    const res = await harness.adminFetch('/api/relay/status');
    const body = (await res.json()) as {
      turn: { source: string; url: string; allocations: number };
    };
    expect(body.turn.source).toBe('builtin');
    expect(body.turn.url).toBe('turn:relay.example:3478?transport=udp');
    expect(body.turn.allocations).toBe(2);
  });

  test('auth.ok / relay.list carry builtin turn before the first member list', async () => {
    harness = await bootRelayHarness({
      config: {
        turnPort: 3478,
        turnExternalIp: '203.0.113.9',
        turnHost: 'relay.example',
      },
      turnDeps: { createServer: () => fakeTurnServer() },
    });
    const tenant = await harness.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    const ok = await client.inbox.takeOf('auth.ok');
    expect(ok.t === 'auth.ok' && ok.rtc.turn).toEqual({
      url: 'turn:relay.example:3478?transport=udp',
      username: expect.stringMatching(/^vt-/),
      credential: expect.any(String),
    });
    await client.inbox.takeOf('relay.quota');
    const list = await client.inbox.takeOf('relay.list');
    expect(list.t === 'relay.list' && list.rtc.turn?.url).toBe(
      'turn:relay.example:3478?transport=udp'
    );
  });

  test('builtin without TURN_HOST advertises turn:<ipv4> in status and auth.ok', async () => {
    harness = await bootRelayHarness({
      config: {
        turnPort: 3478,
        turnExternalIp: '203.0.113.9',
      },
      turnDeps: { createServer: () => fakeTurnServer() },
    });
    expect(harness.runtime.snapshotForLocalStatus().turn).toMatchObject({
      enabled: true,
      source: 'builtin',
      url: 'turn:203.0.113.9:3478?transport=udp',
      externalIp: '203.0.113.9',
    });
    const tenant = await harness.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    const ok = await client.inbox.takeOf('auth.ok');
    expect(ok.t === 'auth.ok' && ok.rtc.turn?.url).toBe('turn:203.0.113.9:3478?transport=udp');
  });
});
