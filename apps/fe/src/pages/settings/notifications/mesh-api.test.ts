// 多节点通知状态的解析：契约字段必须逐个搬过来——`selfNodeId` 漏掉时开关签不出记录
// （前端不知道该给哪台节点写声明），端到端表现是点开关只弹一条「无法保存」。

import { describe, expect, test } from 'bun:test';
import type { ApiClient } from '@vibeterm/api-client';
import { MESH_NOTIFICATION_ROUTE } from '@vibeterm/shared';
import { fetchMeshNotificationState } from './mesh-api';

function client(body: unknown, status = 200): ApiClient {
  return {
    fetch: (path: string) => {
      expect(path).toBe(MESH_NOTIFICATION_ROUTE);
      return Promise.resolve(
        new Response(status === 200 ? JSON.stringify(body) : '', {
          status,
          headers: { 'content-type': 'application/json' },
        })
      );
    },
  } as unknown as ApiClient;
}

describe('fetchMeshNotificationState', () => {
  test('带上本机节点编号与队列计数', async () => {
    const state = await fetchMeshNotificationState(
      client({
        supported: true,
        selfNodeId: 'ab'.repeat(16),
        selfEnabled: true,
        sinks: [{ nodeId: 'ab'.repeat(16), name: 'A', self: true, online: true }],
        forwardQueue: { pending: 1, dropped: 2 },
      })
    );
    expect(state.selfNodeId).toBe('ab'.repeat(16));
    expect(state.selfEnabled).toBe(true);
    expect(state.sinks).toHaveLength(1);
    expect(state.forwardQueue).toEqual({ pending: 1, dropped: 2 });
  });

  test('老网关不下发 selfNodeId 时留空，不编造', async () => {
    const state = await fetchMeshNotificationState(
      client({ supported: true, selfEnabled: false, sinks: [] })
    );
    expect(state.selfNodeId).toBeUndefined();
  });

  test('端点缺席折成不支持', async () => {
    const state = await fetchMeshNotificationState(client(null, 404));
    expect(state).toEqual({ supported: false, selfEnabled: false, sinks: [] });
  });
});
