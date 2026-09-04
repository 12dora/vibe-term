import { afterEach, describe, expect, test } from 'bun:test';
import { beginAuthTransition, endAuthTransition } from '@/auth/auth-transition';
import { ApiClient } from '@tmex/api-client/client';
import type { RelayMetricsResponse } from '@tmex/api-client/relay/metrics-types';
import { relayMetricsFixture } from './relay-metrics-fixture';
import {
  type RelayMetricsApi,
  acquireRelayMetricsPolling,
  createRelayMetricsApi,
  getRelayMetricsState,
  refreshRelayMetrics,
  resetRelayMetricsStateForTest,
  setRelayMetricsStateForTest,
} from './relay-metrics-store';

const METRICS: RelayMetricsResponse = relayMetricsFixture();

function apiWith(route: (path: string) => Response): { api: RelayMetricsApi; paths: string[] } {
  const paths: string[] = [];
  const client = new ApiClient('', (url) => {
    paths.push(url);
    return Promise.resolve(route(url));
  });
  return { api: createRelayMetricsApi(client), paths };
}

function ok(): (path: string) => Response {
  return () => new Response(JSON.stringify(METRICS), { status: 200 });
}

function fails(status: number, code = 'X'): (path: string) => Response {
  return () => new Response(JSON.stringify({ error: { code, message: 'boom' } }), { status });
}

afterEach(() => {
  resetRelayMetricsStateForTest();
  endAuthTransition();
});

describe('refreshRelayMetrics', () => {
  test('成功：采样进 store，错误位清空', async () => {
    const { api, paths } = apiWith(ok());
    await refreshRelayMetrics(api);
    const state = getRelayMetricsState();
    expect(paths).toEqual(['/api/relay/metrics']);
    expect(state.data).toEqual(METRICS);
    expect(state.loading).toBe(false);
    expect(state.lastError).toBeNull();
    expect(state.unavailable).toBe(false);
    expect(state.loadedAt).not.toBeNull();
  });

  test('500：只记错误，已有的采样留着不清（面板改摆「已过期」）', async () => {
    setRelayMetricsStateForTest({ data: METRICS });
    const { api } = apiWith(fails(500));
    await refreshRelayMetrics(api);
    const state = getRelayMetricsState();
    expect(state.data).toEqual(METRICS);
    expect(state.lastError).toBe('boom');
    expect(state.unavailable).toBe(false);
    expect(state.loading).toBe(false);
  });

  test('404：角色缺席，整块判不可用并清数据', async () => {
    setRelayMetricsStateForTest({ data: METRICS });
    const { api } = apiWith(fails(404));
    await refreshRelayMetrics(api);
    expect(getRelayMetricsState()).toMatchObject({
      data: null,
      unavailable: true,
      lastError: null,
    });
  });

  test('401：未登录同样按不可用处理，不当成加载失败', async () => {
    const { api } = apiWith(fails(401));
    await refreshRelayMetrics(api);
    expect(getRelayMetricsState()).toMatchObject({ unavailable: true, lastError: null });
  });

  test('单飞：并发的两次刷新只打一次请求', async () => {
    const { api, paths } = apiWith(ok());
    await Promise.all([refreshRelayMetrics(api), refreshRelayMetrics(api)]);
    expect(paths).toHaveLength(1);
  });

  test('鉴权切换期间不发请求', async () => {
    beginAuthTransition();
    const { api, paths } = apiWith(ok());
    await refreshRelayMetrics(api);
    expect(paths).toHaveLength(0);
    expect(getRelayMetricsState().data).toBeNull();
  });
});

describe('acquireRelayMetricsPolling', () => {
  function harness(hidden = false) {
    const calls: number[] = [];
    let tick: (() => void) | null = null;
    let onVisible: (() => void) | null = null;
    const release = acquireRelayMetricsPolling({
      intervalMs: 5_000,
      refresh: () => calls.push(calls.length),
      schedule: (fn) => {
        tick = fn;
        return () => {
          tick = null;
        };
      },
      delay: (fn) => {
        fn();
        return () => undefined;
      },
      visibility: {
        hidden: () => hidden,
        subscribe: (fn) => {
          onVisible = fn;
          return () => {
            onVisible = null;
          };
        },
      },
    });
    return { calls, fire: () => tick?.(), wake: () => onVisible?.(), release };
  }

  test('取用即刷新一次，之后每 5 秒一拍', () => {
    const { calls, fire, release } = harness();
    expect(calls).toHaveLength(1);
    fire();
    fire();
    expect(calls).toHaveLength(3);
    release();
  });

  test('页面隐藏时跳拍', () => {
    const { calls, fire, release } = harness(true);
    expect(calls).toHaveLength(1);
    fire();
    fire();
    expect(calls).toHaveLength(1);
    release();
  });

  test('归还后定时器不再触发', () => {
    const { calls, fire, release } = harness();
    release();
    fire();
    expect(calls).toHaveLength(1);
  });
});
