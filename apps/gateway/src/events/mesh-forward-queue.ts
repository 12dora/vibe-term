// 单个汇聚机的离线队列：有界、按事件身份合并、超时丢弃。
//
// 汇聚机掉线时节点不能无限攒事件：上限 20 条 / 3 分钟，入队按
// `nodeId:deviceId:paneId:eventType` 合并只留最新一条，超限丢最旧，
// 出队时丢过期。丢弃一律回调给调用方打日志。

import type { MeshNotificationForwardRequest } from '@tmex/shared';

export const MESH_FORWARD_QUEUE_MAX = 20;
export const MESH_FORWARD_QUEUE_TTL_MS = 3 * 60 * 1000;
/** 单次投递的截止时间：对端卡住时不能无限占着这条队列的单飞位。 */
export const MESH_FORWARD_DELIVER_TIMEOUT_MS = 15_000;
/** 重试退避：1/2/4/8 s，之后恒定 15 s 封顶。 */
export const MESH_FORWARD_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export type MeshForwardDropReason = 'overflow' | 'expired';

export type MeshForwardEntry = {
  key: string;
  at: number;
  body: MeshNotificationForwardRequest;
};

export function meshForwardKey(body: MeshNotificationForwardRequest): string {
  const deviceId = body.event.device?.id ?? '-';
  const paneId = body.event.tmux?.paneId ?? '-';
  return `${body.origin.nodeId}:${deviceId}:${paneId}:${body.eventType}`;
}

export function meshForwardBackoffMs(attempt: number): number {
  const index = Math.max(0, Math.min(attempt, MESH_FORWARD_BACKOFF_MS.length - 1));
  return MESH_FORWARD_BACKOFF_MS[index] ?? MESH_FORWARD_BACKOFF_MS[0];
}

export type MeshForwardQueueOptions = {
  max?: number;
  ttlMs?: number;
  onDrop?: (entry: MeshForwardEntry, reason: MeshForwardDropReason) => void;
};

export class MeshForwardQueue {
  private readonly items: MeshForwardEntry[] = [];
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly onDrop: (entry: MeshForwardEntry, reason: MeshForwardDropReason) => void;
  private droppedCount = 0;

  constructor(opts: MeshForwardQueueOptions = {}) {
    this.max = opts.max ?? MESH_FORWARD_QUEUE_MAX;
    this.ttlMs = opts.ttlMs ?? MESH_FORWARD_QUEUE_TTL_MS;
    this.onDrop = opts.onDrop ?? (() => {});
  }

  get size(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /** 入队并按身份合并；返回队列当前长度。 */
  push(body: MeshNotificationForwardRequest, now: number): number {
    const entry: MeshForwardEntry = { key: meshForwardKey(body), at: now, body };
    const existing = this.items.findIndex((item) => item.key === entry.key);
    if (existing >= 0) {
      this.items[existing] = entry;
      return this.items.length;
    }
    this.items.push(entry);
    while (this.items.length > this.max) {
      const evicted = this.items.shift();
      if (evicted) this.drop(evicted, 'overflow');
    }
    return this.items.length;
  }

  /** 取队首；过期的一路丢弃直到取到有效条目。 */
  shift(now: number): MeshForwardEntry | null {
    while (this.items.length > 0) {
      const entry = this.items.shift();
      if (!entry) break;
      if (now - entry.at >= this.ttlMs) {
        this.drop(entry, 'expired');
        continue;
      }
      return entry;
    }
    return null;
  }

  /**
   * 重试失败后放回队首；期间新入队的同身份事件已经更新，不再回插。
   * 队列已满时丢的是这条**最旧**的（与 push 的溢出策略一致），不能反过来把队尾的新事件挤掉。
   */
  unshift(entry: MeshForwardEntry): void {
    if (this.items.some((item) => item.key === entry.key)) return;
    if (this.items.length >= this.max) {
      this.drop(entry, 'overflow');
      return;
    }
    this.items.unshift(entry);
  }

  clear(): void {
    this.items.length = 0;
  }

  private drop(entry: MeshForwardEntry, reason: MeshForwardDropReason): void {
    this.droppedCount += 1;
    this.onDrop(entry, reason);
  }
}
