import { describe, expect, test } from 'bun:test';
import type { MeshNode } from '@vibeterm/api-client/auth/index';
import { type ExplorerNodesInput, explorerNodeOptions } from './explorer-nodes';

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
    expect(result.options).toHaveLength(1);
    expect(result.options[0]).toMatchObject({
      id: 'self',
      meshId: 'self',
      name: '本机',
      isSelf: true,
      usable: true,
    });
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
  });

  test('mesh 成员表还在同步：没有选项，也不 ready', () => {
    const result = explorerNodeOptions(input({ inventoryReady: false, inventoryLoading: true }));
    expect(result).toEqual({ options: [], ready: false });
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
