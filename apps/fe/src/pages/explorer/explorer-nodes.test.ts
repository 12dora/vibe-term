import { describe, expect, test } from 'bun:test';
import type { MeshNode } from '@vibeterm/api-client/auth/index';
import type { DialogNodeOption } from '../devices/dialog-nodes';
import { type ExplorerNodesInput, explorerNodeOptions, explorerNodeState } from './explorer-nodes';

const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const REMOTE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';

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

function input(overrides: Partial<ExplorerNodesInput> = {}): ExplorerNodesInput {
  return {
    modeLoaded: true,
    meshEnabled: true,
    entryNodeId: ENTRY,
    nodes: [node({ id: ENTRY, name: 'entry' }), node({ id: REMOTE, name: 'studio' })],
    selfName: '本机',
    inventoryReady: true,
    inventoryLoading: false,
    ...overrides,
  };
}

describe('explorerNodeOptions', () => {
  test('standalone：只有本机一项，立即 ready', () => {
    const result = explorerNodeOptions(input({ meshEnabled: false, entryNodeId: null, nodes: [] }));
    expect(result.ready).toBe(true);
    expect([...result.memberIds]).toEqual(['self']);
    expect(result.options).toHaveLength(1);
    expect(result.options[0]).toMatchObject({
      id: 'self',
      meshId: 'self',
      name: '本机',
      isSelf: true,
      usable: true,
    });
  });

  test('standalone 即使拿到了本机 node id，meshId 也固定为 self', () => {
    const result = explorerNodeOptions(input({ meshEnabled: false, nodes: [] }));
    expect(result.options[0]).toMatchObject({ id: 'self', meshId: 'self' });
  });

  test('模式还没回来：先给本机，但不报 ready（否则远端标签页会被误清）', () => {
    const result = explorerNodeOptions(input({ modeLoaded: false, meshEnabled: false }));
    expect(result.ready).toBe(false);
    expect(result.options.map((option) => option.id)).toEqual(['self']);
  });

  test('mesh 且成员表到齐：列出全部成员，entry 折成 self', () => {
    const result = explorerNodeOptions(input());
    expect(result.ready).toBe(true);
    expect(result.options.map((option) => option.id).sort()).toEqual([REMOTE, 'self'].sort());
    expect(result.options.find((option) => option.id === 'self')?.meshId).toBe(ENTRY);
    expect([...result.memberIds].sort()).toEqual([REMOTE, 'self'].sort());
  });

  test('暂停的成员不在选项里，但仍是成员（标签页不能因此被清掉）', () => {
    const nodes = [
      node({ id: ENTRY, name: 'entry' }),
      node({ id: REMOTE, name: 'studio', paused: true } as Partial<MeshNode> & {
        id: string;
        name: string;
      }),
    ];
    const result = explorerNodeOptions(input({ nodes }));
    expect(result.options.map((option) => option.id)).toEqual(['self']);
    expect(result.memberIds.has(REMOTE)).toBe(true);
    expect(result.memberIds.has('self')).toBe(true);
  });

  test('成员表为空时 entry 自己仍是成员', () => {
    const result = explorerNodeOptions(input({ nodes: [] }));
    expect([...result.memberIds]).toEqual(['self']);
  });

  test('mesh 成员表还在同步：没有选项，也不 ready', () => {
    const result = explorerNodeOptions(input({ inventoryReady: false, inventoryLoading: true }));
    expect(result.options).toEqual([]);
    expect(result.ready).toBe(false);
  });

  test('mesh 首拉失败：退回本机一项，仍不 ready', () => {
    const result = explorerNodeOptions(
      input({ nodes: [], inventoryReady: false, inventoryLoading: false })
    );
    expect(result.ready).toBe(false);
    expect(result.options.map((option) => option.id)).toEqual(['self']);
  });

  test('离线 / 未登录的成员保留在列表里但不可用', () => {
    const nodes = [
      node({ id: ENTRY, name: 'entry' }),
      node({ id: REMOTE, name: 'studio', online: false }),
    ];
    const remote = explorerNodeOptions(input({ nodes })).options.find(
      (option) => option.id === REMOTE
    );
    expect(remote).toMatchObject({ online: false, usable: false });
  });
});

describe('explorerNodeState', () => {
  const option = (overrides: Partial<DialogNodeOption> = {}): DialogNodeOption => ({
    id: REMOTE,
    meshId: REMOTE,
    name: 'studio',
    online: true,
    loggedIn: true,
    isSelf: false,
    usable: true,
    ...overrides,
  });

  test('在线且已登录 → ready', () => {
    expect(explorerNodeState(option(), true)).toBe('ready');
  });

  test('离线优先于未登录', () => {
    expect(explorerNodeState(option({ online: false, usable: false }), true)).toBe('offline');
    expect(explorerNodeState(option({ online: false, loggedIn: false, usable: false }), true)).toBe(
      'offline'
    );
    expect(explorerNodeState(option({ loggedIn: false, usable: false }), true)).toBe('signedOut');
  });

  test('不在选项里：仍是成员 → paused，否则 → missing', () => {
    expect(explorerNodeState(undefined, true)).toBe('paused');
    expect(explorerNodeState(undefined, false)).toBe('missing');
  });
});
