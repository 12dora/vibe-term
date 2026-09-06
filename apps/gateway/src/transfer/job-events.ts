// 任务事件的 NDJSON 订阅。事件是推来的、消费者是拉的，中间必须有个有界缓冲：
// 一个连上就不读的客户端，否则能把整个任务生命周期的事件全攒在进程里。
// 可替换的事件（进度、同一条目的状态）就地合并，终态事件永远保留，超预算的消费者直接断开。

import type { TransferJobEvent } from '@vibeterm/shared';
import { type TransferJobRecord, subscribeJob } from './job-registry';

const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
};

/** 单个订阅者的事件预算：合并之后还超，说明这个消费者已经跟不上了。 */
const MAX_QUEUED_EVENTS = 256;

interface Slot {
  /** 可替换事件的合并键；null 表示必须按序保留 */
  key: string | null;
  event: TransferJobEvent;
}

function keyOf(event: TransferJobEvent): string | null {
  if (event.type === 'progress') return 'progress';
  if (event.type === 'item') return `item:${event.index}`;
  if (event.type === 'snapshot') return 'snapshot';
  return null;
}

class EventBuffer {
  private readonly queue: Slot[] = [];
  private waiting: (() => void) | null = null;
  private ended = false;
  private overflowed = false;

  push(event: TransferJobEvent): void {
    if (this.ended) return;
    const key = keyOf(event);
    const slot: Slot = { key, event };
    const existing = key === null ? -1 : this.queue.findIndex((s) => s.key === key);
    if (existing >= 0) this.queue[existing] = slot;
    else this.queue.push(slot);
    if (event.type === 'end') this.ended = true;
    if (this.queue.length > MAX_QUEUED_EVENTS) {
      this.overflowed = true;
      this.queue.length = 0;
      this.queue.push({ key: null, event: { type: 'end' } });
      this.ended = true;
    }
    this.wake();
  }

  get disconnected(): boolean {
    return this.overflowed;
  }

  get finished(): boolean {
    return this.ended && this.queue.length === 0;
  }

  take(): TransferJobEvent | null {
    return this.queue.shift()?.event ?? null;
  }

  wait(): Promise<void> {
    if (this.queue.length > 0 || this.ended) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiting = resolve;
    });
  }

  wake(): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.();
  }

  finish(): void {
    this.push({ type: 'end' });
  }
}

export function jobEventsResponse(job: TransferJobRecord): Response {
  const buffer = new EventBuffer();
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  buffer.push({ type: 'snapshot', job: job.snapshot });
  if (job.snapshot.finishedAt !== null) {
    buffer.finish();
  } else {
    unsubscribe = subscribeJob(job, (event) => {
      buffer.push(event);
      if (event.type === 'state' && job.snapshot.finishedAt !== null) buffer.finish();
      if (buffer.disconnected) {
        unsubscribe?.();
        unsubscribe = null;
      }
    });
  }

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        await buffer.wait();
        while ((controller.desiredSize ?? 1) > 0) {
          const event = buffer.take();
          if (!event) break;
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        if (buffer.finished) {
          unsubscribe?.();
          unsubscribe = null;
          controller.close();
        }
      },
      cancel() {
        unsubscribe?.();
        unsubscribe = null;
        buffer.wake();
      },
    },
    new CountQueuingStrategy({ highWaterMark: 32 })
  );
  return new Response(stream, { status: 200, headers: NDJSON_HEADERS });
}
