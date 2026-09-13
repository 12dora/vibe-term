// 多节点通知状态：契约字段必须逐个搬过来——`selfNodeId` 漏掉时开关签不出记录
// （前端不知道该给哪台节点写声明），端到端表现是点开关只弹一条「无法保存」。
// 端点缺席（404 / 501）折成 `supported: false`，不抛英文错误。

import { describe, expect, test } from 'bun:test';
import { MESH_NOTIFICATION_ROUTE } from '@vibeterm/shared';
import { ApiClient } from './client';
import {
  fetchMeshNotificationState,
  meshNotificationQueryKey,
  updateMeshNotificationState,
} from './notifications-mesh';

type Call = { url: string; init?: RequestInit };

function recorder(responses: Response[]): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const client = new ApiClient('', (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(responses[index++] ?? new Response('{}', { status: 200 }));
  });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchMeshNotificationState', () => {
  test('带上本机节点编号与队列计数', async () => {
    const { client, calls } = recorder([
      json({
        supported: true,
        selfNodeId: 'ab'.repeat(16),
        selfEnabled: true,
        sinks: [{ nodeId: 'ab'.repeat(16), name: 'A', self: true, online: true }],
        forwardQueue: { pending: 1, dropped: 2 },
      }),
    ]);
    const state = await fetchMeshNotificationState(client);
    expect(state.selfNodeId).toBe('ab'.repeat(16));
    expect(state.selfEnabled).toBe(true);
    expect(state.sinks).toHaveLength(1);
    expect(state.forwardQueue).toEqual({ pending: 1, dropped: 2 });
    expect(calls[0]?.url).toBe(MESH_NOTIFICATION_ROUTE);
  });

  test('老网关不下发 selfNodeId 时留空，不编造', async () => {
    const { client } = recorder([json({ supported: true, selfEnabled: false, sinks: [] })]);
    const state = await fetchMeshNotificationState(client);
    expect(state.selfNodeId).toBeUndefined();
  });

  test('端点缺席（404 / 501）折成不支持，不抛错', async () => {
    for (const status of [404, 501]) {
      const { client } = recorder([new Response('', { status })]);
      const state = await fetchMeshNotificationState(client);
      expect(state).toEqual({ supported: false, selfEnabled: false, sinks: [] });
    }
  });

  test('其它非 2xx 走 parseApiError，不抛英文 Failed to load', async () => {
    const { client } = recorder([json({ error: 'mesh notify down' }, 500)]);
    const error = await fetchMeshNotificationState(client).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('mesh notify down');
    expect((error as Error).message).not.toContain('Failed to load');
  });

  test('signal 透传到 fetch', async () => {
    const { client, calls } = recorder([json({ supported: true, selfEnabled: false, sinks: [] })]);
    const controller = new AbortController();
    await fetchMeshNotificationState(client, controller.signal);
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });
});

describe('updateMeshNotificationState', () => {
  test('PUT {enabled} 并归一化响应', async () => {
    const { client, calls } = recorder([
      json({
        supported: true,
        selfEnabled: true,
        sinks: [],
      }),
    ]);
    const state = await updateMeshNotificationState(true, client);
    expect(state.selfEnabled).toBe(true);
    expect(calls[0]?.url).toBe(MESH_NOTIFICATION_ROUTE);
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ enabled: true });
  });

  test('非 2xx 走 parseApiError，不抛英文 Failed to update', async () => {
    const { client } = recorder([json({ error: 'cannot toggle' }, 409)]);
    const error = await updateMeshNotificationState(false, client).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('cannot toggle');
    expect((error as Error).message).not.toContain('Failed to update');
  });
});

describe('meshNotificationQueryKey', () => {
  test('与设置广播命名空间对齐', () => {
    expect(meshNotificationQueryKey).toEqual(['notifications-mesh']);
  });
});
