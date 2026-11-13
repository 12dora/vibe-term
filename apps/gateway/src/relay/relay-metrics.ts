import { loadavg } from 'node:os';
import type { LinkSession } from '@vibeterm/shared/link';
import type {
  RelayMetricsMember,
  RelayMetricsProcess,
  RelayMetricsResponse,
  RelayMetricsSample,
  RelayMetricsTenant,
  RelayMetricsTotals,
  RelayQuota,
} from '@vibeterm/shared/relay';
import { gatewayEventLoopLag } from '../ws/event-loop-lag';
import { type RelayLimitTotals, defaultRelayLimits, relayLimitTotals } from './relay-limits';
import type { RelayMetering, RelayUsageDelta } from './relay-metering';
import {
  EMPTY_MUX,
  EMPTY_RATES,
  type LiveCounters,
  type MuxCounters,
  type RateSnapshot,
  type TenantByteRates,
  aggregateMux,
  asLoadAvg,
  counterDelta,
  cpuUtilizationPct,
  memberRateMap,
  muxStatsOf,
  perSec,
  rateMap,
} from './relay-metrics-rates';
import { defaultRelayQuota } from './relay-quota';
import { type RelayLiveNode, type RelayRegistry, memberKey } from './relay-registry';
import type { RelayTenantStore } from './relay-tenant-store';
import { RELAY_DEFAULT_MAX_TENANTS } from './types';
import { RELAY_METRICS_HISTORY_LIMIT, RELAY_METRICS_INTERVAL_MS } from './types';

export type {
  RelayMetricsMember,
  RelayMetricsProcess,
  RelayMetricsResponse,
  RelayMetricsSample,
  RelayMetricsTenant,
  RelayMetricsTotals,
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
  quotaFor?: (tenantId: string) => RelayQuota;
  /** 中继级限额的只读投影；缺省即「未配置任何限额」。 */
  limits?: () => RelayLimitTotals;
  onSample?: () => void;
};

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
  private readonly quotaFor: (tenantId: string) => RelayQuota;
  private readonly limitsFor: () => RelayLimitTotals;
  private readonly onSample: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private prevAt = 0;
  private prevCpu: NodeJS.CpuUsage | null = null;
  private prevLive: LiveCounters | null = null;
  private rates: RateSnapshot = EMPTY_RATES;
  private readonly samples: RelayMetricsSample[] = [];
  private readonly retired: MuxCounters = { ...EMPTY_MUX };

  constructor(opts: RelayMetricsCollectorOptions) {
    this.tenants = opts.tenants;
    this.registry = opts.registry;
    this.metering = opts.metering;
    this.registry.onLinkRemoved((live) => this.retireLink(live.link));
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
    this.quotaFor =
      opts.quotaFor ?? ((tenantId) => this.tenants.get(tenantId)?.quota ?? defaultRelayQuota());
    this.limitsFor =
      opts.limits ?? (() => relayLimitTotals(defaultRelayLimits(), RELAY_DEFAULT_MAX_TENANTS));
    this.onSample = opts.onSample;
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
      bytesInPerSec: perSec(counterDelta(live.bytesIn, prev?.bytesIn ?? 0), elapsedMs),
      bytesOutPerSec: perSec(counterDelta(live.bytesOut, prev?.bytesOut ?? 0), elapsedMs),
      framesInPerSec: perSec(counterDelta(live.framesIn, prev?.framesIn ?? 0), elapsedMs),
      framesOutPerSec: perSec(counterDelta(live.framesOut, prev?.framesOut ?? 0), elapsedMs),
      bandwidthBytesPerSec: perSec(counterDelta(live.admitted, prev?.admitted ?? 0), elapsedMs),
      tenants: rateMap(
        live.tenantBytes,
        prev?.tenantBytes ?? new Map(),
        live.tenantAdmitted,
        prev?.tenantAdmitted ?? new Map(),
        elapsedMs
      ),
      members: memberRateMap(live.memberBytes, prev?.memberBytes ?? new Map(), elapsedMs),
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
    try {
      this.onSample?.();
    } catch {
      /* 用量推送失败不能打断采样 */
    }
    return sample;
  }

  tenantRates(tenantId: string): TenantByteRates {
    return (
      this.rates.tenants.get(tenantId) ?? {
        bytesInPerSec: 0,
        bytesOutPerSec: 0,
        bandwidthBytesPerSec: 0,
      }
    );
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

  private retireLink(link: LinkSession): void {
    const stats = muxStatsOf(link);
    this.retired.framesIn += stats.framesIn;
    this.retired.framesOut += stats.framesOut;
    this.retired.bytesIn += stats.bytesIn;
    this.retired.bytesOut += stats.bytesOut;
  }

  private readLive(): LiveCounters {
    const mux = aggregateMux(this.registry, this.retired);
    const live = this.metering.liveTotalsSnapshot();
    const tenantBytes = new Map<string, RelayUsageDelta>();
    const tenantAdmitted = new Map<string, number>();
    const memberBytes = new Map<string, RelayUsageDelta>();
    let activeStreams = 0;
    for (const tenant of this.tenants.list()) {
      tenantBytes.set(tenant.id, this.metering.liveTenantSnapshot(tenant.id));
      tenantAdmitted.set(tenant.id, this.metering.liveAdmittedSnapshot(tenant.id));
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
      admitted: this.metering.liveAdmittedTotalsSnapshot(),
      tenantBytes,
      tenantAdmitted,
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
      ...this.limitsFor(),
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
      bandwidthBytesPerSec: this.rates.bandwidthBytesPerSec,
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
        quota: this.quotaFor(tenant.id),
        usage: {
          currentNodes: this.tenants.countActiveNodes(tenant.id),
          currentStreams: this.registry.streamCount(tenant.id),
          bytesInPerSec: tenantRates?.bytesInPerSec ?? 0,
          bytesOutPerSec: tenantRates?.bytesOutPerSec ?? 0,
          bandwidthBytesPerSec: tenantRates?.bandwidthBytesPerSec ?? 0,
        },
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
