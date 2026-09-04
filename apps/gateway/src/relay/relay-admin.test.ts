import { afterEach, describe, expect, test } from 'bun:test';
import { ensureRelayAdminToken } from './relay-admin-auth';
import { RelayConfigStore } from './relay-config-store';
import { sha256Hex } from './relay-password';
import { RELAY_TEST_ADMIN_TOKEN, type RelayHarness, bootRelayHarness } from './relay-test-harness';

let harness: RelayHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function boot(opts?: Parameters<typeof bootRelayHarness>[0]): Promise<RelayHarness> {
  harness = await bootRelayHarness(opts);
  return harness;
}

type StatusBody = {
  config: {
    hasPassword: boolean;
    passwordEpoch: number;
    minTokenEpoch: number;
    defaultQuota: { maxNodes: number; maxStreams: number; bandwidthBytesPerSec: number | null };
  };
  tenants: Array<{
    id: string;
    label: string | null;
    createdAt: number;
    lastSeenAt: number | null;
    nodes: number;
    nodesRevoked: number;
    nodesOnline: number;
    streams: number;
    bytesIn: number;
    bytesOut: number;
    quota: { maxNodes: number } | null;
    tokenEpoch: number;
    kicked: boolean;
  }>;
  totals: {
    tenants: number;
    nodes: number;
    nodesOnline: number;
    streams: number;
    bytesIn: number;
    bytesOut: number;
  };
};

describe('relay admin auth', () => {
  test('rejects a missing or wrong bearer token with 401', async () => {
    const relay = await boot();
    expect((await relay.fetch('/api/relay/status')).status).toBe(401);
    const wrong = await relay.fetch('/api/relay/status', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_UNAUTHORIZED'
    );
  });

  test('accepts the x-tmex-relay-admin-token header too', async () => {
    const relay = await boot();
    const res = await relay.fetch('/api/relay/status', {
      headers: { 'x-tmex-relay-admin-token': RELAY_TEST_ADMIN_TOKEN },
    });
    expect(res.status).toBe(200);
  });

  test('accepts an injected local node session when the bearer token is absent', async () => {
    const relay = await boot({
      isLocalUserAuthenticated: (req) => req.headers.get('x-local-session') === 'yes',
    });
    expect(
      (await relay.fetch('/api/relay/status', { headers: { 'x-local-session': 'yes' } })).status
    ).toBe(200);
    expect((await relay.fetch('/api/relay/status')).status).toBe(401);
  });

  test('generates and stores an admin token hash when the env token is absent', async () => {
    const relay = await boot();
    const store = new RelayConfigStore(relay.db);
    store.setAdminTokenHash(null, relay.now());
    const patched: Record<string, string>[] = [];
    const generated = await ensureRelayAdminToken({
      configuredToken: null,
      store,
      now: () => relay.now(),
      patchEnv: async (patch) => {
        patched.push(patch);
      },
      log: () => {},
    });
    expect(generated).not.toBeNull();
    expect(patched[0]?.TMEX_RELAY_ADMIN_TOKEN).toBe(generated ?? '');
    expect(store.read()?.adminTokenHash).toBe(sha256Hex(generated ?? ''));
    const second = await ensureRelayAdminToken({
      configuredToken: null,
      store,
      now: () => relay.now(),
      log: () => {},
    });
    expect(second).toBeNull();
  });
});

describe('relay admin status', () => {
  test('reports config, tenants and totals with live counters merged in', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    await client.inbox.takeOf('auth.ok');
    relay.runtime.metering.record(tenant.id, { bytesIn: 40, bytesOut: 2 });
    const res = await relay.adminFetch('/api/relay/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatusBody;
    expect(body.config).toEqual({
      hasPassword: false,
      passwordEpoch: 0,
      minTokenEpoch: 0,
      defaultQuota: { maxNodes: 16, maxStreams: 64, bandwidthBytesPerSec: null },
    });
    expect(body.tenants).toHaveLength(1);
    const row = body.tenants[0];
    expect(row?.id).toBe(tenant.id);
    expect(row?.label).toBeNull();
    expect(row?.quota).toBeNull();
    expect(row?.nodes).toBe(1);
    expect(row?.nodesRevoked).toBe(0);
    expect(row?.nodesOnline).toBe(1);
    expect(row?.bytesIn).toBe(40);
    expect(row?.bytesOut).toBe(2);
    expect(row?.kicked).toBe(false);
    expect(typeof row?.createdAt).toBe('number');
    expect(body.totals).toEqual({
      tenants: 1,
      nodes: 1,
      nodesOnline: 1,
      streams: 0,
      bytesIn: 40,
      bytesOut: 2,
    });
  });

  test('counts revoked nodes separately instead of leaving them in the tenant total', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const a = tenant.addNode();
    const b = tenant.addNode();
    const clientA = await tenant.connect(a);
    await clientA.inbox.takeOf('auth.ok');
    const clientB = await tenant.connect(b);
    await clientB.inbox.takeOf('auth.ok');
    const before = (await (await relay.adminFetch('/api/relay/status')).json()) as StatusBody;
    expect(before.tenants[0]?.nodes).toBe(2);
    expect(before.tenants[0]?.nodesRevoked).toBe(0);

    await tenant.appendMember(clientA, 'revoke', tenant.revokeRecord(b.nodeId));
    await clientB.inbox.takeOf('relay.kicked');

    const after = (await (await relay.adminFetch('/api/relay/status')).json()) as StatusBody;
    // 吊销过的节点不再挂在「已知节点」里（否则运营者永远看到「1 / 2」），只作独立计数。
    expect(after.tenants[0]?.nodes).toBe(1);
    expect(after.tenants[0]?.nodesRevoked).toBe(1);
  });

  test('flushes pending usage into the tenant row on stop', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    relay.runtime.metering.record(tenant.id, { bytesIn: 7, bytesOut: 9 });
    relay.runtime.metering.flush();
    const row = relay.runtime.tenants.get(tenant.id);
    expect(row?.bytesIn).toBe(7);
    expect(row?.bytesOut).toBe(9);
    expect(relay.runtime.metering.pendingFor(tenant.id)).toEqual({ bytesIn: 0, bytesOut: 0 });
  });
});

describe('relay admin mutations', () => {
  test('updates the default quota and pushes it to inheriting tenants', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    await client.inbox.takeOf('relay.quota');
    const res = await relay.adminFetch('/api/relay/config', {
      method: 'PATCH',
      body: JSON.stringify({
        defaultQuota: { maxNodes: 3, maxStreams: 9, bandwidthBytesPerSec: 2048 },
      }),
    });
    expect(res.status).toBe(200);
    const quota = await client.inbox.takeOf('relay.quota');
    expect(quota.t === 'relay.quota' && quota.maxNodes).toBe(3);
    expect(quota.t === 'relay.quota' && quota.bandwidthBytesPerSec).toBe(2048);
  });

  test('rejects a malformed quota with RELAY_BAD_QUOTA', async () => {
    const relay = await boot();
    const res = await relay.adminFetch('/api/relay/config', {
      method: 'PATCH',
      body: JSON.stringify({ defaultQuota: { maxNodes: 0, maxStreams: 9 } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('RELAY_BAD_QUOTA');
  });

  test('sets and clears a tenant quota and label', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    await relay.adminFetch(`/api/relay/tenants/${tenant.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        quota: { maxNodes: 2, maxStreams: 3, bandwidthBytesPerSec: null },
        label: '  home  ',
      }),
    });
    let body = (await (await relay.adminFetch('/api/relay/status')).json()) as StatusBody;
    expect(body.tenants[0]?.quota?.maxNodes).toBe(2);
    expect(body.tenants[0]?.label).toBe('home');
    await relay.adminFetch(`/api/relay/tenants/${tenant.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ quota: null, label: null }),
    });
    body = (await (await relay.adminFetch('/api/relay/status')).json()) as StatusBody;
    expect(body.tenants[0]?.quota).toBeNull();
    expect(body.tenants[0]?.label).toBeNull();
  });

  test('404s for an unknown tenant and 405s for a wrong method', async () => {
    const relay = await boot();
    const missing = await relay.adminFetch('/api/relay/tenants/deadbeef', {
      method: 'PATCH',
      body: '{}',
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_TENANT_NOT_FOUND'
    );
    const wrongMethod = await relay.adminFetch('/api/relay/status', { method: 'POST' });
    expect(wrongMethod.status).toBe(405);
  });

  test('deletes a tenant with its key log', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const first = await tenant.connect(node);
    await first.inbox.takeOf('auth.ok');
    const client = await tenant.connect(node);
    await client.inbox.takeOf('auth.ok');
    expect(relay.runtime.registry.reconnectsOf(tenant.id, node.nodeId)).toBe(1);
    relay.runtime.metering.record(tenant.id, { bytesIn: 11, bytesOut: 22 });
    client.send({
      t: 'relay.keylog.append',
      id: 'one',
      seq: 1,
      blob: { v: 1, n: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' },
    });
    await client.inbox.takeOf('relay.keylog.ack');
    const res = await relay.adminFetch(`/api/relay/tenants/${tenant.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(relay.runtime.tenants.get(tenant.id)).toBeNull();
    expect(relay.runtime.keyLog.head(tenant.id)).toBe(0n);
    expect(relay.runtime.registry.reconnectsOf(tenant.id, node.nodeId)).toBe(0);
    expect(relay.runtime.metering.liveTenantSnapshot(tenant.id)).toEqual({
      bytesIn: 0,
      bytesOut: 0,
    });
    relay.runtime.registry.forgetTenant(tenant.id);
    relay.runtime.metering.forgetTenant(tenant.id);
    const body = (await (await relay.adminFetch('/api/relay/status')).json()) as StatusBody;
    expect(body.tenants).toHaveLength(0);
  });

  test('password rotation bumps the epoch and reports hasPassword', async () => {
    const relay = await boot();
    const res = await relay.adminFetch('/api/relay/password', {
      method: 'POST',
      body: JSON.stringify({ password: 'first-secret', mode: 'keep' }),
    });
    expect(res.status).toBe(200);
    let body = (await (await relay.adminFetch('/api/relay/status')).json()) as StatusBody;
    expect(body.config.hasPassword).toBe(true);
    expect(body.config.passwordEpoch).toBe(1);
    expect(body.config.minTokenEpoch).toBe(0);
    await relay.adminFetch('/api/relay/password', {
      method: 'POST',
      body: JSON.stringify({ password: null, mode: 'kick' }),
    });
    body = (await (await relay.adminFetch('/api/relay/status')).json()) as StatusBody;
    expect(body.config.hasPassword).toBe(false);
    expect(body.config.passwordEpoch).toBe(2);
    expect(body.config.minTokenEpoch).toBe(2);
  });

  test('rejects a password shorter than 8 characters when non-empty', async () => {
    const relay = await boot();
    const res = await relay.adminFetch('/api/relay/password', {
      method: 'POST',
      body: JSON.stringify({ password: 'short', mode: 'keep' }),
    });
    expect(res.status).toBe(400);
  });

  test('rejects a password body without a mode', async () => {
    const relay = await boot();
    const res = await relay.adminFetch('/api/relay/password', {
      method: 'POST',
      body: JSON.stringify({ password: 'x' }),
    });
    expect(res.status).toBe(400);
  });
});
