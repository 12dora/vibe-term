// worker 侧的串行队列：hljs 的高亮整段同步跑，切不开，并发只会互相抢 CPU。
// 排队才让「执行前丢弃已取消项」成立——连切几个大文件时旧请求当场出队，
// 最新文件不必排在一串已作废的任务后面。
//
// 每个任务开跑前先让出一个宏任务：worker 的 message 事件也是宏任务，
// 不让出就会在微任务里把整条链跑完，早已躺在事件队列里的 cancel 根本没机会被读到。

import type {
  HighlightRequestMessage,
  HighlightWorkerRequest,
  HighlightWorkerResponse,
} from './highlight-protocol';

export interface HighlightQueueOptions {
  run: (message: HighlightRequestMessage) => Promise<string | null>;
  emit: (response: HighlightWorkerResponse) => void;
  /** 让出一个宏任务；默认 setTimeout(0) */
  yieldToTasks?: () => Promise<void>;
}

export interface HighlightQueue {
  handle: (message: HighlightWorkerRequest) => void;
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function createHighlightQueue({
  run,
  emit,
  yieldToTasks = defaultYield,
}: HighlightQueueOptions): HighlightQueue {
  const queue: HighlightRequestMessage[] = [];
  let draining = false;
  // 语言 chunk 是动态 import，执行途中同样可能收到取消
  let runningId: number | null = null;
  let runningCancelled = false;

  async function drain(): Promise<void> {
    draining = true;
    try {
      while (queue.length > 0) {
        await yieldToTasks();
        const next = queue.shift();
        if (!next) continue;
        runningId = next.id;
        runningCancelled = false;
        const html = await run(next).catch(() => null);
        const dropped = runningCancelled;
        runningId = null;
        runningCancelled = false;
        if (!dropped) emit({ id: next.id, html });
      }
    } finally {
      draining = false;
      runningId = null;
      runningCancelled = false;
    }
  }

  function cancel(id: number): void {
    const index = queue.findIndex((item) => item.id === id);
    if (index !== -1) {
      queue.splice(index, 1);
      return;
    }
    if (runningId === id) runningCancelled = true;
  }

  return {
    handle(message) {
      if (message.type === 'cancel') {
        cancel(message.id);
        return;
      }
      queue.push(message);
      if (!draining) void drain();
    },
  };
}
