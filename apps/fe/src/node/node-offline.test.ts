import { describe, expect, test } from 'bun:test';
import { SELF_NODE_ID } from '@tmex/api-client';
import type { MeshNode } from '@tmex/api-client/auth/index';
import { type NodeOfflineSnapshot, isNodeOffline } from './node-offline';

const ENTRY_ID = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const REMOTE_ID = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';

function node(id: string, online: boolean): MeshNode {
  return { id, name: id, publicKey: '', online, loggedIn: true } as MeshNode;
}

function loaded(nodes: MeshNode[], entryNodeId: string | null = ENTRY_ID): NodeOfflineSnapshot {
  return { nodes, entryNodeId, loaded: true };
}

describe('isNodeOffline', () => {
  test('unknown before the first load (standalone included)', () => {
    expect(
      isNodeOffline({ nodes: [], entryNodeId: null, loaded: false }, SELF_NODE_ID)
    ).toBeUndefined();
    expect(
      isNodeOffline({ nodes: [], entryNodeId: ENTRY_ID, loaded: false }, REMOTE_ID)
    ).toBeUndefined();
  });

  test('unknown while the entry node id is still missing', () => {
    expect(isNodeOffline(loaded([], null), SELF_NODE_ID)).toBeUndefined();
  });

  test('self resolves to the entry row', () => {
    expect(isNodeOffline(loaded([node(ENTRY_ID, false)]), SELF_NODE_ID)).toBe(true);
    expect(isNodeOffline(loaded([node(ENTRY_ID, true)]), SELF_NODE_ID)).toBe(false);
  });

  test('a remote node reads its own row, not the entry one', () => {
    const nodes = [node(ENTRY_ID, true), node(REMOTE_ID, false)];
    expect(isNodeOffline(loaded(nodes), REMOTE_ID)).toBe(true);
    expect(isNodeOffline(loaded(nodes), ENTRY_ID)).toBe(false);
  });

  test('entry offline does not drag remote nodes offline', () => {
    const nodes = [node(ENTRY_ID, false), node(REMOTE_ID, true)];
    expect(isNodeOffline(loaded(nodes), REMOTE_ID)).toBe(false);
    expect(isNodeOffline(loaded(nodes), SELF_NODE_ID)).toBe(true);
  });

  test('a row missing from a loaded list counts as offline (revoked / removed)', () => {
    expect(isNodeOffline(loaded([node(ENTRY_ID, true)]), REMOTE_ID)).toBe(true);
    expect(isNodeOffline(loaded([node(ENTRY_ID, true)]), 'c'.repeat(32))).toBe(true);
  });
});
