import { afterEach, describe, expect, test } from 'bun:test';
import type { LinkSession } from '@tmex/shared/link';
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

type StubCounters = {
  framesIn: number;
  framesOut: number;
  bytesIn: number;
  bytesOut: number;
};

function stubLink(counters: StubCounters): LinkSession {
  return {
    openStream: () => Promise.reject(new Error('stub')),
    onStream() {},
    ctl: { send() {}, onMessage() {} },
    close() {},
    closed: new Promise(() => {}),
    stats() {
      return {
        framesIn: counters.framesIn,
        framesOut: counters.framesOut,
        bytesIn: counters.bytesIn,
        bytesOut: counters.bytesOut,
        openStreams: 0,
        unacked: 0,
      };
    },
  } as LinkSession;
}

function putStub(
  registry: RelayRegistry,
  opts: { tenantId: string; nodeId: string; counters: StubCounters }
): LinkSession {
  const link = stubLink(opts.counters);
  registry.put({
    tenantId: opts.tenantId,
    nodeId: opts.nodeId,
    link,
    tokenEpoch: 1,
    tokenHash: 'hash',
    protoVersion: 1,
    clientVersion: '1.1.23',
    connectedAt: 1,
  });
  return link;
}

function seedTenant(tenants: RelayTenantStore, now: number, id = 'aa'.repeat(16)): string {
  tenants.create({
    id,
    rootPublicKey: new Uint8Array(32),
    rootEpoch: 0,
    tokenHash: 'bb'.repeat(32),
    tokenEpoch: 0,
    now,
  });
  return id;
}

function seedNode(tenants: RelayTenantStore, tenantId: string, nodeId: string, now: number): void {
  tenants.upsertNode({
    tenantId,
    nodeId,
    edPk: new Uint8Array(32),
    x25519Pk: new Uint8Array(32),
    status: 'admitted',
    now,
  });
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

  test('链路在两次采样之间关闭时，frames 速率仍计入已下线链路的增量', () => {
    const fx = fakeCollector();
    try {
      const aCounters = { framesIn: 1000, framesOut: 100, bytesIn: 0, bytesOut: 0 };
      const bCounters = { framesIn: 1000, framesOut: 100, bytesIn: 0, bytesOut: 0 };
      const linkA = putStub(fx.registry, { tenantId: 't', nodeId: 'a', counters: aCounters });
      putStub(fx.registry, { tenantId: 't', nodeId: 'b', counters: bCounters });
      fx.collector.start();
      aCounters.framesIn = 1500;
      aCounters.framesOut = 160;
      bCounters.framesIn = 1500;
      bCounters.framesOut = 160;
      fx.registry.removeLink(linkA);
      fx.clock.now += 5_000;
      fx.tick();
      const snap = fx.collector.snapshot();
      expect(snap.totals.framesInPerSec).toBe(200);
      expect(snap.totals.framesOutPerSec).toBe(24);
    } finally {
      fx.collector.stop();
      fx.close();
    }
  });

  test('链路在两次采样之间被替换时，旧链路计数折入 retired', () => {
    const fx = fakeCollector();
    try {
      const oldCounters = { framesIn: 100, framesOut: 10, bytesIn: 0, bytesOut: 0 };
      putStub(fx.registry, { tenantId: 't', nodeId: 'n', counters: oldCounters });
      fx.collector.start();
      oldCounters.framesIn = 250;
      oldCounters.framesOut = 40;
      const nextCounters = { framesIn: 40, framesOut: 5, bytesIn: 0, bytesOut: 0 };
      putStub(fx.registry, { tenantId: 't', nodeId: 'n', counters: nextCounters });
      fx.clock.now += 5_000;
      fx.tick();
      const snap = fx.collector.snapshot();
      expect(snap.totals.framesInPerSec).toBe(38);
      expect(snap.totals.framesOutPerSec).toBe(7);
    } finally {
      fx.collector.stop();
      fx.close();
    }
  });

  test('新租户第一个采样窗口按 prev=0 计算速率', () => {
    const fx = fakeCollector();
    try {
      fx.collector.start();
      const tenantId = seedTenant(fx.tenants, fx.clock.now);
      fx.metering.record(tenantId, { bytesIn: 10_000, bytesOut: 5_000 });
      fx.clock.now += 5_000;
      fx.tick();
      const tenant = fx.collector.snapshot().tenants.find((row) => row.id === tenantId);
      expect(tenant?.bytesInPerSec).toBe(2_000);
      expect(tenant?.bytesOutPerSec).toBe(1_000);
    } finally {
      fx.collector.stop();
      fx.close();
    }
  });

  test('新成员第一个采样窗口按 prev=0 计算速率', () => {
    const fx = fakeCollector();
    try {
      const tenantId = seedTenant(fx.tenants, fx.clock.now);
      fx.collector.start();
      seedNode(fx.tenants, tenantId, 'node-1', fx.clock.now);
      fx.metering.recordMember(tenantId, 'node-1', { bytesIn: 10_000, bytesOut: 5_000 });
      fx.clock.now += 5_000;
      fx.tick();
      const member = fx.collector.snapshot().members.find((row) => row.nodeId === 'node-1');
      expect(member?.bytesInPerSec).toBe(2_000);
      expect(member?.bytesOutPerSec).toBe(1_000);
    } finally {
      fx.collector.stop();
      fx.close();
    }
  });

  test('成员计数器回绕时按从 0 起的新值计算速率', () => {
    const fx = fakeCollector();
    try {
      const tenantId = seedTenant(fx.tenants, fx.clock.now);
      seedNode(fx.tenants, tenantId, 'node-1', fx.clock.now);
      fx.metering.recordMember(tenantId, 'node-1', { bytesIn: 10_000, bytesOut: 8_000 });
      fx.collector.start();
      fx.metering.forgetMember(tenantId, 'node-1');
      fx.metering.recordMember(tenantId, 'node-1', { bytesIn: 400, bytesOut: 200 });
      fx.clock.now += 5_000;
      fx.tick();
      const member = fx.collector.snapshot().members.find((row) => row.nodeId === 'node-1');
      expect(member?.bytesInPerSec).toBe(80);
      expect(member?.bytesOutPerSec).toBe(40);
    } finally {
      fx.collector.stop();
      fx.close();
    }
  });

  test('forgetMember / forgetTenant 幂等，关闭回调再记账后可再清', () => {
    const fx = fakeCollector();
    try {
      const tenantId = seedTenant(fx.tenants, fx.clock.now);
      fx.metering.record(tenantId, { bytesIn: 10, bytesOut: 20 });
      fx.metering.recordMember(tenantId, 'n1', { bytesIn: 7, bytesOut: 3 });
      fx.metering.forgetMember(tenantId, 'n1');
      fx.metering.forgetMember(tenantId, 'n1');
      expect(fx.metering.liveMemberSnapshot(tenantId, 'n1')).toEqual({ bytesIn: 0, bytesOut: 0 });
      fx.metering.recordMember(tenantId, 'n1', { bytesIn: 1 });
      fx.metering.forgetMember(tenantId, 'n1');
      expect(fx.metering.liveMemberSnapshot(tenantId, 'n1')).toEqual({ bytesIn: 0, bytesOut: 0 });
      fx.metering.forgetTenant(tenantId);
      fx.metering.forgetTenant(tenantId);
      expect(fx.metering.liveTenantSnapshot(tenantId)).toEqual({ bytesIn: 0, bytesOut: 0 });
      expect(fx.metering.pendingFor(tenantId)).toEqual({ bytesIn: 0, bytesOut: 0 });
    } finally {
      fx.close();
    }
  });

  test('tenants.quota 为生效配额，并带 usage / 令牌桶速率', () => {
    const fx = fakeCollector();
    try {
      const tenantId = seedTenant(fx.tenants, fx.clock.now);
      seedNode(fx.tenants, tenantId, 'node-1', fx.clock.now);
      fx.collector.start();
      fx.metering.record(tenantId, { bytesIn: 10_000, bytesOut: 5_000 });
      fx.metering.recordAdmitted(tenantId, 8_000);
      fx.clock.now += 5_000;
      fx.tick();
      const snap = fx.collector.snapshot();
      const tenant = snap.tenants.find((row) => row.id === tenantId);
      expect(tenant?.quota).toEqual({
        maxNodes: 16,
        maxStreams: 64,
        bandwidthBytesPerSec: null,
      });
      expect(tenant?.usage).toEqual({
        currentNodes: 1,
        currentStreams: 0,
        bytesInPerSec: 2_000,
        bytesOutPerSec: 1_000,
        bandwidthBytesPerSec: 1_600,
      });
      expect(snap.totals.bandwidthBytesPerSec).toBe(1_600);
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
      totals: { members: number; membersOnline: number; bandwidthBytesPerSec: number };
      tenants: Array<{
        quota: { maxNodes: number; maxStreams: number; bandwidthBytesPerSec: number | null };
        usage: { currentNodes: number; currentStreams: number; bandwidthBytesPerSec: number };
      }>;
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
    expect(body.totals.bandwidthBytesPerSec).toBe(0);
    expect(body.tenants[0]?.quota).toEqual({
      maxNodes: 16,
      maxStreams: 64,
      bandwidthBytesPerSec: null,
    });
    expect(body.tenants[0]?.usage).toMatchObject({
      currentNodes: 1,
      currentStreams: 0,
      bandwidthBytesPerSec: 0,
    });
    const member = body.members.find((row) => row.nodeId === node.nodeId);
    expect(member?.online).toBe(true);
    expect(member?.reconnects).toBe(1);
    expect(typeof member?.connectedAt).toBe('number');
    expect(member?.name).toBeNull();
  });
});
