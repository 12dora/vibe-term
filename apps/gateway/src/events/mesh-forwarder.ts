// 节点侧的通知转发器：每个汇聚机一条有界队列 + 单飞投递 + 指数退避。
//
// 只负责「按队列语义把事件送到汇聚机」，汇聚机集合、投递通道由调用方注入，
// 便于单测跑纯内存的时钟与假投递。

import type { MeshNotificationForwardRequest } from '@tmex/shared';
import {
  MESH_FORWARD_QUEUE_MAX,
  MESH_FORWARD_QUEUE_TTL_MS,
  type MeshForwardDropReason,
  type MeshForwardEntry,
  MeshForwardQueue,
  meshForwardBackoffMs,
} from './mesh-forward-queue';

export type MeshForwarderDeps = {
  /** 投递一条；抛错或返回非 2xx 均视为失败并重试。 */
  deliver: (sinkNodeId: string, body: MeshNotificationForwardRequest) => Promise<Response>;
  now?: () => number;
  /** 返回取消函数；默认 setTimeout。 */
  delay?: (ms: number, fn: () => void) => () => void;
  log?: (line: string) => void;
  max?: number;
  ttlMs?: number;
};

type SinkLane = {
  queue: MeshForwardQueue;
  draining: boolean;
  attempt: number;
  timer: (() => void) | null;
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
  private readonly deps: Required<Omit<MeshForwarderDeps, 'max' | 'ttlMs'>> &
    Pick<MeshForwarderDeps, 'max' | 'ttlMs'>;

  constructor(deps: MeshForwarderDeps) {
    this.deps = {
      deliver: deps.deliver,
      now: deps.now ?? (() => Date.now()),
      delay: deps.delay ?? defaultDelay,
      log: deps.log ?? ((line: string) => console.warn(line)),
      max: deps.max ?? MESH_FORWARD_QUEUE_MAX,
      ttlMs: deps.ttlMs ?? MESH_FORWARD_QUEUE_TTL_MS,
    };
  }

  /** 待发条数（所有汇聚机之和）。 */
  get pending(): number {
    let total = 0;
    for (const lane of this.lanes.values()) total += lane.queue.size;
    return total;
  }

  get dropped(): number {
    let total = 0;
    for (const lane of this.lanes.values()) total += lane.queue.dropped;
    return total;
  }

  enqueue(sinkNodeId: string, body: MeshNotificationForwardRequest): void {
    const lane = this.laneOf(sinkNodeId);
    lane.queue.push(body, this.deps.now());
    this.kick(sinkNodeId, lane);
  }

  /** 汇聚机被移出集合：丢掉它的队列，别继续占内存和重试。 */
  forget(sinkNodeId: string): void {
    const lane = this.lanes.get(sinkNodeId);
    if (!lane) return;
    lane.timer?.();
    lane.queue.clear();
    this.lanes.delete(sinkNodeId);
  }

  stop(): void {
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

  private kick(sinkNodeId: string, lane: SinkLane): void {
    if (lane.draining || lane.timer) return;
    void this.drain(sinkNodeId, lane);
  }

  private schedule(sinkNodeId: string, lane: SinkLane, ms: number): void {
    lane.timer?.();
    lane.timer = this.deps.delay(ms, () => {
      lane.timer = null;
      void this.drain(sinkNodeId, lane);
    });
  }

  private async drain(sinkNodeId: string, lane: SinkLane): Promise<void> {
    if (lane.draining) return;
    lane.draining = true;
    try {
      while (true) {
        const entry = lane.queue.shift(this.deps.now());
        if (!entry) {
          lane.attempt = 0;
          return;
        }
        if (await this.deliverOnce(sinkNodeId, entry)) {
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

  private async deliverOnce(sinkNodeId: string, entry: MeshForwardEntry): Promise<boolean> {
    try {
      const res = await this.deps.deliver(sinkNodeId, entry.body);
      if (res.ok) return true;
      // 汇聚机关掉了开关（404）或拒收（4xx）：重试没意义，直接丢弃这条。
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        this.deps.log(
          `[notify] forward dropped sink=${sinkNodeId} reason=rejected status=${res.status} event=${entry.body.eventType}`
        );
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}
