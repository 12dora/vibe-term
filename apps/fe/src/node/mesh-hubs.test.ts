// hub 集合 store：writer 判定、管理写入的阻断条件，以及那条 30 秒兜底轮询回路。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuthApi, HubEndpointInfo, MeshHubsResponse } from '@tmex/api-client/auth/index';
import type { NodeEventPayload } from './mesh-events';
import {
  MESH_HUBS_POLL_MS,
  type MeshHubsState,
  acquireMeshHubsPolling,
  attachedHubId,
  getMeshHubsState,
  hubWritesBlocked,
  refreshMeshHubs,
  resetMeshHubsStateForTest,
  setMeshHubsStateForTest,
  writerHub,
  writerHubUrl,
} from './mesh-hubs';
import type { MeshEventSubscriber } from './mesh-nodes';

function hub(overrides: Partial<HubEndpointInfo> & { nodeId: string }): HubEndpointInfo {
  return {
    publicUrl: `https://${overrides.nodeId}.example`,
    mode: 'active',
    priority: 0,
    writerEpoch: 1,
    ...overrides,
  };
}

function snapshot(patch: Partial<MeshHubsState>): MeshHubsState {
  return {
    hubs: [],
    candidates: [],
    attached: null,
    writerHubId: null,
    loading: false,
    error: null,
    loadedAt: null,
    ...patch,
  };
}

beforeEach(() => {
  resetMeshHubsStateForTest();
});

describe('writerHub / writerHubUrl / attachedHubId', () => {
  test('按 writerHubId 在集合里定位那一行', () => {
    const state = snapshot({
      hubs: [hub({ nodeId: 'h1' }), hub({ nodeId: 'h2', mode: 'standby' })],
      writerHubId: 'h1',
    });
    expect(writerHub(state)?.nodeId).toBe('h1');
    expect(writerHubUrl(state)).toBe('https://h1.example');
  });

  test('writerHubId 为空或集合里没有它时为 null', () => {
    expect(writerHub(snapshot({ hubs: [hub({ nodeId: 'h1' })] }))).toBeNull();
    expect(writerHubUrl(snapshot({ hubs: [hub({ nodeId: 'h1' })], writerHubId: 'h9' }))).toBeNull();
  });

  test('attachedHubId 取 attached.hubNodeId', () => {
    expect(attachedHubId(snapshot({}))).toBeNull();
    const attached = {
      hubNodeId: 'h2',
      publicUrl: 'https://h2.example',
      mode: 'standby' as const,
      writerEpoch: 0,
      since: 1,
    };
    expect(attachedHubId(snapshot({ attached }))).toBe('h2');
  });
});

describe('hubWritesBlocked', () => {
  test('集合还没拉到时一律按可用处理（旧入口没有这条路由）', () => {
    expect(hubWritesBlocked(snapshot({}))).toBe(false);
    expect(hubWritesBlocked(snapshot({ error: 'boom' }))).toBe(false);
  });

  test('单 hub 且在线：不阻断', () => {
    const state = snapshot({
      hubs: [hub({ nodeId: 'h1', online: true })],
      writerHubId: 'h1',
      attached: {
        hubNodeId: 'h1',
        publicUrl: 'https://h1.example',
        mode: 'active',
        writerEpoch: 1,
        since: 1,
      },
    });
    expect(hubWritesBlocked(state)).toBe(false);
  });

  test('挂在 standby 上：阻断', () => {
    const state = snapshot({
      hubs: [hub({ nodeId: 'h1', online: true }), hub({ nodeId: 'h2', mode: 'standby' })],
      writerHubId: 'h1',
      attached: {
        hubNodeId: 'h2',
        publicUrl: 'https://h2.example',
        mode: 'standby',
        writerEpoch: 0,
        since: 1,
      },
    });
    expect(hubWritesBlocked(state)).toBe(true);
  });

  test('一台 active 都没有（writerHubId 为空）：阻断', () => {
    const state = snapshot({
      hubs: [hub({ nodeId: 'h2', mode: 'standby' })],
      writerHubId: null,
    });
    expect(hubWritesBlocked(state)).toBe(true);
  });

  test('writer 明确离线：阻断', () => {
    const state = snapshot({
      hubs: [hub({ nodeId: 'h1', online: false }), hub({ nodeId: 'h2', mode: 'standby' })],
      writerHubId: 'h1',
    });
    expect(hubWritesBlocked(state)).toBe(true);
  });

  test('writer 没下发 online 字段时不阻断：缺字段不是离线', () => {
    const state = snapshot({ hubs: [hub({ nodeId: 'h1' })], writerHubId: 'h1' });
    expect(hubWritesBlocked(state)).toBe(false);
  });
});

function fakeApi(response: MeshHubsResponse | Error): { api: AuthApi; calls: () => number } {
  let calls = 0;
  const api = {
    listHubs: () => {
      calls += 1;
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    },
  } as unknown as AuthApi;
  return { api, calls: () => calls };
}

describe('refreshMeshHubs', () => {
  test('成功后落库并清错', async () => {
    const { api } = fakeApi({
      hubs: [hub({ nodeId: 'h1' }), hub({ nodeId: 'h2', mode: 'standby' })],
      attached: {
        hubNodeId: 'h2',
        publicUrl: 'https://h2.example',
        mode: 'standby',
        writerEpoch: 0,
        since: 3,
      },
      writerHubId: 'h1',
      candidates: [
        { publicUrl: 'https://h1.example', lastError: null, lastAttemptAt: 1 },
        { publicUrl: 'https://h2.example/', lastError: 'ECONNREFUSED', lastAttemptAt: 2 },
      ],
    });
    setMeshHubsStateForTest({ error: 'stale' });
    await refreshMeshHubs(api);
    const state = getMeshHubsState();
    expect(state.hubs.map((h) => h.nodeId)).toEqual(['h1', 'h2']);
    expect(state.writerHubId).toBe('h1');
    expect(state.attached?.mode).toBe('standby');
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.loadedAt).not.toBeNull();
    // uplink 候选诊断不再被丢掉：hub chip 的警告图标与悬浮详情全靠它
    expect(state.candidates.map((row) => row.lastError)).toEqual([null, 'ECONNREFUSED']);
  });

  test('旧后端不下发 candidates 时落成空数组', async () => {
    const { api } = fakeApi({ hubs: [], attached: null, writerHubId: null, candidates: [] });
    setMeshHubsStateForTest({
      candidates: [{ publicUrl: 'https://old.example', lastError: 'x', lastAttemptAt: 1 }],
    });
    await refreshMeshHubs(api);
    expect(getMeshHubsState().candidates).toEqual([]);
  });

  test('并发调用合并成一次请求', async () => {
    const { api, calls } = fakeApi({
      hubs: [],
      attached: null,
      writerHubId: null,
      candidates: [],
    });
    await Promise.all([refreshMeshHubs(api), refreshMeshHubs(api), refreshMeshHubs(api)]);
    expect(calls()).toBe(1);
  });

  test('失败保留上一份集合，只记错', async () => {
    setMeshHubsStateForTest({ hubs: [hub({ nodeId: 'h1' })], writerHubId: 'h1' });
    const { api } = fakeApi(new Error('offline'));
    await refreshMeshHubs(api);
    const state = getMeshHubsState();
    expect(state.hubs.map((h) => h.nodeId)).toEqual(['h1']);
    expect(state.error).toBe('offline');
    expect(state.loading).toBe(false);
  });
});

function fakeEvents() {
  const statusListeners = new Set<() => void>();
  const nodeListeners = new Set<(event: NodeEventPayload) => void>();
  const source: MeshEventSubscriber = {
    connected: false,
    onStatusChange: (listener) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    onNodeEvent: (listener) => {
      nodeListeners.add(listener);
      return () => {
        nodeListeners.delete(listener);
      };
    },
  };
  const mutable = source as { connected: boolean };
  return {
    source,
    setConnected(next: boolean) {
      mutable.connected = next;
      for (const listener of statusListeners) listener();
    },
    emit(event: NodeEventPayload) {
      for (const listener of nodeListeners) listener(event);
    },
  };
}

function pollingHarness() {
  const events = fakeEvents();
  const state = {
    refreshes: 0,
    scheduled: 0,
    intervalMs: 0,
    tick: null as (() => void) | null,
    onVisibilityChange: null as (() => void) | null,
    hidden: false,
  };
  const options = {
    throttleMs: 0,
    events: events.source,
    refresh: () => {
      state.refreshes += 1;
    },
    schedule: (fn: () => void, ms: number) => {
      state.scheduled += 1;
      state.intervalMs = ms;
      state.tick = fn;
      return () => {
        state.tick = null;
      };
    },
    delay: (fn: () => void, _ms: number) => {
      fn();
      return () => undefined;
    },
    visibility: {
      hidden: () => state.hidden,
      subscribe: (listener: () => void) => {
        state.onVisibilityChange = listener;
        return () => {
          state.onVisibilityChange = null;
        };
      },
    },
  };
  return { state, options, events };
}

const nodeEvent = (nodeId: string): NodeEventPayload => ({
  nodeId,
  status: 'offline',
  reach: null,
  inventory: null,
});

describe('acquireMeshHubsPolling', () => {
  test('两个消费方共用同一条回路：只装一个定时器，兜底间隔 30 秒', () => {
    const { state, options } = pollingHarness();
    const first = acquireMeshHubsPolling(options);
    const secondHarness = pollingHarness();
    const second = acquireMeshHubsPolling(secondHarness.options);

    expect(state.scheduled).toBe(1);
    expect(state.intervalMs).toBe(30_000);
    expect(MESH_HUBS_POLL_MS).toBe(30_000);
    expect(state.refreshes).toBe(1);
    expect(secondHarness.state.scheduled).toBe(0);

    first();
    state.tick?.();
    expect(state.refreshes).toBe(2);

    second();
    expect(state.tick).toBeNull();
    second();
  });

  test('页面隐藏期间跳过这一拍，重新可见立刻补一次', () => {
    const { state, options } = pollingHarness();
    const release = acquireMeshHubsPolling(options);

    state.hidden = true;
    state.tick?.();
    expect(state.refreshes).toBe(1);

    state.hidden = false;
    state.onVisibilityChange?.();
    expect(state.refreshes).toBe(2);
    release();
  });

  test('`/mesh/ws` 连上后补一次', () => {
    const { state, options, events } = pollingHarness();
    const release = acquireMeshHubsPolling(options);
    events.setConnected(true);
    expect(state.refreshes).toBe(2);
    // 断开不补
    events.setConnected(false);
    expect(state.refreshes).toBe(2);
    release();
  });

  test('只有已知 hub 机的 NODE_EVENT 触发补拉', () => {
    setMeshHubsStateForTest({ hubs: [hub({ nodeId: 'h1' })] });
    const { state, options, events } = pollingHarness();
    const release = acquireMeshHubsPolling(options);
    expect(state.refreshes).toBe(1);

    events.emit(nodeEvent('other'));
    expect(state.refreshes).toBe(1);

    events.emit(nodeEvent('h1'));
    expect(state.refreshes).toBe(2);
    release();
  });
});
