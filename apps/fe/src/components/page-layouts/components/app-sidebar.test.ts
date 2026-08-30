// 侧边栏「文件」页的离线判定：路由所在 node 掉线时文件树整块换成一行提示。

import { describe, expect, test } from 'bun:test';
import { SELF_NODE_ID } from '@tmex/api-client';
import type { MeshNode } from '@tmex/api-client/auth/index';
import { isRouteNodeOffline } from './app-sidebar';

const ENTRY_ID = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const REMOTE_ID = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';

function node(id: string, online: boolean): MeshNode {
  return { id, name: id, online } as MeshNode;
}

describe('isRouteNodeOffline', () => {
  test('standalone / 列表还没回来时按在线算', () => {
    expect(isRouteNodeOffline([], null, SELF_NODE_ID)).toBe(false);
    expect(isRouteNodeOffline([], ENTRY_ID, SELF_NODE_ID)).toBe(false);
  });

  test('self 路由查的是 entry 自身那条', () => {
    expect(isRouteNodeOffline([node(ENTRY_ID, false)], ENTRY_ID, SELF_NODE_ID)).toBe(true);
    expect(isRouteNodeOffline([node(ENTRY_ID, true)], ENTRY_ID, SELF_NODE_ID)).toBe(false);
  });

  test('远端路由查它自己那条，不受 entry 状态影响', () => {
    const nodes = [node(ENTRY_ID, true), node(REMOTE_ID, false)];
    expect(isRouteNodeOffline(nodes, ENTRY_ID, REMOTE_ID)).toBe(true);
    expect(isRouteNodeOffline(nodes, ENTRY_ID, ENTRY_ID)).toBe(false);
  });

  test('名单里没有这个 node 时按在线算', () => {
    expect(isRouteNodeOffline([node(ENTRY_ID, true)], ENTRY_ID, REMOTE_ID)).toBe(false);
  });
});
