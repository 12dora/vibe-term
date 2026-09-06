// 中继级总带宽闸 + 租户间公平分配。
//
// 复用租户级那只令牌桶（`RelayTokenBucket`：只延迟不丢帧、按逻辑流轮转、≤4 KiB 旁路道），
// 差别只在「一个逻辑流 = 一个租户」而不是「一条中继流」：
// `drain()` 本来就在就绪的流之间轮转发放，于是租户之间天然按轮转分账，不需要第二套调度器。
// 关掉公平分配时所有租户共用桶的默认流，退回先到先得。

import { type RelayLimits, defaultRelayLimits } from './relay-limits';
import { type RelaySleep, RelayTokenBucket, type RelayTokenStream } from './relay-quota';

export type RelayBandwidthHandle = {
  take(bytes: number): Promise<void>;
  close(): void;
};

type TenantSlot = { stream: RelayTokenStream; refs: number };

const NOOP_HANDLE: RelayBandwidthHandle = {
  take: () => Promise.resolve(),
  close: () => {},
};

export class RelayBandwidthLimiter {
  private readonly bucket: RelayTokenBucket;
  private readonly slots = new Map<string, TenantSlot>();
  private limits: RelayLimits;

  constructor(limits: RelayLimits, now: () => number = Date.now, sleep?: RelaySleep) {
    this.limits = limits;
    this.bucket = new RelayTokenBucket(limits.totalBandwidthBytesPerSec, now, sleep);
  }

  get rateBytesPerSec(): number | null {
    return this.bucket.rateBytesPerSec;
  }

  get fairShare(): boolean {
    return this.limits.fairShare;
  }

  /** 限额改动后热更新：速率立刻生效，公平分配开关对之后的 take 生效。 */
  setLimits(limits: RelayLimits): void {
    this.limits = limits;
    this.bucket.setRate(limits.totalBandwidthBytesPerSec);
  }

  /**
   * 取一条中继流的把手。同一租户的多条流共用一个父流（引用计数），
   * 这样桶里每个租户只占一个轮转位——否则开流多的租户会按流数抢到更多带宽。
   */
  acquire(tenantId: string): RelayBandwidthHandle {
    const slot = this.slotFor(tenantId);
    slot.refs += 1;
    let closed = false;
    return {
      take: (bytes) => (this.limits.fairShare ? slot.stream.take(bytes) : this.bucket.take(bytes)),
      close: () => {
        if (closed) return;
        closed = true;
        this.release(tenantId);
      },
    };
  }

  clear(): void {
    for (const slot of this.slots.values()) slot.stream.close();
    this.slots.clear();
  }

  private slotFor(tenantId: string): TenantSlot {
    const existing = this.slots.get(tenantId);
    if (existing) return existing;
    const slot: TenantSlot = { stream: this.bucket.createStream(), refs: 0 };
    this.slots.set(tenantId, slot);
    return slot;
  }

  private release(tenantId: string): void {
    const slot = this.slots.get(tenantId);
    if (!slot) return;
    slot.refs -= 1;
    if (slot.refs > 0) return;
    this.slots.delete(tenantId);
    slot.stream.close();
  }
}

export function noopBandwidthHandle(): RelayBandwidthHandle {
  return NOOP_HANDLE;
}

export function createRelayBandwidthLimiter(
  limits: RelayLimits | undefined,
  now: () => number,
  sleep?: RelaySleep
): RelayBandwidthLimiter {
  return new RelayBandwidthLimiter(limits ?? defaultRelayLimits(), now, sleep);
}
