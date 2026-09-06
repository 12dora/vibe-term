import { describe, expect, test } from 'bun:test';
import type { MeshNode } from '@vibeterm/api-client/auth/index';
import {
  findDialogNode,
  firstUsableNode,
  nodeUnavailableReason,
  toDialogNodeOptions,
} from './dialog-nodes';

const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const REMOTE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
const OFFLINE = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';

function node(overrides: Partial<MeshNode> & { id: string; name: string }): MeshNode {
  return {
    publicKey: '',
    online: true,
    reach: 'lan',
    transport: null,
    rttMs: null,
    peerAddress: null,
    linkSinceAt: null,
    endpoints: [],
    directFailure: null,
    dcBreaker: null,
    version: null,
    direct_capable: false,
    inventory: null,
    loggedIn: true,
    ...overrides,
  } as unknown as MeshNode;
}

describe('toDialogNodeOptions', () => {
  test('空列表退化为唯一的本机选项', () => {
    const options = toDialogNodeOptions([], ENTRY, '本机');
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ id: 'self', meshId: ENTRY, name: '本机', usable: true });
  });

  test('standalone（entryNodeId 未知）时 meshId 退回 self', () => {
    expect(toDialogNodeOptions([], null, '本机')[0].meshId).toBe('self');
  });

  test('entry 自身排第一且 id 折成 self，真实 mesh id 留在 meshId', () => {
    const options = toDialogNodeOptions(
      [node({ id: REMOTE, name: 'studio' }), node({ id: ENTRY, name: 'entry' })],
      ENTRY,
      '本机'
    );
    expect(options.map((option) => option.id)).toEqual(['self', REMOTE]);
    expect(options[0].meshId).toBe(ENTRY);
    expect(options[0].isSelf).toBe(true);
    expect(options[1].isSelf).toBe(false);
  });

  test('离线 / 未登录节点仍然列出，但不可用', () => {
    const options = toDialogNodeOptions(
      [
        node({ id: ENTRY, name: 'entry' }),
        node({ id: OFFLINE, name: 'off', online: false }),
        node({ id: REMOTE, name: 'out', loggedIn: false }),
      ],
      ENTRY,
      '本机'
    );
    const byId = new Map(options.map((option) => [option.id, option]));
    expect(byId.get(OFFLINE)?.usable).toBe(false);
    expect(byId.get(REMOTE)?.usable).toBe(false);
    expect(nodeUnavailableReason(byId.get(OFFLINE) as never)).toBe('offline');
    expect(nodeUnavailableReason(byId.get(REMOTE) as never)).toBe('signedOut');
    expect(nodeUnavailableReason(byId.get('self') as never)).toBeNull();
  });
});

describe('findDialogNode / firstUsableNode', () => {
  const options = toDialogNodeOptions(
    [node({ id: ENTRY, name: 'entry', online: false }), node({ id: REMOTE, name: 'studio' })],
    ENTRY,
    '本机'
  );

  test('按运行时 id 找', () => {
    expect(findDialogNode(options, REMOTE)?.name).toBe('studio');
    expect(findDialogNode(options, null)).toBeUndefined();
    expect(findDialogNode(options, 'nope')).toBeUndefined();
  });

  test('第一个可用节点跳过离线的 self', () => {
    expect(firstUsableNode(options)).toBe(REMOTE);
    expect(firstUsableNode([])).toBeNull();
  });
});
