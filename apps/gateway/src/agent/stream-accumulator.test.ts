import { describe, expect, test } from 'bun:test';
import { StreamAccumulator } from './stream-accumulator';

interface Scheduled {
  handle: number;
  callback: () => void;
  delayMs: number;
}

function createHarness(flushMaxBytes = 2048, flushIntervalMs = 40) {
  const texts: Array<{ messageId: string; delta: string }> = [];
  const reasonings: Array<{ messageId: string; delta: string }> = [];
  const scheduled: Scheduled[] = [];
  let nextHandle = 1;
  const cancelled: number[] = [];

  const acc = new StreamAccumulator(
    {
      emitText: (messageId, delta) => {
        texts.push({ messageId, delta });
      },
      emitReasoning: (messageId, delta) => {
        reasonings.push({ messageId, delta });
      },
    },
    {
      flushIntervalMs,
      flushMaxBytes,
      schedule: (callback, delayMs) => {
        const handle = nextHandle;
        nextHandle += 1;
        scheduled.push({ handle, callback, delayMs });
        return handle;
      },
      cancel: (handle) => {
        cancelled.push(handle as number);
        const index = scheduled.findIndex((item) => item.handle === handle);
        if (index >= 0) {
          scheduled.splice(index, 1);
        }
      },
    }
  );

  return { acc, texts, reasonings, scheduled, cancelled };
}

describe('StreamAccumulator', () => {
  test('未达字节上限时只排程一次，定时器触发后按到达顺序合帧', () => {
    const { acc, texts, scheduled } = createHarness();
    acc.queueTextDelta('m1', 'a');
    acc.queueTextDelta('m1', 'b');
    acc.queueTextDelta('m1', 'c');
    expect(scheduled.length).toBe(1);
    const first = scheduled[0];
    expect(first?.delayMs).toBe(40);
    expect(texts).toEqual([]);
    expect(acc.inProgressText).toBe('abc');

    first?.callback();
    expect(texts).toEqual([{ messageId: 'm1', delta: 'abc' }]);
    expect(acc.inProgressText).toBe('abc');
  });

  test('已有定时器时后续 queue 不重置间隔', () => {
    const { acc, scheduled } = createHarness();
    acc.queueTextDelta('m1', 'a');
    const first = scheduled[0];
    acc.queueTextDelta('m1', 'b');
    expect(scheduled.length).toBe(1);
    expect(scheduled[0]).toBe(first);
  });

  test('pending 字节达到上限立即 flush，并取消已排程定时器', () => {
    const { acc, texts, scheduled, cancelled } = createHarness(4);
    acc.queueTextDelta('m1', 'ab');
    expect(scheduled.length).toBe(1);
    acc.queueTextDelta('m1', 'cd');
    expect(texts).toEqual([{ messageId: 'm1', delta: 'abcd' }]);
    expect(cancelled).toEqual([1]);
    expect(scheduled.length).toBe(0);
  });

  test('messageId 变化时先 flush 旧帧再开始新帧', () => {
    const { acc, texts } = createHarness();
    acc.queueTextDelta('m1', 'old');
    acc.queueTextDelta('m2', 'new');
    expect(texts).toEqual([{ messageId: 'm1', delta: 'old' }]);
    acc.flush();
    expect(texts).toEqual([
      { messageId: 'm1', delta: 'old' },
      { messageId: 'm2', delta: 'new' },
    ]);
  });

  test('flush 先发 text 再发 reasoning（同一次 flush）', () => {
    const order: string[] = [];
    const acc = new StreamAccumulator(
      {
        emitText: (_messageId, delta) => {
          order.push(`t:${delta}`);
        },
        emitReasoning: (_messageId, delta) => {
          order.push(`r:${delta}`);
        },
      },
      { flushIntervalMs: 40, flushMaxBytes: 2048, schedule: () => 1, cancel: () => {} }
    );
    acc.queueTextDelta('t', 'T');
    acc.queueReasoningDelta('r', 'R');
    acc.flush();
    expect(order).toEqual(['t:T', 'r:R']);
  });

  test('clearTimer 取消未触发的 flush，pending 保留到显式 flush', () => {
    const { acc, texts, scheduled } = createHarness();
    acc.queueTextDelta('m1', 'held');
    acc.clearTimer();
    expect(scheduled.length).toBe(0);
    expect(texts).toEqual([]);
    acc.flush();
    expect(texts).toEqual([{ messageId: 'm1', delta: 'held' }]);
  });

  test('reset 丢掉未 flush 的 pending，避免下一轮重试污染', () => {
    const { acc, texts } = createHarness();
    acc.queueTextDelta('m1', 'stale');
    acc.reset();
    expect(acc.inProgressText).toBe('');
    acc.queueTextDelta('m2', 'fresh');
    acc.flush();
    expect(texts).toEqual([{ messageId: 'm2', delta: 'fresh' }]);
  });

  test('clearInProgress 只清累积缓冲，不影响已 pending 的广播帧', () => {
    const { acc, texts } = createHarness();
    acc.queueTextDelta('m1', 'keep');
    acc.clearInProgress();
    expect(acc.inProgressText).toBe('');
    acc.flush();
    expect(texts).toEqual([{ messageId: 'm1', delta: 'keep' }]);
  });

  test('consumeInProgressText 取出文本并清空 reasoning', () => {
    const { acc } = createHarness();
    acc.queueTextDelta('m1', 'hello');
    acc.queueReasoningDelta('r1', 'think');
    expect(acc.consumeInProgressText()).toBe('hello');
    expect(acc.inProgressText).toBe('');
    expect(acc.inProgressReasoning).toBe('');
  });
});
