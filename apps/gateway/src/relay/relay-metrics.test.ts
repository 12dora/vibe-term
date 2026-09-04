import { afterEach, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { RelayMetering } from './relay-metering';
import { RelayMetricsCollector } from './relay-metrics';
import { RelayRegistry } from './relay-registry';
import { RelayTenantStore } from './relay-tenant-store';
import { type RelayHarness, bootRelayHarness } from './relay-test-harness';

let harness: RelayHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function fakeCollector(opts?: {
  clock?: { now: number };
  cpu?: { user: number; system: number };
  loadAvg?: number[];
}) {
  const { db, close } = createMigratedAuthDb();
  const clock = opts?.clock ?? { now: 1_000 };
  const cpu = opts?.cpu ?? { user: 0, system: 0 };
  const tenants = new RelayTenantStore(db);
  const registry = new RelayRegistry();
  const metering = new RelayMetering(tenants, () => clock.now, 0);
  let tick: () => void = () => {};
  const collector = new RelayMetricsCollector({
    tenants,
    registry,
    metering,
    openSockets: () => 0,
    now: () => clock.now,
    startedAt: clock.now,
    version: 'test',
    intervalMs: 5_000,
    historyLimit: 60,
    memoryUsage: () => ({
      rss: 100,
      heapTotal: 80,
      heapUsed: 40,
      external: 8,
      arrayBuffers: 0,
    }),
    cpuUsage: () => ({ user: cpu.user, system: cpu.system }),
    loadAvg: () => opts?.loadAvg ?? [0.2, 0.1, 0.05],
    eventLoop: () => ({ lagMs: 3, maxLagMs: 9 }),
    setIntervalFn: (cb) => {
      tick = cb;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: () => {},
  });
  return { collector, metering, tenants, registry, clock, cpu, tick: () => tick(), close };
}

describe('RelayMetricsCollector', () => {
  test('按累计计数差计算速率，CPU 百分比，history 最多 60 条', () => {
    const fx = fakeCollector();
    try {
      fx.collector.start();
      fx.metering.record('ghost', { bytesIn: 10_000, bytesOut: 20_000 });
      fx.cpu.user = 1_000_000;
      fx.cpu.system = 1_000_000;
      fx.clock.now += 5_000;
      fx.tick();
      const snap = fx.collector.snapshot();
      expect(snap.totals.bytesInPerSec).toBe(2_000);
      expect(snap.totals.bytesOutPerSec).toBe(4_000);
      expect(snap.process.cpu.utilizationPct).toBe(40);
      expect(snap.history.samples.length).toBeGreaterThanOrEqual(1);
      expect(snap.process.loadAvg).toEqual([0.2, 0.1, 0.05]);
      expect(snap.process.eventLoop).toEqual({ lagMs: 3, maxLagMs: 9 });

      for (let i = 0; i < 70; i++) {
        fx.clock.now += 5_000;
        fx.collector.sample();
      }
      expect(fx.collector.snapshot().history.samples).toHaveLength(60);
    } finally {
      fx.collector.stop();
      fx.close();
    }
  });

  test('loadavg 全 0 时返回 null', () => {
    const fx = fakeCollector({ loadAvg: [0, 0, 0] });
    try {
      expect(fx.collector.snapshot().process.loadAvg).toBeNull();
    } finally {
      fx.close();
    }
  });

  test('putPack 写入 sealedPackUpdatedAt 并由 snapshot 暴露 size', () => {
    const fx = fakeCollector();
    try {
      const tenantId = 'aa'.repeat(16);
      fx.tenants.create({
        id: tenantId,
        rootPublicKey: new Uint8Array(32),
        rootEpoch: 0,
        tokenHash: 'bb'.repeat(32),
        tokenEpoch: 0,
        now: fx.clock.now,
      });
      const pack = new Uint8Array([1, 2, 3, 4]);
      expect(
        fx.tenants.putPack({
          tenantId,
          kdfParamsJson: '{}',
          sealedPack: pack,
          expectedRootEpoch: 0,
          headSeq: 0n,
          tokenHash: 'bb'.repeat(32),
          minTokenEpoch: 0,
          now: 9_999,
        })
      ).toBe('ok');
      const row = fx.tenants.get(tenantId);
      expect(row?.sealedPackUpdatedAt).toBe(9_999);
      expect(row?.sealedPack?.byteLength).toBe(4);
      const tenant = fx.collector.snapshot().tenants[0];
      expect(tenant?.pack).toEqual({ sizeBytes: 4, updatedAt: 9_999 });
    } finally {
      fx.close();
    }
  });
});

describe('GET /api/relay/metrics', () => {
  test('无鉴权 401，本机登录用户 200 且形状完整、不含密钥', async () => {
    harness = await bootRelayHarness({
      isLocalUserAuthenticated: (req) => req.headers.get('x-local-session') === 'yes',
    });
    expect((await harness.fetch('/api/relay/metrics')).status).toBe(401);
    const local = await harness.fetch('/api/relay/metrics', {
      headers: { 'x-local-session': 'yes' },
    });
    expect(local.status).toBe(200);
    const body = (await local.json()) as Record<string, unknown>;
    expect(body.schemaVersion).toBe(1);
    expect(typeof body.sampledAt).toBe('number');
    expect(body.intervalMs).toBe(5_000);
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.version).toBe('1.1.23');
    expect(body.process).toBeTruthy();
    expect(body.totals).toBeTruthy();
    expect(Array.isArray(body.tenants)).toBe(true);
    expect(Array.isArray(body.members)).toBe(true);
    expect(body.history).toBeTruthy();
    const text = JSON.stringify(body);
    expect(text).not.toContain('tokenHash');
    expect(text).not.toContain('token_hash');
    expect(text).not.toContain('sealedPack');
    expect(text).not.toContain('sealed_pack');
    expect(text).not.toContain('rootPublicKey');
    expect(text).not.toContain('kdfParams');

    const omitted = await harness.adminFetch('/api/relay/metrics?members=0');
    expect(omitted.status).toBe(200);
    const slim = (await omitted.json()) as Record<string, unknown>;
    expect(slim.members).toBeUndefined();
    expect(slim.schemaVersion).toBe(1);
  });

  test('在线成员出现在 members 里，重连计数随替换递增', async () => {
    harness = await bootRelayHarness();
    const tenant = await harness.createTenant();
    const node = tenant.addNode();
    const first = await tenant.connect(node);
    await first.inbox.takeOf('auth.ok');
    const second = await tenant.connect(node);
    await second.inbox.takeOf('auth.ok');
    const res = await harness.adminFetch('/api/relay/metrics');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { members: number; membersOnline: number };
      members: Array<{
        nodeId: string;
        online: boolean;
        reconnects: number;
        connectedAt: number | null;
        name: string | null;
      }>;
    };
    expect(body.totals.members).toBe(1);
    expect(body.totals.membersOnline).toBe(1);
    const member = body.members.find((row) => row.nodeId === node.nodeId);
    expect(member?.online).toBe(true);
    expect(member?.reconnects).toBe(1);
    expect(typeof member?.connectedAt).toBe('number');
    expect(member?.name).toBeNull();
  });
});
