// 中继级总带宽闸 + 租户间公平分配。
//
// 复用租户级那只令牌桶（`RelayTokenBucket`：只延迟不丢帧、按逻辑流轮转），
// 差别有两处：
//   1. 一个逻辑流 = 一个租户，不是一条中继流——`drain()` 本来就在就绪的流之间轮转发放，
//      租户之间于是天然按轮转分账，不需要第二套调度器；
//   2. 关掉无上限的 ≤4 KiB 旁路（`bypassSmallFrames: false`）。旁路按流轮转、不进 bulk
//      队列，并与 bulk 道 1:1 交替（`shouldServeBypass`）：有 bulk 排队时旁路最多占
//      整管 50%，与租户数无关。每租户另有一只有界旁路预算
//      （`SMALL_FRAME_BYPASS_BYTES_PER_SEC` / 突发 `SMALL_FRAME_BYPASS_BURST_BYTES`）：
//      ≤4 KiB 且（无竞争，或预算够）的帧走 `takeBypass` 跳过 bulk 轮转，用尽则仍进
//      公平队列。无竞争时不扣预算。预算按租户 id 另表保存、空闲 TTL 回收，短时重连
//      继承已消耗的突发。同一租户多条流共用一个旁路轮转位。租户自己那只桶
//      （`relay-uplink-server.ts` 的 `bucketFor`）仍保留无上限交互优先。
// 关掉公平分配时 bulk 共用一条 FCFS 流；旁路道仍按租户轮转，不是 FCFS。
//
// 每条中继流拿到的是自己的把手（`createHandle()`）：关掉它只撤这条流排队的请求，
// 同租户其他流不受影响——否则中止的流会把 payload 和排队位一起留在桶里。

import { type RelayLimits, defaultRelayLimits } from './relay-limits';
import {
  RELAY_TOKEN_BUCKET_BYPASS_BYTES,
  type RelaySleep,
  RelayTokenBucket,
  type RelayTokenHandle,
  type RelayTokenStream,
} from './relay-quota';

/** 每租户可走中继级旁路的小帧速率。多条流共用，避免「切小帧 = 多拿带宽」。 */
export const SMALL_FRAME_BYPASS_BYTES_PER_SEC = 32 * 1024;
/** 每租户小帧旁路突发上限（2 秒额度）。 */
export const SMALL_FRAME_BYPASS_BURST_BYTES = 64 * 1024;
/** 租户流释放后预算保留时长。≥ burst/rate = 2 s，短时重连继承已消耗的突发。 */
const SMALL_FRAME_BYPASS_BUDGET_IDLE_MS = 60_000;

export type RelayBandwidthHandle = {
  take(bytes: number): Promise<void>;
  close(): void;
};

type TenantSlot = {
  stream: RelayTokenStream;
  refs: number;
};

/** 每租户小帧旁路预算：只决定能不能跳过轮转，真正的字节仍从中继总闸扣。 */
class SmallFrameBypassBudget {
  private tokens: number;
  private lastRefillAt: number;
  lastUsedAt: number;

  constructor(
    private readonly now: () => number,
    private readonly rate = SMALL_FRAME_BYPASS_BYTES_PER_SEC,
    private readonly burst = SMALL_FRAME_BYPASS_BURST_BYTES
  ) {
    this.tokens = burst;
    this.lastRefillAt = now();
    this.lastUsedAt = this.lastRefillAt;
  }

  tryConsume(bytes: number): boolean {
    if (bytes <= 0) return true;
    this.refill();
    this.lastUsedAt = this.now();
    if (this.tokens < bytes) return false;
    this.tokens -= bytes;
    return true;
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    this.lastRefillAt = now;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.rate) / 1000);
  }
}

const NOOP_HANDLE: RelayBandwidthHandle = {
  take: () => Promise.resolve(),
  close: () => {},
};

export class RelayBandwidthLimiter {
  private readonly bucket: RelayTokenBucket;
  private readonly slots = new Map<string, TenantSlot>();
  /** 旁路预算按租户 id 另存，不跟槽一起删，避免「关流重开」重置突发。 */
  private readonly budgets = new Map<string, SmallFrameBypassBudget>();
  /** 公平分配关掉时的共享流：单队列 = 先到先得。 */
  private fcfs: RelayTokenStream;
  private limits: RelayLimits;
  private readonly now: () => number;

  constructor(limits: RelayLimits, now: () => number = Date.now, sleep?: RelaySleep) {
    this.limits = limits;
    this.now = now;
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
        return this.takeFor(tenantId, fair, plain, bytes);
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
    this.budgets.clear();
    this.fcfs.close();
    // 兜底：默认流上若还有请求（理论上不会有），一并撤掉，不留悬挂的 promise。
    this.bucket.cancelAll();
    this.fcfs = this.bucket.createStream();
  }

  private takeFor(
    tenantId: string,
    fair: RelayTokenHandle,
    plain: RelayTokenHandle,
    bytes: number
  ): Promise<void> {
    if (
      this.bucket.rateBytesPerSec !== null &&
      bytes > 0 &&
      bytes <= RELAY_TOKEN_BUCKET_BYPASS_BYTES &&
      this.shouldBypassSmallFrame(tenantId, bytes)
    ) {
      return fair.takeBypass(bytes);
    }
    return this.limits.fairShare ? fair.take(bytes) : plain.take(bytes);
  }

  /** 无竞争走旁路但不扣预算；拥塞时才 `tryConsume`。 */
  private shouldBypassSmallFrame(tenantId: string, bytes: number): boolean {
    if (!this.bucket.isCongested(bytes)) return true;
    return this.budgetFor(tenantId).tryConsume(bytes);
  }

  private budgetFor(tenantId: string): SmallFrameBypassBudget {
    this.evictIdleBudgets();
    const existing = this.budgets.get(tenantId);
    if (existing) return existing;
    const budget = new SmallFrameBypassBudget(this.now);
    this.budgets.set(tenantId, budget);
    return budget;
  }

  private evictIdleBudgets(): void {
    const now = this.now();
    for (const [id, budget] of this.budgets) {
      if (this.slots.has(id)) continue;
      if (now - budget.lastUsedAt < SMALL_FRAME_BYPASS_BUDGET_IDLE_MS) continue;
      this.budgets.delete(id);
    }
  }

  private slotFor(tenantId: string): TenantSlot {
    const existing = this.slots.get(tenantId);
    if (existing) return existing;
    const slot: TenantSlot = {
      stream: this.bucket.createStream(),
      refs: 0,
    };
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
