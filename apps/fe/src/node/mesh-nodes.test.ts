// mesh 节点列表的纯函数：指纹、NODE_EVENT 投影、排序、hub 合并与 hub 候选顺序。

import { describe, expect, test } from 'bun:test';
import type { MeshNode } from '@tmex/api-client/auth/index';
import { wsBorsh } from '@tmex/shared';
import { bytesToHex, encodeBase64url, sha256 } from '@tmex/shared/auth';
import type { HubNodeRow } from './hub-api';
import { decodeMeshFrame } from './mesh-events';
import {
  findHubNodeId,
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

  test('online 事件带上 transport 与 rttMs，offline 一并清掉', () => {
    const online = patchNodesWithEvent(nodes, {
      nodeId: 'a',
      status: 'online',
      reach: 'wan',
      transport: 'ws-secure',
      rttMs: 42,
      inventory: null,
    });
    expect(online[0].reach).toBe('wan');
    expect(online[0].transport).toBe('ws-secure');
    expect(online[0].rttMs).toBe(42);

    const offline = patchNodesWithEvent(online, {
      nodeId: 'a',
      status: 'offline',
      reach: 'wan',
      transport: 'ws-secure',
      rttMs: 42,
      inventory: null,
    });
    expect(offline[0].reach).toBeNull();
    expect(offline[0].transport).toBeNull();
    expect(offline[0].rttMs).toBeNull();
  });

  test('事件没带 transport / rttMs 时保留列表里已有的值', () => {
    const base = patchNodesWithEvent(nodes, {
      nodeId: 'b',
      status: 'online',
      reach: 'lan',
      transport: 'dc',
      rttMs: 7,
      inventory: null,
    });
    const next = patchNodesWithEvent(base, {
      nodeId: 'b',
      status: 'online',
      reach: 'lan',
      inventory: null,
    });
    expect(next[1].transport).toBe('dc');
    expect(next[1].rttMs).toBe(7);
  });

  const linked = () => [
    node({
      id: 'a',
      reach: 'lan',
      transport: 'ws-secure',
      peerAddress: '10.0.0.7',
      linkSinceAt: 1_700_000_000_000,
      directFailure: { at: 1_699_999_000_000, ws: 'timeout ws://10.0.0.9:39001/peer', dc: null },
    }),
    node({ id: 'b' }),
  ];

  test('同一条链路的事件保留只 REST 下发的现场', () => {
    const next = patchNodesWithEvent(linked(), {
      nodeId: 'a',
      status: 'online',
      reach: 'lan',
      transport: 'ws-secure',
      rttMs: 5,
      inventory: null,
    });
    expect(next[0].peerAddress).toBe('10.0.0.7');
    expect(next[0].linkSinceAt).toBe(1_700_000_000_000);
    expect(next[0].directFailure?.ws).toBe('timeout ws://10.0.0.9:39001/peer');
  });

  test('事件没带 transport 时按同一条链路处理，现场照样保留', () => {
    const next = patchNodesWithEvent(linked(), {
      nodeId: 'a',
      status: 'online',
      reach: 'lan',
      inventory: null,
    });
    expect(next[0].transport).toBe('ws-secure');
    expect(next[0].peerAddress).toBe('10.0.0.7');
    expect(next[0].linkSinceAt).toBe(1_700_000_000_000);
  });

  test('换了承载（ws-secure → relay）就把旧链路的现场清掉', () => {
    const next = patchNodesWithEvent(linked(), {
      nodeId: 'a',
      status: 'online',
      reach: 'relay',
      transport: 'relay',
      inventory: null,
    });
    expect(next[0].transport).toBe('relay');
    expect(next[0].peerAddress).toBeNull();
    expect(next[0].linkSinceAt).toBeNull();
    expect(next[0].directFailure).toBeNull();
  });

  test('承载没变但到达路径变了同样清掉旧现场', () => {
    const next = patchNodesWithEvent(linked(), {
      nodeId: 'a',
      status: 'online',
      reach: 'wan',
      transport: 'ws-secure',
      inventory: null,
    });
    expect(next[0].peerAddress).toBeNull();
    expect(next[0].linkSinceAt).toBeNull();
    expect(next[0].directFailure).toBeNull();
  });

  test('offline 事件清掉链路现场', () => {
    const next = patchNodesWithEvent(linked(), {
      nodeId: 'a',
      status: 'offline',
      reach: null,
      inventory: null,
    });
    expect(next[0].peerAddress).toBeNull();
    expect(next[0].linkSinceAt).toBeNull();
    expect(next[0].directFailure).toBeNull();
  });

  test('NODE_EVENT 更新 version / direct_capable / name', () => {
    const next = patchNodesWithEvent(nodes, {
      nodeId: 'a',
      status: 'online',
      reach: 'lan',
      inventory: null,
      version: '2.3.4',
      direct_capable: true,
      name: 'studio',
    });
    expect(next[0].version).toBe('2.3.4');
    expect(next[0].direct_capable).toBe(true);
    expect(next[0].name).toBe('studio');
    expect(next[1]).toBe(nodes[1]);
  });

  test('legacy 四字段 NODE_EVENT 不覆盖已有 direct_capable:true', () => {
    const body = wsBorsh.encodePayload(wsBorsh.schema.NodeEventLegacySchema, {
      nodeId: 'a',
      status: wsBorsh.NODE_EVENT_STATUS_ONLINE,
      reach: 'lan',
      inventory: null,
    });
    const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_NODE_EVENT, body, 1);
    const event = decodeMeshFrame(frame);
    expect(event?.kind).toBe('node-event');
    if (event?.kind !== 'node-event') throw new Error('expected node-event');
    const online = node({ id: 'a', name: 'alpha', direct_capable: true });
    const next = patchNodesWithEvent([online], event.payload);
    expect(next[0]?.direct_capable).toBe(true);
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

  test('transport 与 rttMs 原样带进行；未知取值归一成 null', () => {
    // 线上可能来自更新的 node，出现前端还不认识的枚举值，一律归一成 null 而不是照单全收
    const weird = {
      ...node({ id: 'weird' }),
      reach: 'nonsense',
      transport: 'quic',
      rttMs: -1,
    } as unknown as MeshNode;
    const rows = mergeNodes(
      [
        node({ id: 'entry', reach: 'wan', transport: 'ws-secure', rttMs: 12.4 }),
        node({ id: 'dc', reach: 'lan', transport: 'dc', rttMs: null }),
        weird,
      ],
      null,
      { entryNodeId: 'entry', hubNodeId: null }
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('entry')).toMatchObject({ reach: 'wan', transport: 'ws-secure', rttMs: 12.4 });
    expect(byId.get('dc')).toMatchObject({ reach: 'lan', transport: 'dc', rttMs: null });
    expect(byId.get('weird')).toMatchObject({ reach: null, transport: null, rttMs: null });
  });

  test('mesh 行不带 transport / rttMs 时补 null', () => {
    const rows = mergeNodes([node({ id: 'legacy' })], null, {
      entryNodeId: null,
      hubNodeId: null,
    });
    expect(rows[0].transport).toBeNull();
    expect(rows[0].rttMs).toBeNull();
  });

  test('hub 列表里多出来的 node 不会凭空出现在表里', () => {
    const rows = mergeNodes(meshNodes, [...hubNodes, { ...hubNodes[0], id: 'ghost' }], {
      entryNodeId: 'entry',
      hubNodeId: 'entry',
    });
    expect(rows.map((row) => row.id)).toEqual(['entry', '远端']);
  });
});

describe('findHubNodeId', () => {
  test('只认 mesh 列表里的 isHub 标志位', () => {
    const rows = [node({ id: 'a' }), node({ id: 'b', isHub: true }), node({ id: 'entry' })];
    expect(findHubNodeId(rows, null)).toBe('b');
  });

  test('列表还没到时用 /api/auth/mode 的 hubNodeId', () => {
    expect(findHubNodeId([], 'hub-1')).toBe('hub-1');
  });

  test('inventory 里的 hub 角色不再被当成标志位（启发式已删除）', () => {
    const rows = [node({ id: 'h', inventory: { roles: 'hub,node' } }), node({ id: 'entry' })];
    expect(findHubNodeId(rows, null)).toBeNull();
  });

  test('isHub 优先于 mode 的 hubNodeId', () => {
    const rows = [node({ id: 'b', isHub: true })];
    expect(findHubNodeId(rows, 'stale')).toBe('b');
  });
});

describe('mergeNodes 的 isHub', () => {
  test('mesh 行自带 isHub 时不依赖上下文的 hubNodeId', () => {
    const rows = mergeNodes([node({ id: 'x', isHub: true })], null, {
      entryNodeId: null,
      hubNodeId: null,
    });
    expect(rows[0].isHub).toBe(true);
  });
});
