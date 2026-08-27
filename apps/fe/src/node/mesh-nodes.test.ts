// mesh 节点列表的纯函数：指纹、NODE_EVENT 投影、排序、hub 合并与 hub 候选顺序。

import { describe, expect, test } from 'bun:test';
import type { MeshNode } from '@tmex/api-client/auth/index';
import { bytesToHex, encodeBase64url, sha256 } from '@tmex/shared/auth';
import type { HubNodeRow } from './hub-api';
import {
  hubCandidates,
  mergeNodes,
  patchNodesWithEvent,
  publicKeyFingerprint,
  sortNodes,
  toRuntimeNodeId,
} from './mesh-nodes';

function node(overrides: Partial<MeshNode> & { id: string }): MeshNode {
  return {
    name: overrides.id,
    publicKey: encodeBase64url(new Uint8Array(32).fill(1)),
    online: true,
    reach: 'lan',
    version: null,
    direct_capable: false,
    inventory: null,
    loggedIn: false,
    ...overrides,
  };
}

describe('publicKeyFingerprint', () => {
  test('sha256(pk) 的前 16 个 hex 字符', () => {
    const pk = new Uint8Array(32).fill(7);
    const expected = bytesToHex(sha256(pk)).slice(0, 16);
    expect(publicKeyFingerprint(encodeBase64url(pk))).toBe(expected);
    expect(publicKeyFingerprint(encodeBase64url(pk))).toHaveLength(16);
  });

  test('畸形 base64url 返回空串而不是抛异常', () => {
    expect(publicKeyFingerprint('!!!not-base64!!!')).toBe('');
  });
});

describe('toRuntimeNodeId', () => {
  test('entry 自身退化为 self，其余原样', () => {
    expect(toRuntimeNodeId('n1', 'n1')).toBe('self');
    expect(toRuntimeNodeId('n2', 'n1')).toBe('n2');
    expect(toRuntimeNodeId('n2', null)).toBe('n2');
  });
});

describe('patchNodesWithEvent', () => {
  const nodes = [node({ id: 'a', online: false, reach: null }), node({ id: 'b' })];

  test('online 事件更新在线态、到达路径与 inventory 版本', () => {
    const next = patchNodesWithEvent(nodes, {
      nodeId: 'a',
      status: 'online',
      reach: 'relay',
      inventory: { version: '9.9.9' },
    });
    expect(next[0].online).toBe(true);
    expect(next[0].reach).toBe('relay');
    expect(next[0].version).toBe('9.9.9');
    expect(next[1]).toBe(nodes[1]);
  });

  test('offline 事件清掉到达路径', () => {
    const next = patchNodesWithEvent(nodes, {
      nodeId: 'b',
      status: 'offline',
      reach: 'lan',
      inventory: null,
    });
    expect(next[1].online).toBe(false);
    expect(next[1].reach).toBeNull();
  });

  test('revoked 事件把该 node 从列表里摘掉', () => {
    const next = patchNodesWithEvent(nodes, {
      nodeId: 'a',
      status: 'revoked',
      reach: null,
      inventory: null,
    });
    expect(next.map((row) => row.id)).toEqual(['b']);
  });

  test('未知 nodeId 返回原数组引用（不触发重渲染）', () => {
    const next = patchNodesWithEvent(nodes, {
      nodeId: 'zzz',
      status: 'online',
      reach: 'lan',
      inventory: null,
    });
    expect(next).toBe(nodes);
  });
});

describe('sortNodes', () => {
  test('entry 自身第一，其次在线，再按名称', () => {
    const rows = [
      node({ id: 'c', name: 'charlie', online: false }),
      node({ id: 'b', name: 'bravo' }),
      node({ id: 'a', name: 'alpha' }),
    ];
    expect(sortNodes(rows, 'c').map((row) => row.id)).toEqual(['c', 'a', 'b']);
    expect(sortNodes(rows, null).map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('mergeNodes', () => {
  const meshNodes = [
    node({ id: 'entry', name: 'entry', loggedIn: true }),
    node({ id: '远端', name: 'studio', online: false, reach: null, loggedIn: false }),
  ];
  const hubNodes: HubNodeRow[] = [
    {
      id: 'entry',
      name: 'hub-machine',
      status: 'active',
      online: true,
      version: '1.2.3',
      last_seen_at: 1700000000000,
      direct_capable: true,
    },
  ];

  test('mesh 是成员集权威，hub 补充心跳/状态/名称', () => {
    const rows = mergeNodes(meshNodes, hubNodes, { entryNodeId: 'entry', hubNodeId: 'entry' });
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('entry');
    expect(rows[0].runtimeNodeId).toBe('self');
    expect(rows[0].isSelf).toBe(true);
    expect(rows[0].isHub).toBe(true);
    expect(rows[0].name).toBe('hub-machine');
    expect(rows[0].lastSeenAt).toBe(1700000000000);
    expect(rows[0].status).toBe('active');
    expect(rows[0].directCapable).toBe(true);
    expect(rows[0].fingerprint).toHaveLength(16);
  });

  test('hub 不可达时补充字段为 null，mesh 字段照常', () => {
    const rows = mergeNodes(meshNodes, null, { entryNodeId: 'entry', hubNodeId: null });
    expect(rows[1].id).toBe('远端');
    expect(rows[1].runtimeNodeId).toBe('远端');
    expect(rows[1].lastSeenAt).toBeNull();
    expect(rows[1].status).toBeNull();
    expect(rows[1].isHub).toBe(false);
    expect(rows[1].online).toBe(false);
    expect(rows[1].reach).toBeNull();
  });

  test('hub 列表里多出来的 node 不会凭空出现在表里', () => {
    const rows = mergeNodes(meshNodes, [...hubNodes, { ...hubNodes[0], id: 'ghost' }], {
      entryNodeId: 'entry',
      hubNodeId: 'entry',
    });
    expect(rows.map((row) => row.id)).toEqual(['entry', '远端']);
  });
});

describe('hubCandidates', () => {
  test('inventory 标了 hub 角色的排最前', () => {
    const rows = [
      node({ id: 'a' }),
      node({ id: 'b', inventory: { roles: 'hub,node' } }),
      node({ id: 'entry' }),
    ];
    expect(hubCandidates(rows, 'entry')).toEqual(['b', 'entry', 'a']);
  });

  test('没有标志位时 entry 自身优先，其次可达的在线 node', () => {
    const rows = [
      node({ id: 'a', online: false, reach: null }),
      node({ id: 'b', reach: 'relay' }),
      node({ id: 'entry' }),
    ];
    expect(hubCandidates(rows, 'entry')).toEqual(['entry', 'b']);
  });

  test('inventory.hub === true 同样识别', () => {
    const rows = [node({ id: 'h', inventory: { hub: true } })];
    expect(hubCandidates(rows, null)).toEqual(['h']);
  });
});
