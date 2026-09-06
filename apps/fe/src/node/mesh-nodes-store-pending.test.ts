// 成员列表同步进度（`pendingMembers` / `listVersion`）在 store 里的落地与事件补拉。

import { describe, expect, test } from 'bun:test';
import type { AuthApi, MeshNode, MeshNodesResponse } from '@vibeterm/api-client/auth/index';
import type { NodeEventPayload } from './mesh-events';
import {
  applyMeshNodeEvent,
  getMeshNodesState,
  refreshMeshNodes,
  resetMeshNodesStateForTest,
  setMeshNodesStateForTest,
  shouldRefreshPendingMembers,
} from './mesh-nodes-store';

function node(overrides: Partial<MeshNode> & { id: string }): MeshNode {
  return {
    name: overrides.id,
    publicKey: 'pk',
    online: true,
    reach: 'lan',
    version: null,
    direct_capable: false,
    inventory: null,
    loggedIn: false,
    ...overrides,
  };
}

function event(overrides: Partial<NodeEventPayload> & { nodeId: string }): NodeEventPayload {
  return { status: 'online', reach: 'lan', inventory: null, ...overrides };
}

/** 由用例决定何时落地的 `/api/mesh/nodes`。 */
function deferredApi() {
  const pending: ((payload: MeshNodesResponse) => void)[] = [];
  let calls = 0;
  const api = {
    listNodesDetailed: () => {
      calls += 1;
      return new Promise<MeshNodesResponse>((resolve) => {
        pending.push(resolve);
      });
    },
  } as unknown as AuthApi;
  return { api, pending, calls: () => calls };
}

/** 让 store 里那串 then / finally 跑完。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

describe('refreshMeshNodes 的同步进度', () => {
  test('新网关下发的 listVersion / pendingMembers 落进 store', async () => {
    resetMeshNodesStateForTest();
    const api = {
      listNodesDetailed: async () => ({
        nodes: [node({ id: 'a' })],
        listVersion: 12,
        pendingMembers: 2,
      }),
    } as unknown as AuthApi;

    await refreshMeshNodes(api);
    expect(getMeshNodesState().listVersion).toBe(12);
    expect(getMeshNodesState().pendingMembers).toBe(2);
    resetMeshNodesStateForTest();
  });

  test('旧网关只有 listNodes：同步进度记成「不知道」而不是 0', async () => {
    resetMeshNodesStateForTest();
    const api = { listNodes: async () => [node({ id: 'a' })] } as unknown as AuthApi;

    await refreshMeshNodes(api);
    expect(getMeshNodesState().nodes.map((row) => row.id)).toEqual(['a']);
    expect(getMeshNodesState().pendingMembers).toBeNull();
    expect(getMeshNodesState().listVersion).toBeNull();
    resetMeshNodesStateForTest();
  });
});

describe('shouldRefreshPendingMembers', () => {
  const nodes = [node({ id: 'a', inventory: null }), node({ id: 'b', inventory: { v: 1 } })];
  type PredicateState = Parameters<typeof shouldRefreshPendingMembers>[0];
  const state = (overrides: Partial<PredicateState> = {}): PredicateState => ({
    nodes,
    pendingMembers: 1,
    pendingMemberIds: ['a'],
    loadedAt: 1,
    ...overrides,
  });

  test('待同步成员的库存被事件补上：要回源', () => {
    expect(
      shouldRefreshPendingMembers(state(), event({ nodeId: 'a', inventory: { v: 2 } }), false)
    ).toBe(true);
  });

  test('没有待同步成员时不回源', () => {
    expect(
      shouldRefreshPendingMembers(
        state({ pendingMembers: 0 }),
        event({ nodeId: 'a', inventory: { v: 2 } }),
        false
      )
    ).toBe(false);
    expect(
      shouldRefreshPendingMembers(
        state({ pendingMembers: null }),
        event({ nodeId: 'a', inventory: { v: 2 } }),
        false
      )
    ).toBe(false);
  });

  test('事件没带库存（状态块仍解不开）不回源，持续上下线不会变成定时器', () => {
    expect(shouldRefreshPendingMembers(state(), event({ nodeId: 'a' }), false)).toBe(false);
  });

  test('该行本来就有库存不回源', () => {
    expect(
      shouldRefreshPendingMembers(state(), event({ nodeId: 'b', inventory: { v: 9 } }), false)
    ).toBe(false);
  });

  test('列表里没有这一行不回源（新成员由未知 node 的补拉负责）', () => {
    expect(
      shouldRefreshPendingMembers(state(), event({ nodeId: 'zz', inventory: { v: 1 } }), false)
    ).toBe(false);
  });

  test('待同步成员被别处吊销：revoke 不带库存，也必须回源，否则计数一直挂着', () => {
    expect(
      shouldRefreshPendingMembers(state(), event({ nodeId: 'a', status: 'revoked' }), false)
    ).toBe(true);
    // 没有待同步成员 / 不在列表里的 revoke 不回源
    expect(
      shouldRefreshPendingMembers(
        state({ pendingMembers: 0 }),
        event({ nodeId: 'a', status: 'revoked' }),
        false
      )
    ).toBe(false);
    expect(
      shouldRefreshPendingMembers(state(), event({ nodeId: 'zz', status: 'revoked' }), false)
    ).toBe(false);
  });

  test('首拉在飞时任何成员事件都排一次尾随请求（在飞的响应带着过期成员集与计数落地）', () => {
    const first = state({ loadedAt: null, pendingMembers: null, pendingMemberIds: null });
    for (const frame of [
      event({ nodeId: 'a', inventory: { v: 2 } }),
      event({ nodeId: 'a', status: 'revoked' }),
      event({ nodeId: 'a', status: 'offline' }),
    ]) {
      expect(shouldRefreshPendingMembers(first, frame, true)).toBe(true);
      // 没有在飞的请求就不发：首拉失败时事件不该变成新的定时器
      expect(shouldRefreshPendingMembers(first, frame, false)).toBe(false);
    }
  });

  test('待同步成员掉线：网关不再把它算作同步中，本地计数只能靠回源纠正', () => {
    expect(
      shouldRefreshPendingMembers(state(), event({ nodeId: 'a', status: 'offline' }), false)
    ).toBe(true);
    // 不在待同步名单里的节点掉线不回源，否则上下线就成了新的定时器
    expect(
      shouldRefreshPendingMembers(state(), event({ nodeId: 'b', status: 'offline' }), false)
    ).toBe(false);
    // 旧网关不下发名单时同样不回源
    expect(
      shouldRefreshPendingMembers(
        state({ pendingMemberIds: null }),
        event({ nodeId: 'a', status: 'offline' }),
        false
      )
    ).toBe(false);
  });
});

describe('applyMeshNodeEvent', () => {
  test('就地投影仍然生效', () => {
    resetMeshNodesStateForTest();
    setMeshNodesStateForTest({ nodes: [node({ id: 'a', online: false })] });
    applyMeshNodeEvent(event({ nodeId: 'a', status: 'online' }));
    expect(getMeshNodesState().nodes[0]?.online).toBe(true);
    resetMeshNodesStateForTest();
  });

  test('待同步成员被吊销：计数收敛回 0，不必等五分钟的兜底轮询', async () => {
    resetMeshNodesStateForTest();
    setMeshNodesStateForTest({
      nodes: [node({ id: 'a' }), node({ id: 'b', inventory: { v: 1 } })],
      pendingMembers: 1,
      loadedAt: 1,
    });
    const { api, pending, calls } = deferredApi();

    applyMeshNodeEvent(event({ nodeId: 'a', status: 'revoked' }), api);
    expect(calls()).toBe(1);
    pending[0]({ nodes: [node({ id: 'b', inventory: { v: 1 } })], pendingMembers: 0 });
    await flush();
    expect(getMeshNodesState().pendingMembers).toBe(0);
    resetMeshNodesStateForTest();
  });

  test('待同步成员掉线：当场回源，不必等五分钟的兜底轮询把计数纠正回来', async () => {
    resetMeshNodesStateForTest();
    setMeshNodesStateForTest({
      nodes: [node({ id: 'a' }), node({ id: 'b', inventory: { v: 1 } })],
      pendingMembers: 1,
      pendingMemberIds: ['a'],
      loadedAt: 1,
    });
    const { api, pending, calls } = deferredApi();

    applyMeshNodeEvent(event({ nodeId: 'a', status: 'offline' }), api);
    expect(calls()).toBe(1);
    // 网关不再把掉线的成员算作同步中
    pending[0]({
      nodes: [node({ id: 'a', online: false }), node({ id: 'b', inventory: { v: 1 } })],
      pendingMembers: 0,
      pendingMemberIds: [],
    });
    await flush();
    expect(getMeshNodesState().pendingMembers).toBe(0);
    expect(getMeshNodesState().pendingMemberIds).toEqual([]);
    resetMeshNodesStateForTest();
  });

  test('吊销事件先到、首拉的旧响应后落地：尾随请求把被加回来的成员再摘掉', async () => {
    resetMeshNodesStateForTest();
    const { api, pending, calls } = deferredApi();

    const first = refreshMeshNodes(api);
    expect(calls()).toBe(1);
    // 首拉还在飞，此刻 pendingMembers 还是「不知道」
    applyMeshNodeEvent(event({ nodeId: 'a', status: 'revoked' }), api);
    expect(calls()).toBe(1);

    // 在飞的那次早于吊销发出：它会把已经吊销的成员连同计数一起加回来
    pending[0]({ nodes: [node({ id: 'a' })], pendingMembers: 1, pendingMemberIds: ['a'] });
    await first;
    expect(getMeshNodesState().nodes.map((row) => row.id)).toEqual(['a']);
    // 尾随请求补上，成员集与计数当场收敛
    expect(calls()).toBe(2);
    pending[1]({ nodes: [], pendingMembers: 0, pendingMemberIds: [] });
    await flush();
    expect(getMeshNodesState().nodes).toEqual([]);
    expect(getMeshNodesState().pendingMembers).toBe(0);
    resetMeshNodesStateForTest();
  });

  test('首拉在飞时到的成员事件：排尾随请求，纠正那份带过期计数的旧响应', async () => {
    resetMeshNodesStateForTest();
    const { api, pending, calls } = deferredApi();

    const first = refreshMeshNodes(api);
    expect(calls()).toBe(1);
    // 事件先到：此刻 pendingMembers 还是「不知道」，光靠事件补不上计数
    applyMeshNodeEvent(event({ nodeId: 'a', inventory: { v: 2 } }), api);
    expect(calls()).toBe(1);

    // 在飞的那次早于事件发出，落地时带的是过期的 pendingMembers
    pending[0]({ nodes: [node({ id: 'a' })], pendingMembers: 1 });
    await first;
    expect(getMeshNodesState().pendingMembers).toBe(1);
    // 尾随请求补上，计数当场收敛
    expect(calls()).toBe(2);
    pending[1]({ nodes: [node({ id: 'a', inventory: { v: 2 } })], pendingMembers: 0 });
    await flush();
    expect(getMeshNodesState().pendingMembers).toBe(0);
    resetMeshNodesStateForTest();
  });
});
