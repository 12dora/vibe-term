// 成员列表同步进度（`pendingMembers` / `listVersion`）在 store 里的落地与事件补拉。

import { describe, expect, test } from 'bun:test';
import type { AuthApi, MeshNode } from '@vibeterm/api-client/auth/index';
import type { NodeEventPayload } from './mesh-events';
import {
  applyMeshNodeEvent,
  fillsPendingMember,
  getMeshNodesState,
  refreshMeshNodes,
  resetMeshNodesStateForTest,
  setMeshNodesStateForTest,
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

describe('fillsPendingMember', () => {
  const nodes = [node({ id: 'a', inventory: null }), node({ id: 'b', inventory: { v: 1 } })];

  test('待同步成员的库存被事件补上：要回源', () => {
    expect(
      fillsPendingMember({ nodes, pendingMembers: 1 }, event({ nodeId: 'a', inventory: { v: 2 } }))
    ).toBe(true);
  });

  test('没有待同步成员时不回源', () => {
    expect(
      fillsPendingMember({ nodes, pendingMembers: 0 }, event({ nodeId: 'a', inventory: { v: 2 } }))
    ).toBe(false);
    expect(
      fillsPendingMember(
        { nodes, pendingMembers: null },
        event({ nodeId: 'a', inventory: { v: 2 } })
      )
    ).toBe(false);
  });

  test('事件没带库存（状态块仍解不开）不回源，持续上下线不会变成定时器', () => {
    expect(fillsPendingMember({ nodes, pendingMembers: 1 }, event({ nodeId: 'a' }))).toBe(false);
  });

  test('该行本来就有库存不回源', () => {
    expect(
      fillsPendingMember({ nodes, pendingMembers: 1 }, event({ nodeId: 'b', inventory: { v: 9 } }))
    ).toBe(false);
  });

  test('列表里没有这一行不回源（新成员由未知 node 的补拉负责）', () => {
    expect(
      fillsPendingMember({ nodes, pendingMembers: 1 }, event({ nodeId: 'zz', inventory: { v: 1 } }))
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
});
