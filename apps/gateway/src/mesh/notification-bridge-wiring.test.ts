// 投递闸门：汇聚声明是随时会变的（撤销记录一落地就变），因此 `deliver` 每次都要重新问
// 一遍，而不是信任入队那一刻的判断——被攻陷的汇聚机可以先让投递失败，等声明撤销后再收重试件。

import { describe, expect, test } from 'bun:test';
import type { MeshNotificationForwardRequest } from '@tmex/shared';
import { MESH_INTERNAL_NOTIFICATION_ROUTE } from '@tmex/shared';
import type { UserStore } from '../auth/user-store';
import { buildMeshNotificationBridge } from './notification-bridge-wiring';

const SELF = 'node-a';

function body(): MeshNotificationForwardRequest {
  return {
    eventType: 'terminal_bell',
    event: {
      site: { name: 'site', url: 'https://a.example' },
      device: { id: 'dev-1', name: 'dev', type: 'local' },
    },
    origin: { nodeId: SELF, nodeName: 'A' },
  };
}

function bridgeWith(declared: Set<string>) {
  const forwarded: Array<{ nodeId: string; path: string }> = [];
  const bridge = buildMeshNotificationBridge({
    selfNodeId: SELF,
    selfName: () => 'A',
    userStore: {} as UserStore,
    listReach: () => new Map(),
    listHubOnline: () => new Set(),
    listedNodes: () => [],
    declaredSinks: () => declared,
    forwardInternalHttp: (nodeId, path) => {
      forwarded.push({ nodeId, path });
      return Promise.resolve(new Response('{}', { status: 202 }));
    },
  });
  return { bridge, forwarded };
}

describe('MeshNotificationBridge 投递闸门', () => {
  test('已声明的汇聚机照常投递', async () => {
    const { bridge, forwarded } = bridgeWith(new Set(['node-b']));
    expect(bridge.sinkAuthorized('node-b')).toBe(true);
    const res = await bridge.deliver('node-b', body());
    expect(res.status).toBe(202);
    expect(forwarded).toEqual([{ nodeId: 'node-b', path: MESH_INTERNAL_NOTIFICATION_ROUTE }]);
  });

  test('声明被撤销后就地回 403，不出网', async () => {
    const declared = new Set(['node-b']);
    const { bridge, forwarded } = bridgeWith(declared);
    declared.delete('node-b');
    expect(bridge.sinkAuthorized('node-b')).toBe(false);
    const res = await bridge.deliver('node-b', body());
    expect(res.status).toBe(403);
    expect(forwarded).toEqual([]);
  });

  test('本机不是转发目标（自己的事件本来就自己发）', () => {
    const { bridge } = bridgeWith(new Set([SELF, 'node-b']));
    expect(bridge.sinkAuthorized(SELF)).toBe(false);
    expect(bridge.sinkAuthorized('node-b')).toBe(true);
  });
});
