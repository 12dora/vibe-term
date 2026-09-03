import { afterEach, describe, expect, test } from 'bun:test';
import { beginAuthTransition, endAuthTransition } from '@/auth/auth-transition';
import { ApiClient } from '@tmex/api-client/client';
import {
  RelayAdminApi,
  RelayApiError,
  type RelayStatusResponse,
} from '@tmex/api-client/relay/admin-api';
import {
  acquireRelayAdminPolling,
  classifyRelayFailure,
  getRelayAdminState,
  probeRelayAdmin,
  refreshRelayAdmin,
  resetRelayAdminStateForTest,
  setRelayAdminStateForTest,
} from './relay-status-store';

const STATUS: RelayStatusResponse = {
  config: {
    hasPassword: true,
    passwordEpoch: 2,
    minTokenEpoch: 1,
    defaultQuota: { maxNodes: 8, maxStreams: 16, bandwidthBytesPerSec: null },
  },
  tenants: [],
  totals: { tenants: 0, nodesOnline: 0, streams: 0, bytesIn: 0, bytesOut: 0 },
};

const HEALTH = { ok: true, version: '1.1.23', tenants: 0, nodesOnline: 0, uptimeMs: 1_000 };

type Route = (path: string) => Response;

function apiWith(route: Route): { api: RelayAdminApi; paths: string[] } {
  const paths: string[] = [];
  const client = new ApiClient('', (url) => {
    paths.push(url);
    return Promise.resolve(route(url));
  });
  return { api: new RelayAdminApi(client), paths };
}

function bothOk(): Route {
  return (path) =>
    new Response(JSON.stringify(path === '/api/relay/health' ? HEALTH : STATUS), { status: 200 });
}

function statusFails(status: number): Route {
  return (path) =>
    path === '/api/relay/health'
      ? new Response(JSON.stringify(HEALTH), { status: 200 })
      : new Response(JSON.stringify({ error: { code: 'X', message: 'boom' } }), { status });
}

afterEach(() => {
  resetRelayAdminStateForTest();
  endAuthTransition();
});

describe('classifyRelayFailure', () => {
  test('404 是角色缺席，401 是未登录，其余是错误', () => {
    expect(classifyRelayFailure(new RelayApiError('x', 'x', 404))).toBe('unavailable');
    expect(classifyRelayFailure(new RelayApiError('x', 'x', 401))).toBe('unauthorized');
    expect(classifyRelayFailure(new RelayApiError('x', 'x', 500))).toBe('error');
    expect(classifyRelayFailure(new Error('offline'))).toBe('error');
  });
});

describe('refreshRelayAdmin', () => {
  test('成功：status 与 health 一起进 store，availability 落 available', async () => {
    const { api, paths } = apiWith(bothOk());
    await refreshRelayAdmin(api);
    const state = getRelayAdminState();
    expect(state.availability).toBe('available');
    expect(state.status).toEqual(STATUS);
    expect(state.health).toEqual(HEALTH);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.loadedAt).not.toBeNull();
    expect(paths.sort()).toEqual(['/api/relay/health', '/api/relay/status']);
  });

  test('404：判定角色缺席，并把上一份数据清干净', async () => {
    setRelayAdminStateForTest({ availability: 'available', status: STATUS, health: HEALTH });
    const { api } = apiWith(statusFails(404));
    await refreshRelayAdmin(api);
    expect(getRelayAdminState()).toMatchObject({
      availability: 'unavailable',
      status: null,
      health: null,
      error: null,
      loading: false,
    });
  });

  test('401：判未登录，不算错误', async () => {
    const { api } = apiWith(statusFails(401));
    await refreshRelayAdmin(api);
    expect(getRelayAdminState()).toMatchObject({ availability: 'unauthorized', error: null });
  });

  test('500：只记错误，已经摆出来的租户表保留', async () => {
    setRelayAdminStateForTest({ availability: 'available', status: STATUS });
    const { api } = apiWith(statusFails(500));
    await refreshRelayAdmin(api);
    const state = getRelayAdminState();
    expect(state.availability).toBe('available');
    expect(state.status).toEqual(STATUS);
    expect(state.error).toBe('boom');
    expect(state.loading).toBe(false);
  });

  test('health 挂了不影响 status：留上一份健康块', async () => {
    setRelayAdminStateForTest({ health: HEALTH });
    const { api } = apiWith((path) =>
      path === '/api/relay/health'
        ? new Response('{}', { status: 500 })
        : new Response(JSON.stringify(STATUS), { status: 200 })
    );
    await refreshRelayAdmin(api);
    expect(getRelayAdminState()).toMatchObject({ availability: 'available', health: HEALTH });
  });

  test('单飞：并发的两次刷新只打一轮请求', async () => {
    const { api, paths } = apiWith(bothOk());
    await Promise.all([refreshRelayAdmin(api), refreshRelayAdmin(api)]);
    expect(paths).toHaveLength(2);
  });

  test('鉴权切换期间不发请求', async () => {
    beginAuthTransition();
    const { api, paths } = apiWith(bothOk());
    await refreshRelayAdmin(api);
    expect(paths).toHaveLength(0);
    expect(getRelayAdminState().availability).toBe('unknown');
  });
});

describe('probeRelayAdmin', () => {
  test('结论未定时打一次', async () => {
    const { api, paths } = apiWith(bothOk());
    probeRelayAdmin(api);
    await Promise.resolve();
    await Promise.resolve();
    expect(paths.length).toBeGreaterThan(0);
  });

  test('已确认可用 / 不可用后不再问', () => {
    for (const availability of ['available', 'unavailable'] as const) {
      resetRelayAdminStateForTest();
      setRelayAdminStateForTest({ availability });
      const { api, paths } = apiWith(bothOk());
      probeRelayAdmin(api);
      expect(paths).toHaveLength(0);
    }
  });

  test('上次是 401 的话下次还要再探', () => {
    setRelayAdminStateForTest({ availability: 'unauthorized' });
    const { api, paths } = apiWith(bothOk());
    probeRelayAdmin(api);
    expect(paths.length).toBeGreaterThan(0);
  });
});

describe('acquireRelayAdminPolling', () => {
  function harness() {
    const calls: number[] = [];
    let tick: (() => void) | null = null;
    const release = acquireRelayAdminPolling({
      intervalMs: 30_000,
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
      visibility: { hidden: () => false, subscribe: () => () => undefined },
    });
    return { calls, fire: () => tick?.(), release };
  }

  test('取用即刷新一次，之后每一拍再刷', () => {
    const { calls, fire, release } = harness();
    expect(calls).toHaveLength(1);
    fire();
    fire();
    expect(calls).toHaveLength(3);
    release();
  });

  test('第二个取用方只加引用计数；全部归还后定时器才停', () => {
    const first = harness();
    const second = acquireRelayAdminPolling({ refresh: () => first.calls.push(-1) });
    expect(first.calls).toHaveLength(1);
    first.release();
    first.fire();
    expect(first.calls).toHaveLength(2);
    second();
    first.fire();
    expect(first.calls).toHaveLength(2);
  });
});
