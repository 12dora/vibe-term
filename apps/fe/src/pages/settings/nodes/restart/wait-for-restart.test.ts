// 重启等待核心：注入 fetch + 假时钟，不依赖真实定时器；超时与取消两条路径用真实的短定时器跑。

import { describe, expect, test } from 'bun:test';
import type { FetchLike } from '@tmex/api-client';
import { probeHealth, readStartedAt, waitForRestart } from './wait-for-restart';

type Step = number | 'down';

interface HealthScript {
  fetchImpl: FetchLike;
  probes: () => number;
  lastInit: () => RequestInit | undefined;
}

/** 按脚本回放 `/healthz`：数字 = 该次返回的 startedAt，'down' = 连接失败。脚本用尽后重复最后一项。 */
function healthScript(script: Step[]): HealthScript {
  let index = 0;
  let init: RequestInit | undefined;
  return {
    fetchImpl: (_path, requestInit) => {
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      init = requestInit;
      if (step === 'down') return Promise.reject(new TypeError('connection refused'));
      return Promise.resolve(Response.json({ status: 'ok', startedAt: step }));
    },
    probes: () => index,
    lastInit: () => init,
  };
}

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

describe('waitForRestart', () => {
  test('startedAt 变了即视为重启完成；中间的连接失败是正常态', async () => {
    const script = healthScript(['down', 'down', 200]);
    const clock = fakeClock();
    const outcome = await waitForRestart({
      previousStartedAt: 100,
      fetchImpl: script.fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 1000,
      timeoutMs: 60_000,
    });
    expect(outcome).toBe('restarted');
    expect(script.probes()).toBe(3);
  });

  test('每次探活都带 no-store 与自己的 AbortSignal', async () => {
    const script = healthScript([200]);
    const clock = fakeClock();
    await waitForRestart({
      previousStartedAt: 100,
      fetchImpl: script.fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    });
    const init = script.lastInit();
    expect(init?.cache).toBe('no-store');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('startedAt 始终不变 → 超时（不会把老进程当成新进程）', async () => {
    const script = healthScript([100]);
    const clock = fakeClock();
    const outcome = await waitForRestart({
      previousStartedAt: 100,
      fetchImpl: script.fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 1000,
      timeoutMs: 5000,
    });
    expect(outcome).toBe('timeout');
    // 5 次探活后时钟正好走到截止时刻，循环顶端直接判超时。
    expect(script.probes()).toBe(5);
  });

  test('提交前没读到 startedAt：必须先看到一次不可达，再看到健康响应才算重启', async () => {
    const script = healthScript([100, 100, 'down', 200]);
    const clock = fakeClock();
    const outcome = await waitForRestart({
      previousStartedAt: null,
      fetchImpl: script.fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 1000,
      timeoutMs: 60_000,
    });
    expect(outcome).toBe('restarted');
    expect(clock.now()).toBe(3000);
  });

  test('healthz 缺 startedAt 字段时按「不可达 + 健康」规则判定，不会误判成重启', async () => {
    const clock = fakeClock();
    const outcome = await waitForRestart({
      previousStartedAt: 100,
      fetchImpl: () => Promise.resolve(Response.json({ status: 'ok' })),
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 1000,
      timeoutMs: 3000,
    });
    expect(outcome).toBe('timeout');
  });

  test('onElapsed 汇报已等待时长', async () => {
    const script = healthScript(['down', 'down', 200]);
    const clock = fakeClock();
    const elapsed: number[] = [];
    await waitForRestart({
      previousStartedAt: 100,
      fetchImpl: script.fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 1000,
      timeoutMs: 60_000,
      onElapsed: (ms) => elapsed.push(ms),
    });
    expect(elapsed).toEqual([0, 1000]);
  });

  test('已 abort 的 signal 一次请求都不发', async () => {
    const script = healthScript([200]);
    const controller = new AbortController();
    controller.abort();
    const outcome = await waitForRestart({
      previousStartedAt: 100,
      fetchImpl: script.fetchImpl,
      signal: controller.signal,
    });
    expect(outcome).toBe('aborted');
    expect(script.probes()).toBe(0);
  });

  test('等待中 abort（组件卸载）立即结束，并中断在途请求', async () => {
    const controller = new AbortController();
    const aborted: boolean[] = [];
    const outcome = await waitForRestart({
      previousStartedAt: 100,
      // 请求永远挂着，只有被 abort 才结束——反代把 /healthz 拖住就是这个形状。
      fetchImpl: (_path, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted.push(true);
            reject(new Error('aborted'));
          });
          controller.abort();
        }),
      signal: controller.signal,
      intervalMs: 5,
      timeoutMs: 1000,
    });
    expect(outcome).toBe('aborted');
    expect(aborted).toEqual([true]);
  });

  test('单个请求被总截止时间兜住：挂死的 /healthz 不会拖过 timeoutMs', async () => {
    let requests = 0;
    const abortedRequests: number[] = [];
    const startedAt = Date.now();
    const outcome = await waitForRestart({
      previousStartedAt: 100,
      fetchImpl: (_path, init) =>
        new Promise((_resolve, reject) => {
          requests += 1;
          init?.signal?.addEventListener('abort', () => {
            abortedRequests.push(requests);
            reject(new Error('aborted'));
          });
        }),
      intervalMs: 5,
      timeoutMs: 60,
    });
    expect(outcome).toBe('timeout');
    expect(requests).toBe(1);
    expect(abortedRequests).toEqual([1]);
    // 没有 per-request 预算的话这里会一直挂着，永远回不来。
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});

describe('probeHealth / readStartedAt', () => {
  test('2xx 带 startedAt', async () => {
    const result = await probeHealth(
      () => Promise.resolve(Response.json({ status: 'ok', startedAt: 1700 })),
      1000
    );
    expect(result).toEqual({ ok: true, startedAt: 1700 });
  });

  test('非 2xx 与网络错误都是不可达，不抛', async () => {
    expect(
      await probeHealth(() => Promise.resolve(new Response('', { status: 503 })), 1000)
    ).toEqual({ ok: false, startedAt: null });
    expect(await probeHealth(() => Promise.reject(new TypeError('refused')), 1000)).toEqual({
      ok: false,
      startedAt: null,
    });
  });

  test('响应体不是 JSON 时算健康但没有 startedAt', async () => {
    expect(await probeHealth(() => Promise.resolve(new Response('ok')), 1000)).toEqual({
      ok: true,
      startedAt: null,
    });
  });

  test('readStartedAt 直接取数值，读不到给 null', async () => {
    expect(await readStartedAt(() => Promise.resolve(Response.json({ startedAt: 42 })))).toBe(42);
    expect(await readStartedAt(() => Promise.reject(new Error('down')))).toBeNull();
  });
});
