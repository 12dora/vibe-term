import { loadavg } from 'node:os';
import type { LinkSession } from '@tmex/shared/link';
import { gatewayEventLoopLag } from '../ws/event-loop-lag';
import type { RelayMetering, RelayUsageDelta } from './relay-metering';
import { type RelayLiveNode, type RelayRegistry, memberKey } from './relay-registry';
import type { RelayTenantStore } from './relay-tenant-store';
import { RELAY_METRICS_HISTORY_LIMIT, RELAY_METRICS_INTERVAL_MS } from './types';

export type RelayMetricsProcess = {
  memory: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
  };
  cpu: { utilizationPct: number | null };
  loadAvg: [number, number, number] | null;
  eventLoop: { lagMs: number; maxLagMs: number };
  openSockets: number;
  authenticatedLinks: number;
};

export type RelayMetricsTotals = {
  tenants: number;
  members: number;
  membersOnline: number;
  activeStreams: number;
  bytesIn: number;
  bytesOut: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  framesInPerSec: number;
  framesOutPerSec: number;
};

export type RelayMetricsTenant = {
  id: string;
  label: string | null;
  memberCount: number;
  onlineMembers: number;
  activeStreams: number;
  bytesIn: number;
  bytesOut: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  lastSeenAt: number | null;
  pack: { sizeBytes: number; updatedAt: number | null };
  quota: {
    maxNodes: number;
    maxStreams: number;
    bandwidthBytesPerSec: number | null;
  } | null;
};

export type RelayMetricsMember = {
  tenantId: string;
  nodeId: string;
  name: string | null;
  online: boolean;
  lastSeenAt: number | null;
  connectedAt: number | null;
  rttMs: number | null;
  reconnects: number;
  activeStreams: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
};

export type RelayMetricsSample = {
  sampledAt: number;
  membersOnline: number;
  activeStreams: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  framesInPerSec: number;
  framesOutPerSec: number;
  rssBytes: number;
  heapUsedBytes: number;
  eventLoopLagMs: number;
  cpuUtilizationPct: number | null;
};

/**
 * `GET /api/relay/metrics` 响应。
 * `bytesIn` = 从成员收到的字节，`bytesOut` = 发给成员的字节；
 * 同一份中转字节在租户 in/out 上各记一次（与 `RelayMetering` 落库口径一致）。
 */
export type RelayMetricsResponse = {
  schemaVersion: 1;
  sampledAt: number;
  intervalMs: number;
  uptimeMs: number;
  version: string;
  process: RelayMetricsProcess;
  totals: RelayMetricsTotals;
  tenants: RelayMetricsTenant[];
  members: RelayMetricsMember[];
  history: { intervalMs: number; samples: RelayMetricsSample[] };
};

export type RelayMetricsCollectorOptions = {
  tenants: RelayTenantStore;
  registry: RelayRegistry;
  metering: RelayMetering;
  openSockets: () => number;
  now: () => number;
  startedAt: number;
  version: string;
  intervalMs?: number;
  historyLimit?: number;
  memoryUsage?: () => NodeJS.MemoryUsage;
  cpuUsage?: () => NodeJS.CpuUsage;
  loadAvg?: () => number[];
  eventLoop?: () => { lagMs: number; maxLagMs: number };
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
};

type MuxCounters = {
  framesIn: number;
  framesOut: number;
  bytesIn: number;
  bytesOut: number;
  openStreams: number;
  unacked: number;
};

type LiveCounters = {
  bytesIn: number;
  bytesOut: number;
  framesIn: number;
  framesOut: number;
  membersOnline: number;
  activeStreams: number;
  tenantBytes: Map<string, RelayUsageDelta>;
  memberBytes: Map<string, RelayUsageDelta>;
};

type RateSnapshot = {
  bytesInPerSec: number;
  bytesOutPerSec: number;
  framesInPerSec: number;
  framesOutPerSec: number;
  tenants: Map<string, { bytesInPerSec: number; bytesOutPerSec: number }>;
  members: Map<string, { bytesInPerSec: number; bytesOutPerSec: number }>;
  cpuUtilizationPct: number | null;
};

const EMPTY_MUX: MuxCounters = {
  framesIn: 0,
  framesOut: 0,
  bytesIn: 0,
  bytesOut: 0,
  openStreams: 0,
  unacked: 0,
};

const EMPTY_RATES: RateSnapshot = {
  bytesInPerSec: 0,
  bytesOutPerSec: 0,
  framesInPerSec: 0,
  framesOutPerSec: 0,
  tenants: new Map(),
  members: new Map(),
  cpuUtilizationPct: null,
};

function perSec(delta: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return Math.max(0, delta) / (elapsedMs / 1000);
}

function cpuUtilizationPct(
  prev: NodeJS.CpuUsage,
  next: NodeJS.CpuUsage,
  elapsedMs: number
): number | null {
  if (elapsedMs <= 0) return null;
  const micros = Math.max(0, next.user - prev.user) + Math.max(0, next.system - prev.system);
  return (micros / (elapsedMs * 1000)) * 100;
}

function asLoadAvg(values: number[]): [number, number, number] | null {
  if (values.length < 3) return null;
  const a = values[0] ?? 0;
  const b = values[1] ?? 0;
  const c = values[2] ?? 0;
  if (a === 0 && b === 0 && c === 0) return null;
  return [a, b, c];
}

function muxStatsOf(link: LinkSession): MuxCounters {
  const direct = (link as { stats?: () => MuxCounters }).stats;
  if (typeof direct === 'function') return direct.call(link);
  const inner = (link as { mux?: { stats?: () => MuxCounters } }).mux;
  if (inner && typeof inner.stats === 'function') return inner.stats();
  return EMPTY_MUX;
}

function aggregateMux(registry: RelayRegistry): MuxCounters {
  const total = { ...EMPTY_MUX };
  for (const live of registry.all()) {
    const stats = muxStatsOf(live.link);
    total.framesIn += stats.framesIn;
    total.framesOut += stats.framesOut;
    total.bytesIn += stats.bytesIn;
    total.bytesOut += stats.bytesOut;
    total.openStreams += stats.openStreams;
    total.unacked += stats.unacked;
  }
  return total;
}

function rateMap(
  current: Map<string, RelayUsageDelta>,
  previous: Map<string, RelayUsageDelta>,
  elapsedMs: number
): Map<string, { bytesInPerSec: number; bytesOutPerSec: number }> {
  const out = new Map<string, { bytesInPerSec: number; bytesOutPerSec: number }>();
  for (const [key, curr] of current) {
    const prev = previous.get(key) ?? curr;
    out.set(key, {
      bytesInPerSec: perSec(curr.bytesIn - prev.bytesIn, elapsedMs),
      bytesOutPerSec: perSec(curr.bytesOut - prev.bytesOut, elapsedMs),
    });
  }
  return out;
}

export class RelayMetricsCollector {
  private readonly tenants: RelayTenantStore;
  private readonly registry: RelayRegistry;
  private readonly metering: RelayMetering;
  private readonly openSockets: () => number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly version: string;
  readonly intervalMs: number;
  private readonly historyLimit: number;
  private readonly memoryUsage: () => NodeJS.MemoryUsage;
  private readonly cpuUsage: () => NodeJS.CpuUsage;
  private readonly loadAvg: () => number[];
  private readonly eventLoop: () => { lagMs: number; maxLagMs: number };
  private readonly setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (id: ReturnType<typeof setInterval>) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private prevAt = 0;
  private prevCpu: NodeJS.CpuUsage | null = null;
  private prevLive: LiveCounters | null = null;
  private rates: RateSnapshot = EMPTY_RATES;
  private readonly samples: RelayMetricsSample[] = [];

  constructor(opts: RelayMetricsCollectorOptions) {
    this.tenants = opts.tenants;
    this.registry = opts.registry;
    this.metering = opts.metering;
    this.openSockets = opts.openSockets;
    this.now = opts.now;
    this.startedAt = opts.startedAt;
    this.version = opts.version;
    this.intervalMs = opts.intervalMs ?? RELAY_METRICS_INTERVAL_MS;
    this.historyLimit = opts.historyLimit ?? RELAY_METRICS_HISTORY_LIMIT;
    this.memoryUsage = opts.memoryUsage ?? (() => process.memoryUsage());
    this.cpuUsage = opts.cpuUsage ?? (() => process.cpuUsage());
    this.loadAvg = opts.loadAvg ?? (() => loadavg());
    this.eventLoop = opts.eventLoop ?? (() => gatewayEventLoopLag().snapshot());
    this.setIntervalFn = opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((id) => clearInterval(id));
  }

  start(): void {
    if (this.timer !== null || this.intervalMs <= 0) return;
    this.captureBaseline();
    const timer = this.setIntervalFn(() => {
      this.sample();
    }, this.intervalMs);
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer === null) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  sample(): RelayMetricsSample {
    const at = this.now();
    const live = this.readLive();
    const elapsedMs = this.prevAt > 0 ? at - this.prevAt : 0;
    const cpu = this.cpuUsage();
    const cpuPct =
      this.prevCpu && elapsedMs > 0 ? cpuUtilizationPct(this.prevCpu, cpu, elapsedMs) : null;
    const prev = this.prevLive;
    this.rates = {
      bytesInPerSec: perSec(live.bytesIn - (prev?.bytesIn ?? live.bytesIn), elapsedMs),
      bytesOutPerSec: perSec(live.bytesOut - (prev?.bytesOut ?? live.bytesOut), elapsedMs),
      framesInPerSec: perSec(live.framesIn - (prev?.framesIn ?? live.framesIn), elapsedMs),
      framesOutPerSec: perSec(live.framesOut - (prev?.framesOut ?? live.framesOut), elapsedMs),
      tenants: rateMap(live.tenantBytes, prev?.tenantBytes ?? live.tenantBytes, elapsedMs),
      members: rateMap(live.memberBytes, prev?.memberBytes ?? live.memberBytes, elapsedMs),
      cpuUtilizationPct: cpuPct,
    };
    this.prevAt = at;
    this.prevCpu = cpu;
    this.prevLive = live;
    const mem = this.memoryUsage();
    const sample: RelayMetricsSample = {
      sampledAt: at,
      membersOnline: live.membersOnline,
      activeStreams: live.activeStreams,
      bytesInPerSec: this.rates.bytesInPerSec,
      bytesOutPerSec: this.rates.bytesOutPerSec,
      framesInPerSec: this.rates.framesInPerSec,
      framesOutPerSec: this.rates.framesOutPerSec,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      eventLoopLagMs: this.eventLoop().lagMs,
      cpuUtilizationPct: cpuPct,
    };
    this.samples.push(sample);
    while (this.samples.length > this.historyLimit) this.samples.shift();
    return sample;
  }

  snapshot(): RelayMetricsResponse {
    const sampledAt = this.now();
    return {
      schemaVersion: 1,
      sampledAt,
      intervalMs: this.intervalMs,
      uptimeMs: Math.max(0, sampledAt - this.startedAt),
      version: this.version,
      process: this.buildProcess(),
      totals: this.buildTotals(),
      tenants: this.buildTenants(),
      members: this.buildMembers(),
      history: { intervalMs: this.intervalMs, samples: this.samples.slice() },
    };
  }

  private captureBaseline(): void {
    this.prevAt = this.now();
    this.prevCpu = this.cpuUsage();
    this.prevLive = this.readLive();
  }

  private readLive(): LiveCounters {
    const mux = aggregateMux(this.registry);
    const live = this.metering.liveTotalsSnapshot();
    const tenantBytes = new Map<string, RelayUsageDelta>();
    const memberBytes = new Map<string, RelayUsageDelta>();
    let activeStreams = 0;
    for (const tenant of this.tenants.list()) {
      tenantBytes.set(tenant.id, this.metering.liveTenantSnapshot(tenant.id));
      activeStreams += this.registry.streamCount(tenant.id);
      for (const node of this.tenants.listNodes(tenant.id)) {
        memberBytes.set(
          memberKey(tenant.id, node.nodeId),
          this.metering.liveMemberSnapshot(tenant.id, node.nodeId)
        );
      }
    }
    for (const liveNode of this.registry.all()) {
      const key = memberKey(liveNode.tenantId, liveNode.nodeId);
      if (!memberBytes.has(key)) {
        memberBytes.set(key, this.metering.liveMemberSnapshot(liveNode.tenantId, liveNode.nodeId));
      }
    }
    return {
      bytesIn: live.bytesIn,
      bytesOut: live.bytesOut,
      framesIn: mux.framesIn,
      framesOut: mux.framesOut,
      membersOnline: this.registry.onlineCount(),
      activeStreams,
      tenantBytes,
      memberBytes,
    };
  }

  private buildProcess(): RelayMetricsProcess {
    const mem = this.memoryUsage();
    const lag = this.eventLoop();
    return {
      memory: {
        rssBytes: mem.rss,
        heapTotalBytes: mem.heapTotal,
        heapUsedBytes: mem.heapUsed,
        externalBytes: mem.external,
      },
      cpu: { utilizationPct: this.rates.cpuUtilizationPct },
      loadAvg: asLoadAvg(this.loadAvg()),
      eventLoop: { lagMs: lag.lagMs, maxLagMs: lag.maxLagMs },
      openSockets: this.openSockets(),
      authenticatedLinks: this.registry.onlineCount(),
    };
  }

  private buildTotals(): RelayMetricsTotals {
    let members = 0;
    let activeStreams = 0;
    let bytesIn = 0;
    let bytesOut = 0;
    for (const tenant of this.tenants.list()) {
      members += this.tenants.countActiveNodes(tenant.id);
      activeStreams += this.registry.streamCount(tenant.id);
      const pending = this.metering.pendingFor(tenant.id);
      bytesIn += tenant.bytesIn + pending.bytesIn;
      bytesOut += tenant.bytesOut + pending.bytesOut;
    }
    return {
      tenants: this.tenants.count(),
      members,
      membersOnline: this.registry.onlineCount(),
      activeStreams,
      bytesIn,
      bytesOut,
      bytesInPerSec: this.rates.bytesInPerSec,
      bytesOutPerSec: this.rates.bytesOutPerSec,
      framesInPerSec: this.rates.framesInPerSec,
      framesOutPerSec: this.rates.framesOutPerSec,
    };
  }

  private buildTenants(): RelayMetricsTenant[] {
    return this.tenants.list().map((tenant) => {
      const pending = this.metering.pendingFor(tenant.id);
      const tenantRates = this.rates.tenants.get(tenant.id);
      return {
        id: tenant.id,
        label: tenant.label,
        memberCount: this.tenants.countActiveNodes(tenant.id),
        onlineMembers: this.registry.listTenant(tenant.id).length,
        activeStreams: this.registry.streamCount(tenant.id),
        bytesIn: tenant.bytesIn + pending.bytesIn,
        bytesOut: tenant.bytesOut + pending.bytesOut,
        bytesInPerSec: tenantRates?.bytesInPerSec ?? 0,
        bytesOutPerSec: tenantRates?.bytesOutPerSec ?? 0,
        lastSeenAt: tenant.lastSeenAt,
        pack: {
          sizeBytes: tenant.sealedPack?.byteLength ?? 0,
          updatedAt: tenant.sealedPackUpdatedAt,
        },
        quota: tenant.quota,
      };
    });
  }

  private buildMembers(): RelayMetricsMember[] {
    const out: RelayMetricsMember[] = [];
    for (const tenant of this.tenants.list()) {
      const liveById = new Map<string, RelayLiveNode>();
      for (const live of this.registry.listTenant(tenant.id)) liveById.set(live.nodeId, live);
      const ids = new Set<string>();
      for (const node of this.tenants.listNodes(tenant.id)) {
        if (node.status === 'revoked') continue;
        ids.add(node.nodeId);
      }
      for (const live of liveById.values()) ids.add(live.nodeId);
      for (const nodeId of ids) {
        const node = this.tenants.getNode(tenant.id, nodeId);
        const live = liveById.get(nodeId);
        const rates = this.rates.members.get(memberKey(tenant.id, nodeId));
        out.push({
          tenantId: tenant.id,
          nodeId,
          name: null,
          online: Boolean(live),
          lastSeenAt: node?.lastSeenAt ?? null,
          connectedAt: live?.connectedAt ?? null,
          rttMs: live?.rttMs ?? null,
          reconnects: live?.reconnects ?? this.registry.reconnectsOf(tenant.id, nodeId),
          activeStreams: this.registry.memberStreamCount(tenant.id, nodeId),
          bytesInPerSec: rates?.bytesInPerSec ?? 0,
          bytesOutPerSec: rates?.bytesOutPerSec ?? 0,
        });
      }
    }
    return out;
  }
}
