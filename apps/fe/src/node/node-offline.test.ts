import { describe, expect, test } from 'bun:test';
import { SELF_NODE_ID } from '@tmex/api-client';
import type { MeshNode } from '@tmex/api-client/auth/index';
import { isNodeOffline } from './node-offline';

const ENTRY_ID = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const REMOTE_ID = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';

function node(id: string, online: boolean): MeshNode {
  return { id, name: id, publicKey: '', online, loggedIn: true } as MeshNode;
}

describe('isNodeOffline', () => {
  test('standalone / 列表还没回来时按在线算', () => {
    expect(isNodeOffline([], null, SELF_NODE_ID)).toBe(false);
    expect(isNodeOffline([], ENTRY_ID, SELF_NODE_ID)).toBe(false);
  });

  test('self 查的是 entry 自身那条', () => {
    expect(isNodeOffline([node(ENTRY_ID, false)], ENTRY_ID, SELF_NODE_ID)).toBe(true);
    expect(isNodeOffline([node(ENTRY_ID, true)], ENTRY_ID, SELF_NODE_ID)).toBe(false);
  });

  test('远端查它自己那条，不受 entry 状态影响', () => {
    const nodes = [node(ENTRY_ID, true), node(REMOTE_ID, false)];
    expect(isNodeOffline(nodes, ENTRY_ID, REMOTE_ID)).toBe(true);
    expect(isNodeOffline(nodes, ENTRY_ID, ENTRY_ID)).toBe(false);
  });

  test('名单里没有这个 node 时按在线算', () => {
    expect(isNodeOffline([node(ENTRY_ID, true)], ENTRY_ID, REMOTE_ID)).toBe(false);
    expect(isNodeOffline([node(ENTRY_ID, true)], ENTRY_ID, 'c'.repeat(32))).toBe(false);
  });

  test('entry 离线时，远端节点各自的在线态不受影响', () => {
    const nodes = [node(ENTRY_ID, false), node(REMOTE_ID, true)];
    expect(isNodeOffline(nodes, ENTRY_ID, REMOTE_ID)).toBe(false);
    expect(isNodeOffline(nodes, ENTRY_ID, SELF_NODE_ID)).toBe(true);
  });
});
