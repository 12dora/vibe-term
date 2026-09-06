// 节点侧的通知转发器：每个汇聚机一条有界队列 + 单飞投递 + 指数退避。
//
// 只负责「按队列语义把事件送到汇聚机」，汇聚机集合、投递通道由调用方注入，
// 便于单测跑纯内存的时钟与假投递。
//
// 两条硬约束：
//   1. 单次投递有截止时间（默认 15 s），对端卡住时按可重试失败处理，队列继续排空；
//   2. 队列被 forget/stop 丢弃后不得再排队、再起定时器（每个 await 之后重新检查 disposed）。
//
// 每次投递（含每次重试）之前都要重新问一遍「这台还是用户签过的汇聚机吗」：入队时通过不等于
// 重试时仍然通过——被攻陷的汇聚机可以先让投递失败，等声明被撤销后再收下重试件。

import type { MeshNotificationForwardRequest } from '@vibeterm/shared';
import {
  MESH_FORWARD_DELIVER_TIMEOUT_MS,
  MESH_FORWARD_QUEUE_MAX,
  MESH_FORWARD_QUEUE_TTL_MS,
  type MeshForwardDropReason,
  type MeshForwardEntry,
  MeshForwardQueue,
  meshForwardBackoffMs,
} from './mesh-forward-queue';

export type MeshForwardDeliver = (
  sinkNodeId: string,
  body: MeshNotificationForwardRequest,
  signal: AbortSignal
) => Promise<Response>;

export type MeshForwarderDeps = {
  /** 投递一条；抛错、返回非 2xx 或超过截止时间均视为失败并重试。 */
  deliver: MeshForwardDeliver;
  /** 当前是否仍是用户签过的汇聚机；每次投递前重新问一次，不成立即丢队列。 */
  isSinkAuthorized?: (sinkNodeId: string) => boolean;
  now?: () => number;
  /** 返回取消函数；默认 setTimeout。 */
  delay?: (ms: number, fn: () => void) => () => void;
  log?: (line: string) => void;
  max?: number;
  ttlMs?: number;
  deadlineMs?: number;
};

type ResolvedDeps = {
  deliver: MeshForwardDeliver;
  isSinkAuthorized: (sinkNodeId: string) => boolean;
  now: () => number;
  delay: (ms: number, fn: () => void) => () => void;
  log: (line: string) => void;
  max: number;
  ttlMs: number;
  deadlineMs: number;
};

type SinkLane = {
  queue: MeshForwardQueue;
  draining: boolean;
  attempt: number;
  timer: (() => void) | null;
  inflight: AbortController | null;
  disposed: boolean;
};

function defaultDelay(ms: number, fn: () => void): () => void {
  const handle = setTimeout(fn, ms);
  if (typeof handle === 'object' && handle && 'unref' in handle) {
    (handle as { unref: () => void }).unref();
  }
  return () => clearTimeout(handle);
}

export class MeshNotificationForwarder {
  private readonly lanes = new Map<string, SinkLane>();
  private readonly deps: ResolvedDeps;
  private stopped = false;
  /** 已经被移除的队列贡献的丢弃数：队列一删，它自己的计数就不在 `lanes` 里了。 */
  private retiredDropped = 0;

  constructor(deps: MeshForwarderDeps) {
    this.deps = {
      deliver: deps.deliver,
      isSinkAuthorized: deps.isSinkAuthorized ?? (() => true),
      now: deps.now ?? (() => Date.now()),
      delay: deps.delay ?? defaultDelay,
      log: deps.log ?? ((line: string) => console.warn(line)),
      max: deps.max ?? MESH_FORWARD_QUEUE_MAX,
      ttlMs: deps.ttlMs ?? MESH_FORWARD_QUEUE_TTL_MS,
      deadlineMs: deps.deadlineMs ?? MESH_FORWARD_DELIVER_TIMEOUT_MS,
    };
  }

  /** 待发条数（所有汇聚机之和）。 */
  get pending(): number {
    let total = 0;
    for (const lane of this.lanes.values()) total += lane.queue.size;
    return total;
  }

  get dropped(): number {
    let total = this.retiredDropped;
    for (const lane of this.lanes.values()) total += lane.queue.dropped;
    return total;
  }

  enqueue(sinkNodeId: string, body: MeshNotificationForwardRequest): void {
    if (this.stopped || !this.deps.isSinkAuthorized(sinkNodeId)) return;
    const lane = this.laneOf(sinkNodeId);
    lane.queue.push(body, this.deps.now());
    this.kick(sinkNodeId, lane);
  }

  /**
   * 汇聚机被移出集合：丢掉它的队列，取消在途投递，别继续占内存和重试。
   * 声明被撤销时传 `'unauthorized'`，队列里剩下的事件逐条计入丢弃并打日志。
   */
  forget(sinkNodeId: string, reason?: 'unauthorized'): void {
    const lane = this.lanes.get(sinkNodeId);
    if (!lane) return;
    this.lanes.delete(sinkNodeId);
    lane.disposed = true;
    lane.timer?.();
    lane.timer = null;
    lane.inflight?.abort();
    lane.inflight = null;
    if (reason) lane.queue.discard(reason);
    else lane.queue.clear();
    this.retiredDropped += lane.queue.dropped;
  }

  /** 汇聚声明变更后调用：把已经不在集合里的队列连同在途投递一并收掉。 */
  pruneUnauthorized(): void {
    for (const id of [...this.lanes.keys()]) {
      if (!this.deps.isSinkAuthorized(id)) this.forget(id, 'unauthorized');
    }
  }

  /** 桥被替换/清空时调用：不再接受入队，取消全部定时器与在途投递。 */
  stop(): void {
    this.stopped = true;
    for (const id of [...this.lanes.keys()]) this.forget(id);
  }

  private laneOf(sinkNodeId: string): SinkLane {
    const existing = this.lanes.get(sinkNodeId);
    if (existing) return existing;
    const lane: SinkLane = {
      queue: new MeshForwardQueue({
        max: this.deps.max,
        ttlMs: this.deps.ttlMs,
        onDrop: (entry, reason) => this.logDrop(sinkNodeId, entry, reason),
      }),
      draining: false,
      attempt: 0,
      timer: null,
      inflight: null,
      disposed: false,
    };
    this.lanes.set(sinkNodeId, lane);
    return lane;
  }

  private logDrop(
    sinkNodeId: string,
    entry: MeshForwardEntry,
    reason: MeshForwardDropReason
  ): void {
    this.deps.log(
      `[notify] forward dropped sink=${sinkNodeId} reason=${reason} event=${entry.body.eventType} key=${entry.key}`
    );
  }

  private alive(sinkNodeId: string, lane: SinkLane): boolean {
    return !this.stopped && !lane.disposed && this.lanes.get(sinkNodeId) === lane;
  }

  private kick(sinkNodeId: string, lane: SinkLane): void {
    if (lane.draining || lane.timer) return;
    void this.drain(sinkNodeId, lane);
  }

  private schedule(sinkNodeId: string, lane: SinkLane, ms: number): void {
    if (!this.alive(sinkNodeId, lane)) return;
    lane.timer?.();
    lane.timer = this.deps.delay(ms, () => {
      lane.timer = null;
      if (!this.alive(sinkNodeId, lane)) return;
      void this.drain(sinkNodeId, lane);
    });
  }

  private async drain(sinkNodeId: string, lane: SinkLane): Promise<void> {
    if (lane.draining || !this.alive(sinkNodeId, lane)) return;
    lane.draining = true;
    try {
      while (this.alive(sinkNodeId, lane)) {
        // 投递前重新核对签名声明：撤销后队列里的事件一条都不许再发出去。
        if (!this.deps.isSinkAuthorized(sinkNodeId)) {
          this.forget(sinkNodeId, 'unauthorized');
          return;
        }
        const entry = lane.queue.shift(this.deps.now());
        if (!entry) {
          lane.attempt = 0;
          return;
        }
        const ok = await this.deliverOnce(sinkNodeId, lane, entry);
        // 投递期间可能被 forget/stop：此时队列已丢弃，不许回插也不许再起定时器。
        if (!this.alive(sinkNodeId, lane)) return;
        if (ok) {
          lane.attempt = 0;
          continue;
        }
        lane.queue.unshift(entry);
        const wait = meshForwardBackoffMs(lane.attempt);
        lane.attempt += 1;
        this.schedule(sinkNodeId, lane, wait);
        return;
      }
    } finally {
      lane.draining = false;
    }
  }

  private async deliverOnce(
    sinkNodeId: string,
    lane: SinkLane,
    entry: MeshForwardEntry
  ): Promise<boolean> {
    const controller = new AbortController();
    lane.inflight = controller;
    const deadline = this.armDeadline(controller);
    try {
      const res = await Promise.race([
        this.deps.deliver(sinkNodeId, entry.body, controller.signal),
        deadline.expired,
      ]);
      if (!res) {
        // 队列已被丢弃时的 abort 不是超时，不打日志。
        if (!lane.disposed) {
          this.deps.log(
            `[notify] forward timeout sink=${sinkNodeId} event=${entry.body.eventType} key=${entry.key}`
          );
        }
        return false;
      }
      return this.acceptResponse(sinkNodeId, entry, res);
    } catch {
      return false;
    } finally {
      deadline.cancel();
      if (lane.inflight === controller) lane.inflight = null;
    }
  }

  /**
   * 截止时间到就 abort 在途请求并让 race 以 null 收尾（对端不认 signal 时也不会卡住）；
   * 外部 abort（forget/stop）同样让 race 立刻收尾，好把截止定时器一起收掉。
   */
  private armDeadline(controller: AbortController): { expired: Promise<null>; cancel: () => void } {
    let cancelTimer: () => void = () => {};
    let detach: () => void = () => {};
    const expired = new Promise<null>((resolve) => {
      const finish = (): void => resolve(null);
      cancelTimer = this.deps.delay(this.deps.deadlineMs, () => {
        controller.abort();
        finish();
      });
      controller.signal.addEventListener('abort', finish, { once: true });
      detach = () => controller.signal.removeEventListener('abort', finish);
    });
    return {
      expired,
      cancel: () => {
        cancelTimer();
        detach();
      },
    };
  }

  private acceptResponse(sinkNodeId: string, entry: MeshForwardEntry, res: Response): boolean {
    if (res.ok) return true;
    // 汇聚机关掉了开关（404）或拒收（4xx）：重试没意义，直接丢弃这条。
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      this.deps.log(
        `[notify] forward dropped sink=${sinkNodeId} reason=rejected status=${res.status} event=${entry.body.eventType}`
      );
      return true;
    }
    return false;
  }
}
