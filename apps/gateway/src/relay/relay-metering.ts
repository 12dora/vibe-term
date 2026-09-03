import type { RelayTenantStore } from './relay-tenant-store';
import { RELAY_METER_FLUSH_MS } from './types';

export type RelayUsageDelta = { bytesIn: number; bytesOut: number };

/**
 * 每租户流量计量：内存累计，定时（默认 30 s）与停机时落库。
 * `bytesIn` = 中继从该租户节点读到的字节，`bytesOut` = 中继写给该租户节点的字节；
 * 一次转发的同一份字节两边各记一次。
 */
export class RelayMetering {
  private readonly pending = new Map<string, RelayUsageDelta>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tenants: RelayTenantStore,
    private readonly now: () => number = Date.now,
    private readonly flushIntervalMs = RELAY_METER_FLUSH_MS
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
    const entry = this.pending.get(tenantId) ?? { bytesIn: 0, bytesOut: 0 };
    entry.bytesIn += bytesIn;
    entry.bytesOut += bytesOut;
    this.pending.set(tenantId, entry);
  }

  pendingFor(tenantId: string): RelayUsageDelta {
    return this.pending.get(tenantId) ?? { bytesIn: 0, bytesOut: 0 };
  }

  forget(tenantId: string): void {
    this.pending.delete(tenantId);
  }

  flush(): void {
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
