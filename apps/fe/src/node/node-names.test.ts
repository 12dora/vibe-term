// nodeId → 展示名的解析：包内提示语（如「终端连接失败：节点 xxx 版本过低」）靠它点名。

import { describe, expect, test } from 'bun:test';
import type { MeshNode } from '@tmex/api-client/auth/index';
import { resetMeshNodesStateForTest, setMeshNodesStateForTest } from './mesh-nodes';
import { resolveMeshNodeName } from './node-names';

function node(id: string, name: string): MeshNode {
  return {
    id,
    name,
    publicKey: '',
    online: true,
    reach: 'lan',
    version: null,
    direct_capable: false,
    inventory: null,
    loggedIn: false,
  } as MeshNode;
}

describe('resolveMeshNodeName', () => {
  test('按 id 查展示名，self 走 entry 自身，查不到返回 null', () => {
    resetMeshNodesStateForTest();
    // 列表还没拉到时任何 id 都查不到
    expect(resolveMeshNodeName('n1')).toBeNull();
    expect(resolveMeshNodeName('self')).toBeNull();

    setMeshNodesStateForTest({
      entryNodeId: 'entry',
      nodes: [node('n1', 'demo-app'), node('entry', 'entry-box'), node('blank', '  ')],
    });

    expect(resolveMeshNodeName('n1')).toBe('demo-app');
    expect(resolveMeshNodeName('self')).toBe('entry-box');
    expect(resolveMeshNodeName('unknown')).toBeNull();
    // 名字为空白等同于没有名字，交给调用方退回编号
    expect(resolveMeshNodeName('blank')).toBeNull();

    // entry 自身未知时 self 无从解析
    setMeshNodesStateForTest({ entryNodeId: null });
    expect(resolveMeshNodeName('self')).toBeNull();
    expect(resolveMeshNodeName('n1')).toBe('demo-app');

    resetMeshNodesStateForTest();
  });
});
