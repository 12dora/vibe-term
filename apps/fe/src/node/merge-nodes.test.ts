// mergeNodes：mesh 成员集 + pendingMemberIds 占位行。

import { describe, expect, test } from 'bun:test';
import type { MeshNode } from '@vibeterm/api-client/auth/index';
import { mergeNodes } from './merge-nodes';

const ENTRY = 'aa'.repeat(16);
const OTHER = 'bb'.repeat(16);
const PENDING_ID = 'cc'.repeat(16);

function meshNode(id: string, name: string): MeshNode {
  return {
    id,
    name,
    publicKey: '',
    online: true,
    loggedIn: true,
    direct_capable: true,
  } as unknown as MeshNode;
}

const CONTEXT = { entryNodeId: ENTRY };

describe('mergeNodes 的待同步占位行', () => {
  test('pendingMemberIds 里 mesh 没有的 id：追加一行离线占位', () => {
    const rows = mergeNodes([meshNode(ENTRY, 'entry')], {
      ...CONTEXT,
      pendingMemberIds: [PENDING_ID],
    });

    expect(rows.map((row) => row.id)).toEqual([ENTRY, PENDING_ID]);
    const pending = rows[1];
    expect(pending.pending).toBe(true);
    expect(pending.online).toBe(false);
    expect(pending.name).toBe(PENDING_ID.slice(0, 8));
    expect(pending.runtimeNodeId).toBe(PENDING_ID);
    expect(pending.version).toBeNull();
    expect(pending.loggedIn).toBe(false);
    expect(pending.admitMaterial).toBeNull();
  });

  test('mesh 里已经有的同一台绝不重复列出', () => {
    const rows = mergeNodes([meshNode(ENTRY, 'entry'), meshNode(OTHER, 'other')], {
      ...CONTEXT,
      pendingMemberIds: [OTHER],
    });
    expect(rows.map((row) => row.id)).toEqual([ENTRY, OTHER]);
    expect(rows[1].pending).toBe(false);
  });

  test('mesh 行的 paused 透传到 NodeRow；pending 行没有该字段', () => {
    const paused = { ...meshNode(OTHER, 'other'), paused: true } as MeshNode;
    const rows = mergeNodes([meshNode(ENTRY, 'entry'), paused], {
      ...CONTEXT,
      pendingMemberIds: [PENDING_ID],
    });
    expect(rows.find((row) => row.id === OTHER)?.paused).toBe(true);
    expect(rows.find((row) => row.id === ENTRY)?.paused).toBeUndefined();
    expect(rows.find((row) => row.id === PENDING_ID)?.paused).toBeUndefined();
  });

  test('pendingMemberIds 缺失或为空时不产生占位行', () => {
    const rows = mergeNodes([meshNode(ENTRY, 'entry')], CONTEXT);
    expect(rows.map((row) => row.id)).toEqual([ENTRY]);
    expect(rows[0].pending).toBe(false);

    expect(
      mergeNodes([meshNode(ENTRY, 'entry')], { ...CONTEXT, pendingMemberIds: [] }).map(
        (row) => row.id
      )
    ).toEqual([ENTRY]);
  });

  test('多条占位按名称（id 前缀）排序，且排在已接纳成员之后', () => {
    const zulu = 'zz'.repeat(16);
    const alpha = '11'.repeat(16);
    const rows = mergeNodes([meshNode(ENTRY, 'entry')], {
      ...CONTEXT,
      pendingMemberIds: [zulu, alpha],
    });
    expect(rows.map((row) => row.name)).toEqual(['entry', alpha.slice(0, 8), zulu.slice(0, 8)]);
  });

  test('pendingMemberIds 两条同 ID：只留第一条，不产生重复 React key', () => {
    const rows = mergeNodes([], { entryNodeId: null, pendingMemberIds: [PENDING_ID, PENDING_ID] });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(PENDING_ID);
  });
});

describe('mergeNodes 的 lastSeenAt / address', () => {
  test('lastSeenAt 来自 mesh；缺失为 null', () => {
    const mesh = {
      ...meshNode(OTHER, 'studio'),
      lastSeenAt: 1_700_000_111_000,
      peerAddress: '10.0.0.8',
      transport: 'dc' as const,
      endpoints: ['ws://10.0.0.8:39001/peer'],
    };
    const preferMesh = mergeNodes([mesh], CONTEXT);
    expect(preferMesh[0].lastSeenAt).toBe(1_700_000_111_000);
    expect(preferMesh[0].peerAddress).toBe('10.0.0.8');
    expect(preferMesh[0].endpoints).toEqual(['ws://10.0.0.8:39001/peer']);

    const empty = mergeNodes([meshNode(OTHER, 'studio')], CONTEXT);
    expect(empty[0].lastSeenAt).toBeNull();
  });

  test('address：直连 peerAddress > 广告 endpoint > viaRelay', () => {
    const direct = {
      ...meshNode(OTHER, 'studio'),
      transport: 'ws-secure' as const,
      peerAddress: 'office.lan',
      endpoints: ['wss://edge.example/peer'],
    };
    const advertised = {
      ...meshNode(PENDING_ID, 'edge'),
      endpoints: ['ws://10.0.0.9:39001/peer', 'wss://edge.example:39001/peer'],
    };
    const relay = {
      ...meshNode('ee'.repeat(16), 'relayed'),
      transport: 'relay' as const,
      viaRelay: 'https://sh.example',
    };
    const rows = mergeNodes([direct, advertised, relay], CONTEXT);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(OTHER)?.address).toBe('office.lan');
    expect(byId.get(PENDING_ID)?.address).toBe('edge.example:39001');
    expect(byId.get('ee'.repeat(16))?.address).toBe('sh.example');
  });

  test('pending 行 address 为破折号', () => {
    const rows = mergeNodes([], { entryNodeId: null, pendingMemberIds: [PENDING_ID] });
    expect(rows[0].address).toBe('—');
    expect(rows[0].lastSeenAt).toBeNull();
    expect(rows[0].peerAddress).toBeNull();
    expect(rows[0].endpoints).toEqual([]);
  });
});

describe('mergeNodes 对 2.3.6 网关（无 lastSeenAt / peerAddress / endpoints）', () => {
  test('旧 DTO 整行缺这些字段：lastSeenAt 为 null、地址为 —、reach 照常', () => {
    const legacy = { ...meshNode('b'.repeat(32), 'legacy'), online: false } as unknown as MeshNode;
    const rows = mergeNodes([meshNode(ENTRY, 'entry'), legacy], CONTEXT);
    const row = rows.find((item) => item.id === legacy.id);
    expect(row).toBeDefined();
    expect(row?.lastSeenAt ?? null).toBeNull();
    expect(row?.peerAddress ?? null).toBeNull();
    expect(row?.endpoints ?? []).toEqual([]);
    expect(row?.address ?? '—').toBe('—');
  });
});
