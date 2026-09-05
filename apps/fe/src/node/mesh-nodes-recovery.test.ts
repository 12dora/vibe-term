// 冷启动的三条兜底：localStorage 首帧缓存 + REST 落地后的重整、`/api/auth/mode` 与
// `/api/mesh/nodes` 的有界重试、恢复信号（可见 / online）触发的立即重来。

import { describe, expect, test } from 'bun:test';
import type { AuthApi, AuthModeResponse, MeshNode } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { clearMeshNodesCache, readMeshNodesCache, writeMeshNodesCache } = await import(
  './mesh-nodes-cache'
);
const { RECOVERY_RETRY_MS } = await import('./mesh-recovery');
const {
  ensureAuthMode,
  getMeshNodesState,
  hydrateMeshNodesFromCache,
  meshEnabledOf,
  refreshMeshNodes,
  resetMeshNodesStateForTest,
  retryUnsettledOnRecovery,
  setRetrySchedulersForTest,
} = await import('./mesh-nodes');

function node(overrides: Partial<MeshNode> & { id: string }): MeshNode {
  return {
    name: overrides.id,
    publicKey: 'AAAA',
    online: true,
    reach: null,
    version: null,
    direct_capable: false,
    inventory: null,
    loggedIn: false,
    ...overrides,
  };
}

function authMode(overrides: Partial<AuthModeResponse> = {}): AuthModeResponse {
  return {
    mode: 'mesh',
    nodeId: 'entry',
    uid: 'u',
    username: 'u',
    kdfParams: null,
    passkeysForThisOrigin: false,
    passkeyAvailable: false,
    ...overrides,
  };
}

interface Harness {
  api: AuthApi;
  modeCalls: number;
  listCalls: number;
}

function apiHarness(options: {
  mode?: () => Promise<AuthModeResponse>;
  list?: () => Promise<MeshNode[]>;
}): Harness {
  const harness: Harness = {
    modeCalls: 0,
    listCalls: 0,
    api: {
      getMode: () => {
        harness.modeCalls += 1;
        return options.mode ? options.mode() : Promise.resolve(authMode());
      },
      listNodes: () => {
        harness.listCalls += 1;
        return options.list ? options.list() : Promise.resolve([]);
      },
    } as unknown as AuthApi,
  };
  return harness;
}

function fakeTimers() {
  const pending: { fn: () => void; ms: number }[] = [];
  return {
    pending,
    options: {
      setTimeoutFn: (fn: () => void, ms: number) => {
        pending.push({ fn, ms });
        return pending.length;
      },
      clearTimeoutFn: () => undefined,
    },
    run: () => {
      const next = pending.shift();
      next?.fn();
    },
  };
}

function reset(): void {
  resetMeshNodesStateForTest();
  clearMeshNodesCache();
  setRetrySchedulersForTest();
}

describe('首帧缓存', () => {
  test('hydrate 出来的列表带 stale 标记，REST 落地后整份换掉并回写', async () => {
    reset();
    writeMeshNodesCache({
      mesh: true,
      entryNodeId: 'entry',
      nodes: [node({ id: 'cached', name: '书房' })],
      savedAt: Date.now(),
    });

    expect(hydrateMeshNodesFromCache()).toBe(true);
    const first = getMeshNodesState();
    expect(first.stale).toBe(true);
    expect(first.nodes.map((row) => row.id)).toEqual(['cached']);
    expect(first.entryNodeId).toBe('entry');
    expect(first.cachedMesh).toBe(true);
    // mode 还没落地时按缓存判定 mesh，聚合视图与 `/api/mesh/nodes` 第一帧就能起来
    expect(meshEnabledOf(first)).toBe(true);

    const harness = apiHarness({ list: () => Promise.resolve([node({ id: 'fresh' })]) });
    await refreshMeshNodes(harness.api);
    const after = getMeshNodesState();
    expect(after.stale).toBe(false);
    expect(after.nodes.map((row) => row.id)).toEqual(['fresh']);
    expect(readMeshNodesCache()?.nodes.map((row) => row.id)).toEqual(['fresh']);
    reset();
  });

  test('mode 落地为 standalone 时缓存作废，列表清空', async () => {
    reset();
    writeMeshNodesCache({
      mesh: true,
      entryNodeId: 'entry',
      nodes: [node({ id: 'cached' })],
      savedAt: Date.now(),
    });
    hydrateMeshNodesFromCache();

    const harness = apiHarness({ mode: () => Promise.resolve(authMode({ mode: 'none' })) });
    await ensureAuthMode(harness.api);
    expect(getMeshNodesState().nodes).toEqual([]);
    expect(getMeshNodesState().stale).toBe(false);
    expect(meshEnabledOf(getMeshNodesState())).toBe(false);
    expect(readMeshNodesCache()).toBeNull();
    reset();
  });

  test('entry 换人时缓存作废，列表清空', async () => {
    reset();
    writeMeshNodesCache({
      mesh: true,
      entryNodeId: 'old-entry',
      nodes: [node({ id: 'cached' })],
      savedAt: Date.now(),
    });
    hydrateMeshNodesFromCache();

    const harness = apiHarness({ mode: () => Promise.resolve(authMode({ nodeId: 'new-entry' })) });
    await ensureAuthMode(harness.api);
    expect(getMeshNodesState().nodes).toEqual([]);
    expect(getMeshNodesState().entryNodeId).toBe('new-entry');
    expect(readMeshNodesCache()).toBeNull();
    reset();
  });

  test('entry 没变时缓存留着，只等 REST 重整', async () => {
    reset();
    writeMeshNodesCache({
      mesh: true,
      entryNodeId: 'entry',
      nodes: [node({ id: 'cached' })],
      savedAt: Date.now(),
    });
    hydrateMeshNodesFromCache();

    await ensureAuthMode(apiHarness({}).api);
    expect(getMeshNodesState().nodes.map((row) => row.id)).toEqual(['cached']);
    expect(getMeshNodesState().stale).toBe(true);
    reset();
  });
});

describe('有界重试', () => {
  test('/api/auth/mode 失败不再被永久记住，按 1 / 3 / 10 秒重试三次', async () => {
    reset();
    const timers = fakeTimers();
    setRetrySchedulersForTest(timers.options);
    const harness = apiHarness({ mode: () => Promise.reject(new Error('offline')) });

    await ensureAuthMode(harness.api);
    expect(harness.modeCalls).toBe(1);
    expect(getMeshNodesState().modeLoaded).toBe(true);

    for (const [index, expected] of RECOVERY_RETRY_MS.entries()) {
      expect(timers.pending[0]?.ms).toBe(expected);
      timers.run();
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.modeCalls).toBe(index + 2);
    }
    // 阶梯用尽：不再排新的定时器（真断网时不能变成新的轮询器）
    expect(timers.pending).toHaveLength(0);
    reset();
  });

  test('/api/mesh/nodes 首拉失败同样有界重试；成功后不再排', async () => {
    reset();
    const timers = fakeTimers();
    setRetrySchedulersForTest(timers.options);
    let fail = true;
    const harness = apiHarness({
      list: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve([])),
    });

    await refreshMeshNodes(harness.api);
    expect(harness.listCalls).toBe(1);
    expect(getMeshNodesState().error).not.toBeNull();
    expect(timers.pending[0]?.ms).toBe(RECOVERY_RETRY_MS[0]);

    fail = false;
    timers.run();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.listCalls).toBe(2);
    expect(getMeshNodesState().loadedAt).not.toBeNull();
    expect(timers.pending).toHaveLength(0);
    reset();
  });

  test('已经拿到列表之后的失败不排重试（兜底轮询接手）', async () => {
    reset();
    const timers = fakeTimers();
    setRetrySchedulersForTest(timers.options);
    let fail = false;
    const harness = apiHarness({
      list: () => (fail ? Promise.reject(new Error('boom')) : Promise.resolve([])),
    });
    await refreshMeshNodes(harness.api);
    fail = true;
    await refreshMeshNodes(harness.api);
    expect(timers.pending).toHaveLength(0);
    reset();
  });
});

describe('恢复信号', () => {
  test('可见 / online 时把没落地的两条请求立刻重来一轮', async () => {
    reset();
    const timers = fakeTimers();
    setRetrySchedulersForTest(timers.options);
    const harness = apiHarness({
      mode: () => Promise.reject(new Error('offline')),
      list: () => Promise.reject(new Error('offline')),
    });

    await ensureAuthMode(harness.api);
    await refreshMeshNodes(harness.api);
    expect(harness.modeCalls).toBe(1);
    // mode 拉不到、也没有缓存判定：这一刻还不该发 `/api/mesh/nodes`
    expect(harness.listCalls).toBe(1);
    const scheduled = timers.pending.length;

    retryUnsettledOnRecovery(harness.api);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.modeCalls).toBe(2);
    // reset 把在途定时器撤掉，重试阶梯从头再来，不会越积越多
    expect(timers.pending.length).toBeLessThanOrEqual(scheduled + 1);
    reset();
  });

  test('列表已经落地时恢复信号不再补拉', async () => {
    reset();
    setRetrySchedulersForTest(fakeTimers().options);
    const harness = apiHarness({});
    await ensureAuthMode(harness.api);
    await refreshMeshNodes(harness.api);
    expect(harness.listCalls).toBe(1);

    retryUnsettledOnRecovery(harness.api);
    await Promise.resolve();
    expect(harness.listCalls).toBe(1);
    expect(harness.modeCalls).toBe(1);
    reset();
  });
});
