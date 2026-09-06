// 中继级总带宽闸 + 租户间公平分配。
//
// 复用租户级那只令牌桶（`RelayTokenBucket`：只延迟不丢帧、按逻辑流轮转），
// 差别有两处：
//   1. 一个逻辑流 = 一个租户，不是一条中继流——`drain()` 本来就在就绪的流之间轮转发放，
//      租户之间于是天然按轮转分账，不需要第二套调度器；
//   2. 关掉 ≤4 KiB 的旁路道。旁路是桶级 FIFO，不进轮转，开小帧流多的租户能靠它多拿带宽；
//      交互优先只在租户自己那只桶里保留（`relay-uplink-server.ts` 的 `bucketFor`）。
// 关掉公平分配时所有租户共用一条 FCFS 流，退回先到先得。
//
// 每条中继流拿到的是自己的把手（`createHandle()`）：关掉它只撤这条流排队的请求，
// 同租户其他流不受影响——否则中止的流会把 payload 和排队位一起留在桶里。

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
  /** 公平分配关掉时的共享流：单队列 = 先到先得。 */
  private fcfs: RelayTokenStream;
  private limits: RelayLimits;

  constructor(limits: RelayLimits, now: () => number = Date.now, sleep?: RelaySleep) {
    this.limits = limits;
    this.bucket = new RelayTokenBucket(limits.totalBandwidthBytesPerSec, now, sleep, {
      bypassSmallFrames: false,
    });
    this.fcfs = this.bucket.createStream();
  }

  get rateBytesPerSec(): number | null {
    return this.bucket.rateBytesPerSec;
  }

  get fairShare(): boolean {
    return this.limits.fairShare;
  }

  /** 桶里还没发放完的请求笔数。 */
  get pendingCount(): number {
    return this.bucket.pendingCount;
  }

  /** 当前持有把手的租户数。 */
  get tenantCount(): number {
    return this.slots.size;
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
    const fair = slot.stream.createHandle();
    const plain = this.fcfs.createHandle();
    let closed = false;
    return {
      take: (bytes) => {
        if (closed) return Promise.reject(new Error('relay bandwidth handle closed'));
        return this.limits.fairShare ? fair.take(bytes) : plain.take(bytes);
      },
      close: () => {
        if (closed) return;
        closed = true;
        fair.close();
        plain.close();
        this.release(tenantId);
      },
    };
  }

  clear(): void {
    for (const slot of this.slots.values()) slot.stream.close();
    this.slots.clear();
    this.fcfs.close();
    // 兜底：默认流上若还有请求（理论上不会有），一并撤掉，不留悬挂的 promise。
    this.bucket.cancelAll();
    this.fcfs = this.bucket.createStream();
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
