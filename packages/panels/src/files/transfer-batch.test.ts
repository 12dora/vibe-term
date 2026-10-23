import { describe, expect, test } from 'bun:test';
import {
  BATCH_CONCURRENCY_RELAY,
  BATCH_CONCURRENCY_SELF,
  BATCH_STREAM_BUDGET,
  type BatchItemIo,
  type StreamPlan,
  batchConcurrency,
  runTransferBatch,
  streamsPerFile,
} from './transfer-batch';
import { BatchProgress } from './transfer-progress';

interface Deferred {
  resolve: () => void;
  reject: (error: unknown) => void;
  promise: Promise<void>;
}

function deferred(): Deferred {
  let resolve = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

const SELF_STREAMS: StreamPlan = { budget: 4, perFileMax: 4 };
const RELAY_STREAMS: StreamPlan = { budget: 4, perFileMax: 2 };

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(count: number) {
  const progress = new BatchProgress(
    'upload',
    Array.from({ length: count }, (_, i) => ({ name: `f${i}`, size: 100 }))
  );
  const gates = Array.from({ length: count }, deferred);
  const started: number[] = [];
  const streamsSeen: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const controller = new AbortController();
  const run = async (index: number, io: BatchItemIo) => {
    started.push(index);
    streamsSeen[index] = io.streams;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    io.signal.addEventListener('abort', () => gates[index]?.reject(new Error('aborted')));
    try {
      await gates[index]?.promise;
    } finally {
      inFlight -= 1;
    }
  };
  return { progress, gates, started, streamsSeen, controller, run, max: () => maxInFlight };
}

describe('batchConcurrency', () => {
  test('本机 3 个、经中继 2 个', () => {
    expect(batchConcurrency(false)).toBe(BATCH_CONCURRENCY_SELF);
    expect(batchConcurrency(true)).toBe(BATCH_CONCURRENCY_RELAY);
    expect(BATCH_CONCURRENCY_SELF).toBe(3);
    expect(BATCH_CONCURRENCY_RELAY).toBe(2);
  });
});

describe('流预算', () => {
  test('预算均分给同时在跑的文件，至少 1 条、不超过单文件上限', () => {
    expect([1, 2, 3, 4, 7].map((peers) => streamsPerFile(SELF_STREAMS, peers))).toEqual([
      4, 2, 1, 1, 1,
    ]);
    expect([1, 2, 3].map((peers) => streamsPerFile(RELAY_STREAMS, peers))).toEqual([2, 2, 1]);
    expect(streamsPerFile(SELF_STREAMS, 0)).toBe(4);
  });

  test('总预算 4：给 HTTP/1.1 每主机 6 个连接留出普通请求的余量', () => {
    expect(BATCH_STREAM_BUDGET).toBe(4);
    expect(BATCH_STREAM_BUDGET).toBeLessThan(6);
  });
});

describe('runTransferBatch', () => {
  test('同时在途的条目不超过并发上限，空出来的位置被后面的补上', async () => {
    const s = setup(6);
    const done = runTransferBatch({
      progress: s.progress,
      items: [0, 1, 2, 3, 4, 5],
      concurrency: 3,
      streams: SELF_STREAMS,
      signal: s.controller.signal,
      run: s.run,
    });
    await tick();
    expect(s.started).toEqual([0, 1, 2]);

    s.gates[1]?.resolve();
    await tick();
    expect(s.started).toEqual([0, 1, 2, 3]);

    for (const gate of s.gates) gate.resolve();
    const outcomes = await done;
    expect(s.max()).toBe(3);
    expect(outcomes.map((o) => o.status)).toEqual(Array(6).fill('done'));
    expect(s.progress.view().itemsDone).toBe(6);
  });

  test('并发数多于条目数时只开需要的工作者', async () => {
    const s = setup(2);
    const done = runTransferBatch({
      progress: s.progress,
      items: [0, 1],
      concurrency: 3,
      streams: SELF_STREAMS,
      signal: s.controller.signal,
      run: s.run,
    });
    await tick();
    expect(s.started).toEqual([0, 1]);
    for (const gate of s.gates) gate.resolve();
    await done;
  });

  test('取消：中止在途条目，没开始的直接记为已取消，不再启动新条目', async () => {
    const s = setup(5);
    const done = runTransferBatch({
      progress: s.progress,
      items: [0, 1, 2, 3, 4],
      concurrency: 2,
      streams: SELF_STREAMS,
      signal: s.controller.signal,
      run: s.run,
    });
    await tick();
    s.controller.abort();
    const outcomes = await done;

    expect(s.started).toEqual([0, 1]);
    expect(outcomes.map((o) => o.status)).toEqual(Array(5).fill('cancelled'));
    const view = s.progress.view();
    expect(view.rows.map((row) => row.stage)).toEqual(Array(5).fill('cancelled'));
  });

  test('部分失败：失败条目带原始错误，其余照常完成', async () => {
    const s = setup(4);
    const boom = new Error('boom');
    const done = runTransferBatch({
      progress: s.progress,
      items: [0, 1, 2, 3],
      concurrency: 2,
      streams: SELF_STREAMS,
      signal: s.controller.signal,
      run: s.run,
    });
    await tick();
    s.gates[0]?.reject(boom);
    s.gates[1]?.resolve();
    await tick();
    s.gates[2]?.resolve();
    s.gates[3]?.resolve();
    const outcomes = await done;

    expect(outcomes[0]).toEqual({ status: 'failed', error: boom });
    expect(outcomes.slice(1).map((o) => o.status)).toEqual(['done', 'done', 'done']);
    const view = s.progress.view();
    expect(view.itemsDone).toBe(3);
    expect(view.itemsFailed).toBe(1);
  });

  test('回调汇入进度：leg / 权重 / 路径，状态切换要求立即刷新', async () => {
    const progress = new BatchProgress('upload', [{ name: 'a', size: 100 }]);
    const changes: boolean[] = [];
    await runTransferBatch({
      progress,
      items: ['a'],
      concurrency: 1,
      streams: SELF_STREAMS,
      signal: new AbortController().signal,
      onChange: (immediate) => changes.push(immediate),
      run: async (_item, io) => {
        io.onPath('direct');
        io.onLegWeights([1, 0]);
        io.onLeg(1, { pct: 50, bytes: 50, totalBytes: 100 });
        expect(progress.view().fraction).toBe(0.5);
        io.onLeg(1, { pct: 100, bytes: 100, totalBytes: 100 });
      },
    });
    expect(progress.view().path).toBe('direct');
    // 启动、路径、权重(节流)、50%(节流)、100%、完成、收尾
    expect(changes).toEqual([true, true, false, false, true, true, true]);
    expect(progress.view().pct).toBe(100);
  });

  test('单个文件独占预算，用满单文件上限', async () => {
    const s = setup(1);
    const done = runTransferBatch({
      progress: s.progress,
      items: [0],
      concurrency: 3,
      streams: SELF_STREAMS,
      signal: s.controller.signal,
      run: s.run,
    });
    await tick();
    s.gates[0]?.resolve();
    await done;
    expect(s.streamsSeen).toEqual([4]);
  });

  test('3 个文件同时跑时每个 1 条流，合计不超过预算 4', async () => {
    const s = setup(8);
    const done = runTransferBatch({
      progress: s.progress,
      items: [0, 1, 2, 3, 4, 5, 6, 7],
      concurrency: 3,
      streams: SELF_STREAMS,
      signal: s.controller.signal,
      run: s.run,
    });
    await tick();
    expect(s.streamsSeen).toEqual([1, 1, 1]);
    for (let round = 0; round < 8; round++) {
      for (const gate of s.gates) gate.resolve();
      await tick();
    }
    await done;
    // 3+3 个文件满员时各 1 条；最后只剩 2 个文件，预算改为各分 2 条
    expect(s.streamsSeen).toEqual([1, 1, 1, 1, 1, 1, 2, 2]);
  });

  test('文件数少于并发上限时按实际文件数分预算', async () => {
    const s = setup(2);
    const done = runTransferBatch({
      progress: s.progress,
      items: [0, 1],
      concurrency: 3,
      streams: SELF_STREAMS,
      signal: s.controller.signal,
      run: s.run,
    });
    await tick();
    for (const gate of s.gates) gate.resolve();
    await done;
    expect(s.streamsSeen).toEqual([2, 2]);
  });

  test('经中继：2 个文件各 2 条流，合计 4', async () => {
    const s = setup(5);
    const done = runTransferBatch({
      progress: s.progress,
      items: [0, 1, 2, 3, 4],
      concurrency: 2,
      streams: RELAY_STREAMS,
      signal: s.controller.signal,
      run: s.run,
    });
    await tick();
    expect(s.streamsSeen).toEqual([2, 2]);
    for (let round = 0; round < 5; round++) {
      for (const gate of s.gates) gate.resolve();
      await tick();
    }
    await done;
    expect(s.streamsSeen).toEqual(Array(5).fill(2));
  });

  test('信号一开始就已中止：一个条目都不启动', async () => {
    const s = setup(3);
    s.controller.abort();
    const outcomes = await runTransferBatch({
      progress: s.progress,
      items: [0, 1, 2],
      concurrency: 3,
      streams: SELF_STREAMS,
      signal: s.controller.signal,
      run: s.run,
    });
    expect(s.started).toEqual([]);
    expect(outcomes.map((o) => o.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });
});
