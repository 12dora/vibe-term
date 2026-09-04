import { memberKey } from './relay-registry';
import type { RelayTenantStore } from './relay-tenant-store';
import { RELAY_METER_FLUSH_MS } from './types';

export type RelayUsageDelta = { bytesIn: number; bytesOut: number };

function addDelta(entry: RelayUsageDelta, delta: RelayUsageDelta): RelayUsageDelta {
  entry.bytesIn += delta.bytesIn;
  entry.bytesOut += delta.bytesOut;
  return entry;
}

function copyDelta(entry: RelayUsageDelta | undefined): RelayUsageDelta {
  return { bytesIn: entry?.bytesIn ?? 0, bytesOut: entry?.bytesOut ?? 0 };
}

/**
 * 每租户流量计量：内存累计，定时（默认 30 s）与停机时落库。
 * `bytesIn` = 中继从成员读到的字节，`bytesOut` = 中继写给成员的字节；
 * 一次转发的同一份字节在租户 in / out 两边各记一次（与落库口径一致）。
 * 成员维度的 live counter 按方向记账：源成员 `bytesIn`、目标成员 `bytesOut`。
 */
export class RelayMetering {
  private readonly pending = new Map<string, RelayUsageDelta>();
  private readonly liveTotals: RelayUsageDelta = { bytesIn: 0, bytesOut: 0 };
  private readonly liveTenants = new Map<string, RelayUsageDelta>();
  private readonly liveMembers = new Map<string, RelayUsageDelta>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tenants: RelayTenantStore,
    private readonly now: () => number = Date.now,
    private readonly flushIntervalMs = RELAY_METER_FLUSH_MS,
    /** 与计量同频的清扫钩子（过期 enrollment 等），刷盘无内容时也照跑。 */
    private readonly onFlush?: () => void
  ) {}

  start(): void {
    if (this.timer !== null || this.flushIntervalMs <= 0) return;
    this.timer = setInterval(() => {
      this.flush();
    }, this.flushIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  record(tenantId: string, delta: Partial<RelayUsageDelta>): void {
    const bytesIn = delta.bytesIn ?? 0;
    const bytesOut = delta.bytesOut ?? 0;
    if (bytesIn <= 0 && bytesOut <= 0) return;
    const usage = { bytesIn, bytesOut };
    const entry = this.pending.get(tenantId) ?? { bytesIn: 0, bytesOut: 0 };
    this.pending.set(tenantId, addDelta(entry, usage));
    addDelta(this.liveTotals, usage);
    const live = this.liveTenants.get(tenantId) ?? { bytesIn: 0, bytesOut: 0 };
    this.liveTenants.set(tenantId, addDelta(live, usage));
  }

  recordMember(tenantId: string, nodeId: string, delta: Partial<RelayUsageDelta>): void {
    const bytesIn = delta.bytesIn ?? 0;
    const bytesOut = delta.bytesOut ?? 0;
    if (bytesIn <= 0 && bytesOut <= 0) return;
    const key = memberKey(tenantId, nodeId);
    const entry = this.liveMembers.get(key) ?? { bytesIn: 0, bytesOut: 0 };
    this.liveMembers.set(key, addDelta(entry, { bytesIn, bytesOut }));
  }

  pendingFor(tenantId: string): RelayUsageDelta {
    return copyDelta(this.pending.get(tenantId));
  }

  liveTotalsSnapshot(): RelayUsageDelta {
    return copyDelta(this.liveTotals);
  }

  liveTenantSnapshot(tenantId: string): RelayUsageDelta {
    return copyDelta(this.liveTenants.get(tenantId));
  }

  liveMemberSnapshot(tenantId: string, nodeId: string): RelayUsageDelta {
    return copyDelta(this.liveMembers.get(memberKey(tenantId, nodeId)));
  }

  forget(tenantId: string): void {
    this.pending.delete(tenantId);
    this.liveTenants.delete(tenantId);
    const prefix = `${tenantId}\0`;
    for (const key of this.liveMembers.keys()) {
      if (key.startsWith(prefix)) this.liveMembers.delete(key);
    }
  }

  flush(): void {
    try {
      this.onFlush?.();
    } catch {
      // 清扫失败不该影响计量落库
    }
    if (this.pending.size === 0) return;
    const now = this.now();
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [tenantId, delta] of entries) {
      try {
        this.tenants.addUsage(tenantId, delta.bytesIn, delta.bytesOut, now);
      } catch {
        // 租户已被删除时忽略；计量不该影响转发
      }
    }
  }
}
