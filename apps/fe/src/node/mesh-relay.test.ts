// 中继链路 store：状态映射、404 退化、纯判定函数。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RelayApiError } from '@tmex/api-client/relay/admin-api';
import type { RelayTenantApi, RelayTenantStatus } from '@tmex/api-client/relay/tenant-api';
import {
  attachedRelay,
  getMeshRelayState,
  isRelayMode,
  orderedRelays,
  refreshMeshRelay,
  relayKicked,
  relayWritable,
  resetMeshRelayStateForTest,
  setMeshRelayStateForTest,
  switchMeshRelay,
} from './mesh-relay';

// store 是宿主级单例，同一进程里的其它测试文件也读它：每个用例跑完必须归零。
afterEach(() => {
  resetMeshRelayStateForTest();
});

function status(overrides: Partial<RelayTenantStatus> = {}): RelayTenantStatus {
  return {
    mode: 'relay',
    tenantId: 'ab'.repeat(16),
    relays: [],
    metaEpoch: 2,
    nodesViaRelay: 3,
    reauthRequired: false,
    readmitPending: 0,
    quota: null,
    ...overrides,
  };
}

function link(url: string, overrides: Partial<RelayTenantStatus['relays'][number]> = {}) {
  return {
    url,
    priority: 0,
    online: true,
    attached: false,
    rttMs: null,
    lastError: null,
    kicked: false,
    ...overrides,
  };
}

function apiOf(impl: () => Promise<RelayTenantStatus>): RelayTenantApi {
  return { status: impl } as unknown as RelayTenantApi;
}

function apiWith(parts: Partial<Record<'status' | 'switchRelay', unknown>>): RelayTenantApi {
  return parts as unknown as RelayTenantApi;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('mesh-relay 纯函数', () => {
  test('attached / ordered / writable / kicked', () => {
    const snapshot = {
      ...getMeshRelayState(),
      ...status({
        relays: [
          link('https://b.example', { priority: 2, attached: true }),
          link('https://a.example', { priority: 1 }),
        ],
      }),
    };
    expect(isRelayMode(snapshot)).toBe(true);
    expect(attachedRelay(snapshot)?.url).toBe('https://b.example');
    expect(orderedRelays(snapshot).map((row) => row.url)).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(relayWritable(snapshot)).toBe(true);
    expect(relayKicked(snapshot)).toBe(false);
  });

  test('一条都没挂上时不可写；非中继模式恒可写', () => {
    const detached = { ...getMeshRelayState(), ...status({ relays: [link('https://a.example')] }) };
    expect(relayWritable(detached)).toBe(false);
    expect(relayWritable({ ...detached, mode: 'hub' })).toBe(true);
  });

  test('任一条被踢即视为要重新输入口令', () => {
    const kicked = {
      ...getMeshRelayState(),
      ...status({ relays: [link('https://a.example', { kicked: true })] }),
    };
    expect(relayKicked(kicked)).toBe(true);
  });
});

describe('refreshMeshRelay', () => {
  beforeEach(() => {
    resetMeshRelayStateForTest();
  });

  test('成功后写入快照并清空错误', async () => {
    await refreshMeshRelay(
      apiOf(() =>
        Promise.resolve(status({ relays: [link('https://a.example', { attached: true })] }))
      )
    );
    const state = getMeshRelayState();
    expect(state.mode).toBe('relay');
    expect(state.relays).toHaveLength(1);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.loadedAt).not.toBeNull();
  });

  test('404 记成 unsupported，不当作加载失败', async () => {
    await refreshMeshRelay(
      apiOf(() => Promise.reject(new RelayApiError('not_found', 'not found', 404)))
    );
    const state = getMeshRelayState();
    expect(state.unsupported).toBe(true);
    expect(state.error).toBeNull();
    expect(state.mode).toBe('none');
  });

  test('其它错误保留上一份链路', async () => {
    setMeshRelayStateForTest(status({ relays: [link('https://a.example')] }));
    await refreshMeshRelay(apiOf(() => Promise.reject(new Error('boom'))));
    const state = getMeshRelayState();
    expect(state.relays).toHaveLength(1);
    expect(state.error).toBe('boom');
  });
});

describe('switchMeshRelay', () => {
  beforeEach(() => {
    resetMeshRelayStateForTest();
  });

  test('把 /switch 回来的那份状态就地写进 store，不等下一拍轮询', async () => {
    setMeshRelayStateForTest(status({ relays: [link('https://a.example', { attached: true })] }));
    const calls: string[] = [];
    const api = {
      switchRelay: (url: string) => {
        calls.push(url);
        return Promise.resolve(status({ relays: [link('https://b.example', { attached: true })] }));
      },
    } as unknown as RelayTenantApi;

    await switchMeshRelay('https://b.example', api);

    expect(calls).toEqual(['https://b.example']);
    const state = getMeshRelayState();
    expect(attachedRelay(state)?.url).toBe('https://b.example');
    expect(state.error).toBeNull();
    expect(state.loadedAt).not.toBeNull();
  });

  test('失败原样抛出，链路不动', async () => {
    setMeshRelayStateForTest(status({ relays: [link('https://a.example', { attached: true })] }));
    const api = {
      switchRelay: () => Promise.reject(new RelayApiError('RELAY_KICKED', 'kicked', 409)),
    } as unknown as RelayTenantApi;

    await expect(switchMeshRelay('https://b.example', api)).rejects.toThrow();
    expect(attachedRelay(getMeshRelayState())?.url).toBe('https://a.example');
  });
});

describe('切换与轮询交错', () => {
  const ON_A = () => status({ relays: [link('https://a.example', { attached: true })] });
  const ON_B = () => status({ relays: [link('https://b.example', { attached: true })] });

  beforeEach(() => {
    resetMeshRelayStateForTest();
  });

  test('切换之前发出的 /status 回来得晚，也不能把链路扳回旧的那条', async () => {
    const stale = deferred<RelayTenantStatus>();
    const api = apiWith({
      status: () => stale.promise,
      switchRelay: () => Promise.resolve(ON_B()),
    });

    const polling = refreshMeshRelay(api);
    await switchMeshRelay('https://b.example', api);
    stale.resolve(ON_A());
    await polling;

    expect(attachedRelay(getMeshRelayState())?.url).toBe('https://b.example');
  });

  test('切换之前那次 /status 失败，错误也不落进已经切好的这一份', async () => {
    const stale = deferred<RelayTenantStatus>();
    const api = apiWith({
      status: () => stale.promise,
      switchRelay: () => Promise.resolve(ON_B()),
    });

    const polling = refreshMeshRelay(api);
    await switchMeshRelay('https://b.example', api);
    stale.reject(new Error('boom'));
    await polling;

    const state = getMeshRelayState();
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
    expect(attachedRelay(state)?.url).toBe('https://b.example');
  });

  test('切换之后的刷新自己发一次，不复用切换前那次在途请求', async () => {
    const stale = deferred<RelayTenantStatus>();
    let calls = 0;
    const api = apiWith({
      status: () => {
        calls += 1;
        return calls === 1 ? stale.promise : Promise.resolve(ON_B());
      },
      switchRelay: () => Promise.resolve(ON_B()),
    });

    const polling = refreshMeshRelay(api);
    await switchMeshRelay('https://b.example', api);
    await refreshMeshRelay(api);
    expect(calls).toBe(2);

    stale.resolve(ON_A());
    await polling;
    expect(attachedRelay(getMeshRelayState())?.url).toBe('https://b.example');
  });

  test('没切换时同一拍里的重复刷新仍然只打一次', async () => {
    const pending = deferred<RelayTenantStatus>();
    let calls = 0;
    const api = apiWith({
      status: () => {
        calls += 1;
        return pending.promise;
      },
    });

    const first = refreshMeshRelay(api);
    const second = refreshMeshRelay(api);
    pending.resolve(ON_A());
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(attachedRelay(getMeshRelayState())?.url).toBe('https://a.example');
  });
});
