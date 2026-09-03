import type { LinkSession } from '@tmex/shared/link';
import {
  RELAY_CTL_QUEUE_MAX,
  RELAY_CTL_QUEUE_MAX_BYTES,
  RELAY_STOP_DRAIN_TIMEOUT_MS,
} from './types';

type CtlQueueState = { depth: number; bytes: number; tail: Promise<void> };

/**
 * 每链路的 ctl 串行队列：按条数与累计字节双重限深，超限直接断链；
 * 停机时等待在飞的处理排空（超时则放弃等待）。
 */
export class RelayCtlQueue {
  private readonly queues = new WeakMap<LinkSession, CtlQueueState>();
  private readonly inflight = new Set<Promise<void>>();

  enqueue(
    link: LinkSession,
    bytes: Uint8Array,
    run: () => Promise<void>,
    isOpen: () => boolean
  ): Promise<void> {
    let queue = this.queues.get(link);
    if (!queue) {
      queue = { depth: 0, bytes: 0, tail: Promise.resolve() };
      this.queues.set(link, queue);
    }
    if (
      queue.depth >= RELAY_CTL_QUEUE_MAX ||
      queue.bytes + bytes.byteLength > RELAY_CTL_QUEUE_MAX_BYTES
    ) {
      link.close('ctl-overflow');
      return Promise.resolve();
    }
    queue.depth += 1;
    queue.bytes += bytes.byteLength;
    const started = queue.tail.catch(() => undefined).then(run);
    const settled = started.then(
      () => undefined,
      () => undefined
    );
    this.inflight.add(settled);
    void settled.finally(() => {
      this.inflight.delete(settled);
    });
    queue.tail = started
      .catch(() => {
        if (isOpen()) link.close('ctl-error');
      })
      .finally(() => {
        queue.depth = Math.max(0, queue.depth - 1);
        queue.bytes = Math.max(0, queue.bytes - bytes.byteLength);
      });
    return settled;
  }

  async drain(): Promise<void> {
    const pending = [...this.inflight];
    if (pending.length === 0) return;
    let timedOut = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, RELAY_STOP_DRAIN_TIMEOUT_MS);
      void Promise.allSettled(pending).then(() => {
        if (!timedOut) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    if (timedOut) console.warn('[relay] uplink stop drain timed out; continuing');
  }
}
