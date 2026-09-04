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
  isRelayMetricsHalted,
  probeRelayMetrics,
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
    expect(state.availability).toBe('available');
    expect(state.data).toEqual(METRICS);
    expect(state.loading).toBe(false);
    expect(state.lastError).toBeNull();
    expect(state.loadedAt).not.toBeNull();
  });

  test('500：只记错误，已有的采样留着不清（面板改摆「已过期」）', async () => {
    setRelayMetricsStateForTest({ data: METRICS });
    const { api } = apiWith(fails(500));
    await refreshRelayMetrics(api);
    const state = getRelayMetricsState();
    expect(state.data).toEqual(METRICS);
    expect(state.lastError).toBe('boom');
    expect(state.availability).toBe('unknown');
    expect(state.loading).toBe(false);
  });

  test('404：角色缺席，整块判不可用并清数据', async () => {
    setRelayMetricsStateForTest({ data: METRICS });
    const { api } = apiWith(fails(404));
    await refreshRelayMetrics(api);
    expect(getRelayMetricsState()).toMatchObject({
      data: null,
      availability: 'unavailable',
      lastError: null,
    });
  });

  test('401：未登录同样按不可用处理，不当成加载失败', async () => {
    const { api } = apiWith(fails(401));
    await refreshRelayMetrics(api);
    expect(getRelayMetricsState()).toMatchObject({ availability: 'unauthorized', lastError: null });
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

  test('落到终态之后不再发请求，直到重探', async () => {
    setRelayMetricsStateForTest({ availability: 'unavailable' });
    const { api, paths } = apiWith(ok());
    await refreshRelayMetrics(api);
    expect(paths).toHaveLength(0);

    probeRelayMetrics();
    expect(getRelayMetricsState().availability).toBe('unknown');
    await refreshRelayMetrics(api);
    expect(paths).toHaveLength(1);
  });
});

describe('isRelayMetricsHalted / probeRelayMetrics', () => {
  test('只有 404 与 401 算终态', () => {
    expect(isRelayMetricsHalted('unknown')).toBe(false);
    expect(isRelayMetricsHalted('available')).toBe(false);
    expect(isRelayMetricsHalted('unavailable')).toBe(true);
    expect(isRelayMetricsHalted('unauthorized')).toBe(true);
  });

  test('重探把终态清回 unknown，其余状态不动', () => {
    for (const availability of ['unavailable', 'unauthorized'] as const) {
      resetRelayMetricsStateForTest();
      setRelayMetricsStateForTest({ availability });
      probeRelayMetrics();
      expect(getRelayMetricsState().availability).toBe('unknown');
    }
    resetRelayMetricsStateForTest();
    setRelayMetricsStateForTest({ availability: 'available' });
    probeRelayMetrics();
    expect(getRelayMetricsState().availability).toBe('available');
  });
});

describe('acquireRelayMetricsPolling', () => {
  interface Harness {
    calls: number[];
    fire: () => void;
    wake: () => void;
  }

  /** 回路是模块级单例：一次泄漏的引用计数会让后面每个用例都拿不到新回路，所以归还写在 finally 里。 */
  function withPolling(hidden: () => boolean, run: (harness: Harness) => void): void {
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
        hidden,
        subscribe: (fn) => {
          onVisible = fn;
          return () => {
            onVisible = null;
          };
        },
      },
    });
    try {
      run({ calls, fire: () => tick?.(), wake: () => onVisible?.() });
    } finally {
      release();
    }
  }

  const visible = () => false;

  test('取用即刷新一次，之后每 5 秒一拍', () => {
    withPolling(visible, ({ calls, fire }) => {
      expect(calls).toHaveLength(1);
      fire();
      fire();
      expect(calls).toHaveLength(3);
    });
  });

  test('取用时页面已隐藏：首拍与兜底拍都不打', () => {
    withPolling(
      () => true,
      ({ calls, fire }) => {
        expect(calls).toHaveLength(0);
        fire();
        fire();
        expect(calls).toHaveLength(0);
      }
    );
  });

  test('回到前台补一拍，之后恢复正常节奏', () => {
    let hidden = true;
    withPolling(
      () => hidden,
      ({ calls, fire, wake }) => {
        expect(calls).toHaveLength(0);
        hidden = false;
        wake();
        expect(calls).toHaveLength(1);
        fire();
        expect(calls).toHaveLength(2);
      }
    );
  });

  test('归还后定时器不再触发', () => {
    const calls: number[] = [];
    const timer: { tick: (() => void) | null } = { tick: null };
    const release = acquireRelayMetricsPolling({
      intervalMs: 5_000,
      refresh: () => calls.push(calls.length),
      schedule: (fn) => {
        timer.tick = fn;
        return () => {
          timer.tick = null;
        };
      },
      delay: (fn) => {
        fn();
        return () => undefined;
      },
      visibility: { hidden: visible, subscribe: () => () => undefined },
    });
    expect(calls).toHaveLength(1);
    release();
    timer.tick?.();
    expect(calls).toHaveLength(1);
  });
});
