import { describe, expect, test } from 'bun:test';
import { createHighlightClient } from './highlight-client';
import type { HighlightWorkerRequest, HighlightWorkerResponse } from './highlight-protocol';

type Listener = (event: unknown) => void;

class FakeWorker {
  readonly received: HighlightWorkerRequest[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Listener[]>();

  postMessage(message: HighlightWorkerRequest): void {
    this.received.push(message);
  }

  addEventListener(type: string, handler: Listener): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(handler);
    this.listeners.set(type, bucket);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: HighlightWorkerResponse): void {
    for (const handler of this.listeners.get('message') ?? []) {
      handler({ data: response });
    }
  }

  crash(): void {
    for (const handler of this.listeners.get('error') ?? []) {
      handler({});
    }
  }
}

function setup(highlightOnMainThread?: (code: string, fileName: string) => Promise<string | null>) {
  const worker = new FakeWorker();
  const client = createHighlightClient({
    spawnWorker: () => worker as never,
    highlightOnMainThread: highlightOnMainThread ?? (() => Promise.resolve('<main>')),
  });
  return { worker, client };
}

describe('高亮请求分发', () => {
  test('worker 回包按 id 交付', () => {
    const { worker, client } = setup();
    const seen: (string | null)[] = [];
    client.request('const a = 1;', 'a.ts', (html) => seen.push(html));
    expect(worker.received).toEqual([
      { type: 'highlight', id: 1, code: 'const a = 1;', fileName: 'a.ts' },
    ]);
    worker.respond({ id: 1, html: '<span>a</span>' });
    expect(seen).toEqual(['<span>a</span>']);
  });

  test('取消后的回包被丢弃，并把取消发给 worker', () => {
    const { worker, client } = setup();
    const seen: (string | null)[] = [];
    const cancel = client.request('old', 'old.ts', (html) => seen.push(html));
    cancel();
    expect(worker.received.at(-1)).toEqual({ type: 'cancel', id: 1 });
    worker.respond({ id: 1, html: '<stale>' });
    expect(seen).toEqual([]);
  });

  test('重复取消只发一次 cancel', () => {
    const { worker, client } = setup();
    const cancel = client.request('old', 'old.ts', () => undefined);
    cancel();
    cancel();
    expect(worker.received.filter((m) => m.type === 'cancel')).toEqual([{ type: 'cancel', id: 1 }]);
  });

  test('切文件时旧请求当场从 worker 队列撤掉，最新请求不排在它后面', () => {
    const { worker, client } = setup();
    const cancelOld = client.request('big-old', 'old.ts', () => undefined);
    cancelOld();
    client.request('new', 'new.ts', () => undefined);
    expect(worker.received).toEqual([
      { type: 'highlight', id: 1, code: 'big-old', fileName: 'old.ts' },
      { type: 'cancel', id: 1 },
      { type: 'highlight', id: 2, code: 'new', fileName: 'new.ts' },
    ]);
  });

  test('切文件后旧回包不覆盖新请求', () => {
    const { worker, client } = setup();
    const seen: (string | null)[] = [];
    const cancel = client.request('old', 'old.ts', () => seen.push('old'));
    cancel();
    client.request('new', 'new.ts', () => seen.push('new'));
    worker.respond({ id: 1, html: '<stale>' });
    worker.respond({ id: 2, html: '<fresh>' });
    expect(seen).toEqual(['new']);
  });

  test('未知 id 的回包被忽略', () => {
    const { worker, client } = setup();
    const seen: unknown[] = [];
    client.request('a', 'a.ts', (html) => seen.push(html));
    worker.respond({ id: 999, html: '<other>' });
    expect(seen).toEqual([]);
    worker.respond({ id: 1, html: '<ok>' });
    expect(seen).toEqual(['<ok>']);
  });
});

describe('worker 不可用时的兜底', () => {
  test('无法创建 worker 时走主线程', async () => {
    const client = createHighlightClient({
      spawnWorker: () => null,
      highlightOnMainThread: () => Promise.resolve('<main>'),
    });
    const html = await new Promise<string | null>((resolve) => {
      client.request('a', 'a.ts', resolve);
    });
    expect(html).toBe('<main>');
  });

  test('worker 报错后在途请求改走主线程，且 worker 被终止', async () => {
    const { worker, client } = setup();
    const done = new Promise<string | null>((resolve) => {
      client.request('a', 'a.ts', resolve);
    });
    worker.crash();
    expect(worker.terminated).toBe(true);
    expect(await done).toBe('<main>');
  });

  test('主线程兜底失败时按未高亮处理', async () => {
    const client = createHighlightClient({
      spawnWorker: () => null,
      highlightOnMainThread: () => Promise.reject(new Error('boom')),
    });
    const html = await new Promise<string | null>((resolve) => {
      client.request('a', 'a.ts', resolve);
    });
    expect(html).toBeNull();
  });

  test('dispose 后不再交付结果', () => {
    const { worker, client } = setup();
    const seen: unknown[] = [];
    client.request('a', 'a.ts', (html) => seen.push(html));
    client.dispose();
    worker.respond({ id: 1, html: '<late>' });
    expect(seen).toEqual([]);
    expect(worker.terminated).toBe(true);
  });
});
