// worker 侧串行队列：取消必须在执行前生效，否则被取消的大文件仍会把最新请求堵在后面。

import { describe, expect, test } from 'bun:test';
import type { HighlightRequestMessage, HighlightWorkerResponse } from './highlight-protocol';
import { createHighlightQueue } from './highlight-queue';

function ask(id: number): HighlightRequestMessage {
  return { type: 'highlight', id, code: `code-${id}`, fileName: `f${id}.ts` };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** run 由测试逐个放行，能精确断言「第几个任务真的开跑了」。 */
function harness() {
  const started: number[] = [];
  const emitted: HighlightWorkerResponse[] = [];
  const resolvers = new Map<number, (html: string | null) => void>();

  const queue = createHighlightQueue({
    run: (message) => {
      started.push(message.id);
      return new Promise<string | null>((resolve) => resolvers.set(message.id, resolve));
    },
    emit: (response) => emitted.push(response),
    yieldToTasks: () => Promise.resolve(),
  });

  return {
    queue,
    started,
    emitted,
    async finish(id: number, html: string | null = `<${id}>`) {
      const resolve = resolvers.get(id);
      if (!resolve) throw new Error(`任务 ${id} 尚未开始`);
      resolvers.delete(id);
      resolve(html);
      await tick();
    },
  };
}

describe('createHighlightQueue', () => {
  test('串行执行：前一个没完成，后一个不开跑', async () => {
    const h = harness();
    h.queue.handle(ask(1));
    h.queue.handle(ask(2));
    await tick();
    expect(h.started).toEqual([1]);

    await h.finish(1);
    expect(h.emitted).toEqual([{ id: 1, html: '<1>' }]);
    expect(h.started).toEqual([1, 2]);
  });

  test('排队中的请求被取消：从不执行，也不回包', async () => {
    const h = harness();
    h.queue.handle(ask(1));
    h.queue.handle(ask(2));
    h.queue.handle(ask(3));
    h.queue.handle({ type: 'cancel', id: 2 });
    await tick();

    await h.finish(1);
    // 2 已出队，直接轮到 3
    expect(h.started).toEqual([1, 3]);
    await h.finish(3);
    expect(h.emitted.map((r) => r.id)).toEqual([1, 3]);
  });

  test('任务开跑前才出队：整批入队后到达的取消仍然来得及', async () => {
    const h = harness();
    h.queue.handle(ask(1));
    h.queue.handle(ask(2));
    // 1 还没开跑（drain 先让出宏任务），此时取消 1 应当让它根本不执行
    h.queue.handle({ type: 'cancel', id: 1 });
    await tick();

    expect(h.started).toEqual([2]);
    await h.finish(2);
    expect(h.emitted).toEqual([{ id: 2, html: '<2>' }]);
  });

  test('执行中的请求被取消：结果不回包，队列继续走', async () => {
    const h = harness();
    h.queue.handle(ask(1));
    h.queue.handle(ask(2));
    await tick();
    h.queue.handle({ type: 'cancel', id: 1 });

    await h.finish(1);
    expect(h.emitted).toEqual([]);
    expect(h.started).toEqual([1, 2]);

    await h.finish(2);
    expect(h.emitted).toEqual([{ id: 2, html: '<2>' }]);
  });

  test('取消未知 id 不影响在途请求', async () => {
    const h = harness();
    h.queue.handle(ask(1));
    await tick();
    h.queue.handle({ type: 'cancel', id: 99 });

    await h.finish(1);
    expect(h.emitted).toEqual([{ id: 1, html: '<1>' }]);
  });

  test('队列排空后新请求重新起一轮', async () => {
    const h = harness();
    h.queue.handle(ask(1));
    await tick();
    await h.finish(1);

    h.queue.handle(ask(2));
    await tick();
    expect(h.started).toEqual([1, 2]);
    await h.finish(2);
    expect(h.emitted.map((r) => r.id)).toEqual([1, 2]);
  });

  test('run 失败按未高亮回包，不卡住后续任务', async () => {
    const failures = new Set([1]);
    const emitted: HighlightWorkerResponse[] = [];
    const queue = createHighlightQueue({
      run: (message) =>
        failures.has(message.id) ? Promise.reject(new Error('boom')) : Promise.resolve('<ok>'),
      emit: (response) => emitted.push(response),
      yieldToTasks: () => Promise.resolve(),
    });

    queue.handle(ask(1));
    queue.handle(ask(2));
    await tick();

    expect(emitted).toEqual([
      { id: 1, html: null },
      { id: 2, html: '<ok>' },
    ]);
  });
});
