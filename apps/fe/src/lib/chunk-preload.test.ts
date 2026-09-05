// chunk 预热的调度逻辑：没有 DOM 也没有真 chunk，这里把 idle 宿主和 loader 都换成假的，
// 只验调度本身——空闲优先/定时兜底、逐个排队、去重、失败静默、取消。

import { describe, expect, test } from 'bun:test';
import {
  type ChunkPreloadTarget,
  IDLE_FALLBACK_DELAY_MS,
  IDLE_TIMEOUT_MS,
  type IdleHost,
  preloadChunk,
  scheduleIdle,
  startIdleChunkPreload,
} from './chunk-preload';

function idleHost() {
  const calls: { run: () => void; timeout: number | undefined }[] = [];
  const cancelled: number[] = [];
  const host: IdleHost = {
    requestIdleCallback: (run, options) => {
      calls.push({ run, timeout: options?.timeout });
      return calls.length;
    },
    cancelIdleCallback: (handle) => {
      cancelled.push(handle);
    },
    setTimeout: () => {
      throw new Error('不该退回 setTimeout');
    },
    clearTimeout: () => undefined,
  };
  return { host, calls, cancelled };
}

function timeoutHost() {
  const calls: { run: () => void; ms: number }[] = [];
  const cleared: number[] = [];
  const host: IdleHost = {
    setTimeout: (run, ms) => {
      calls.push({ run, ms });
      return calls.length;
    },
    clearTimeout: (handle) => {
      cleared.push(handle as unknown as number);
    },
  };
  return { host, calls, cleared };
}

describe('scheduleIdle', () => {
  test('有 requestIdleCallback 时走空闲队列，并带兜底期限', () => {
    const { host, calls } = idleHost();
    let ran = false;
    scheduleIdle(() => {
      ran = true;
    }, host);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeout).toBe(IDLE_TIMEOUT_MS);
    expect(ran).toBe(false);
    calls[0]?.run();
    expect(ran).toBe(true);
  });

  test('返回的取消函数取消对应的空闲回调', () => {
    const { host, cancelled } = idleHost();
    const cancel = scheduleIdle(() => undefined, host);
    expect(cancelled).toEqual([]);
    cancel();
    expect(cancelled).toEqual([1]);
  });

  test('没有 requestIdleCallback 时退回定时器，取消即 clearTimeout', () => {
    const { host, calls, cleared } = timeoutHost();
    const cancel = scheduleIdle(() => undefined, host);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.ms).toBe(IDLE_FALLBACK_DELAY_MS);
    cancel();
    expect(cleared).toEqual([1]);
  });
});

/** 手动排队的假调度器：把 run 攒起来，测试里自己决定什么时候放行。 */
function manualSchedule() {
  const pending: (() => void)[] = [];
  const cancels: number[] = [];
  const schedule = (run: () => void) => {
    pending.push(run);
    const index = pending.length;
    return () => cancels.push(index);
  };
  const flush = () => {
    const run = pending.shift();
    run?.();
  };
  return { schedule, pending, cancels, flush };
}

/** 可手动结算的假 loader */
function fakeLoader() {
  let settle: ((ok: boolean) => void) | undefined;
  let started = 0;
  const load: ChunkPreloadTarget = () => {
    started += 1;
    return new Promise((resolve, reject) => {
      settle = (ok) => (ok ? resolve(undefined) : reject(new Error('chunk 404')));
    });
  };
  return {
    load,
    get started() {
      return started;
    },
    resolve: () => settle?.(true),
    reject: () => settle?.(false),
  };
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('preloadChunk', () => {
  test('同一个 loader 只发起一次', () => {
    const started = new Set<ChunkPreloadTarget>();
    const a = fakeLoader();
    preloadChunk(a.load, started);
    preloadChunk(a.load, started);
    expect(a.started).toBe(1);
  });

  test('预热失败静默，不抛出也不产生未处理的 rejection', async () => {
    const started = new Set<ChunkPreloadTarget>();
    const a = fakeLoader();
    preloadChunk(a.load, started);
    a.reject();
    await flushMicrotasks();
    expect(a.started).toBe(1);
  });
});

describe('startIdleChunkPreload', () => {
  test('逐个排队：一次空闲只发一个，上一个落地后才排下一个', async () => {
    const { schedule, flush } = manualSchedule();
    const [a, b, c] = [fakeLoader(), fakeLoader(), fakeLoader()];
    startIdleChunkPreload([a.load, b.load, c.load], schedule, new Set());

    flush();
    expect([a.started, b.started, c.started]).toEqual([1, 0, 0]);

    a.resolve();
    await flushMicrotasks();
    flush();
    expect([a.started, b.started, c.started]).toEqual([1, 1, 0]);

    b.resolve();
    await flushMicrotasks();
    flush();
    expect([a.started, b.started, c.started]).toEqual([1, 1, 1]);
  });

  test('某个 chunk 加载失败也继续排下一个（失败不打断队列）', async () => {
    const { schedule, flush } = manualSchedule();
    const [a, b] = [fakeLoader(), fakeLoader()];
    startIdleChunkPreload([a.load, b.load], schedule, new Set());

    flush();
    a.reject();
    await flushMicrotasks();
    flush();
    expect(b.started).toBe(1);
  });

  test('已被悬停预热过的 loader 直接跳过', () => {
    const started = new Set<ChunkPreloadTarget>();
    const { schedule, flush } = manualSchedule();
    const [a, b] = [fakeLoader(), fakeLoader()];
    preloadChunk(a.load, started);
    startIdleChunkPreload([a.load, b.load], schedule, started);

    flush();
    expect(a.started).toBe(1);
    expect(b.started).toBe(1);
  });

  test('队列排空后不再申请空闲片', async () => {
    const { schedule, pending, flush } = manualSchedule();
    const a = fakeLoader();
    startIdleChunkPreload([a.load], schedule, new Set());

    flush();
    a.resolve();
    await flushMicrotasks();
    expect(pending).toHaveLength(1);
    flush();
    expect(pending).toHaveLength(0);
  });

  test('取消后既不再发起 loader，也取消在途的空闲回调', async () => {
    const { schedule, cancels, flush } = manualSchedule();
    const [a, b] = [fakeLoader(), fakeLoader()];
    const cancel = startIdleChunkPreload([a.load, b.load], schedule, new Set());

    flush();
    a.resolve();
    await flushMicrotasks();
    cancel();
    flush();

    expect(b.started).toBe(0);
    expect(cancels.length).toBeGreaterThan(0);
  });
});
