import { afterEach, describe, expect, test } from 'bun:test';
import { MESH_VIA_SELF, setMeshRequestContext } from '../mesh/mesh-deps';
import { defaultRelayLimits, relayStartupWarnings } from './relay-limits';
import { RELAY_TEST_PUBLIC_URL, type RelayHarness, bootRelayHarness } from './relay-test-harness';
import { RELAY_PREAUTH_PER_IP } from './relay-uplink-preauth';

let harness: RelayHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('RelayRuntime.snapshotForLocalStatus', () => {
  test('returns publicUrl, password flag, tenant and node counts without secrets', async () => {
    harness = await bootRelayHarness({ password: 'admit-pass' });
    const empty = harness.runtime.snapshotForLocalStatus();
    expect(empty).toEqual({
      publicUrl: RELAY_TEST_PUBLIC_URL,
      hasPassword: true,
      tenantCount: 0,
      nodesOnline: 0,
      currentNodes: 0,
      turn: {
        enabled: false,
        source: 'off',
        url: null,
        port: null,
        externalIp: null,
        listening: false,
        allocations: 0,
        maxAlloc: null,
        error: null,
        relayPortRange: null,
      },
    });
    expect(JSON.stringify(empty)).not.toContain('admit-pass');

    const tenant = await harness.createTenant({ password: 'admit-pass' });
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    await client.inbox.takeOf('auth.ok');

    const live = harness.runtime.snapshotForLocalStatus();
    expect(live.tenantCount).toBe(1);
    expect(live.nodesOnline).toBe(1);
    expect(live.currentNodes).toBe(1);
    expect(live.hasPassword).toBe(true);
    expect(live.publicUrl).toBe(RELAY_TEST_PUBLIC_URL);
  });
});

describe('RelayRuntime uplink pre-auth reservation', () => {
  function uplinkReq(socket: string, headers?: Record<string, string>): Request {
    const req = new Request(`${RELAY_TEST_PUBLIC_URL}/relay/uplink`, { headers });
    setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: socket, trustProxy: false });
    return req;
  }

  function recordingServer(upgraded: unknown[]) {
    return {
      upgrade: (_req: Request, opts?: { data?: unknown }) => {
        upgraded.push(opts?.data);
        return true;
      },
    };
  }

  test('reserves a pre-auth slot per client before upgrading and refuses beyond the cap', async () => {
    harness = await bootRelayHarness({ password: 'admit-pass' });
    const upgraded: unknown[] = [];
    const server = recordingServer(upgraded);
    const results: Array<Response | undefined> = [];
    for (let i = 0; i <= RELAY_PREAUTH_PER_IP; i++) {
      results.push(await harness.runtime.handleRequest(uplinkReq('203.0.113.10'), server as never));
    }
    expect(results.slice(0, RELAY_PREAUTH_PER_IP).every((r) => r === undefined)).toBe(true);
    expect(results[RELAY_PREAUTH_PER_IP]?.status).toBe(429);
    expect(upgraded).toHaveLength(RELAY_PREAUTH_PER_IP);
    expect((upgraded[0] as { preauthKey?: string }).preauthKey).toBe('203.0.113.10');
    const other = await harness.runtime.handleRequest(uplinkReq('198.51.100.8'), server as never);
    expect(other).toBeUndefined();
  });

  test('uplinks from an untrusted proxy socket or an unknown client only count globally', async () => {
    harness = await bootRelayHarness({ password: 'admit-pass' });
    const upgraded: unknown[] = [];
    const server = recordingServer(upgraded);
    for (let i = 0; i < RELAY_PREAUTH_PER_IP * 2; i++) {
      const proxied = uplinkReq('127.0.0.1', { 'x-forwarded-for': '198.51.100.7' });
      expect(await harness.runtime.handleRequest(proxied, server as never)).toBeUndefined();
      const unknown = new Request(`${RELAY_TEST_PUBLIC_URL}/relay/uplink`);
      expect(await harness.runtime.handleRequest(unknown, server as never)).toBeUndefined();
    }
    expect((upgraded[0] as { preauthKey?: string | null }).preauthKey).toBeNull();
  });

  test('a failed upgrade releases its reservation', async () => {
    harness = await bootRelayHarness({ password: 'admit-pass' });
    const failing = { upgrade: () => false };
    for (let i = 0; i < RELAY_PREAUTH_PER_IP + 2; i++) {
      const res = await harness.runtime.handleRequest(uplinkReq('203.0.113.10'), failing as never);
      expect(res?.status).toBe(426);
    }
  });
});

describe('relayStartupWarnings', () => {
  const base = { hasPassword: true, defaultMaxTenants: 50 };

  test('warns when existing tenants exceed the default limit and no max_tenants is set', () => {
    const lines = relayStartupWarnings({
      ...base,
      limits: { ...defaultRelayLimits(), maxTenants: null },
      tenantCount: 51,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('51 tenants exceed the default tenant limit 50');
  });

  test('stays quiet at the default limit or when max_tenants is explicit', () => {
    expect(
      relayStartupWarnings({ ...base, limits: defaultRelayLimits(), tenantCount: 50 })
    ).toEqual([]);
    expect(
      relayStartupWarnings({
        ...base,
        limits: { ...defaultRelayLimits(), maxTenants: 10 },
        tenantCount: 80,
      })
    ).toEqual([]);
  });

  test('still warns about a missing relay access password', () => {
    const lines = relayStartupWarnings({
      ...base,
      hasPassword: false,
      limits: defaultRelayLimits(),
      tenantCount: 0,
    });
    expect(lines[0]).toContain('no relay access password is set');
  });
});
