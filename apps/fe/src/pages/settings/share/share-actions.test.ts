// 行内动作必须打在行所属的那台节点上：远端那一行的终止 / 删除 / 密码，
// 都要走 `clientFor(row.nodeId)` 取到的客户端，而不是当前路由节点的。

import { describe, expect, test } from 'bun:test';
import type { ApiClient } from '@vibeterm/api-client';
import { createShareRowApi } from './share-actions';
import type { ShareRow } from './share-rows';

interface Call {
  nodeId: string;
  path: string;
  method: string;
  body: unknown;
}

function recordingClients(payload: unknown) {
  const calls: Call[] = [];
  const clientFor = (nodeId: string) =>
    ({
      fetch: (path: string, init?: RequestInit) => {
        calls.push({
          nodeId,
          path,
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      },
    }) as unknown as ApiClient;
  return { calls, api: createShareRowApi(clientFor) };
}

const remote = { id: 'sh2', nodeId: 'node-b', nodeName: 'studio' } as ShareRow;
const local = { id: 'sh1', nodeId: 'self', nodeName: '本机' } as ShareRow;

describe('createShareRowApi', () => {
  test('终止远端那一行走远端节点的客户端', async () => {
    const { calls, api } = recordingClients({ share: { id: 'sh2' } });
    await api.revoke(remote);
    expect(calls).toEqual([
      { nodeId: 'node-b', path: '/api/share/sh2/revoke', method: 'POST', body: null },
    ]);
  });

  test('本机那一行仍走本机客户端', async () => {
    const { calls, api } = recordingClients({ share: { id: 'sh1' } });
    await api.revoke(local);
    expect(calls[0]?.nodeId).toBe('self');
  });

  test('删除历史记录同样按行的节点发', async () => {
    const { calls, api } = recordingClients({});
    await api.remove(remote);
    expect(calls[0]).toMatchObject({ nodeId: 'node-b', path: '/api/share/sh2', method: 'DELETE' });
  });

  test('取密码拆出明文，请求发给行所在节点', async () => {
    const { calls, api } = recordingClients({ password: 'Ab3dEf7h' });
    expect(await api.password(remote)).toBe('Ab3dEf7h');
    expect(calls[0]).toMatchObject({ nodeId: 'node-b', path: '/api/share/sh2/password' });
  });

  test('改密码把载荷送到行所在节点，返回被断开的人数', async () => {
    const { calls, api } = recordingClients({ share: { id: 'sh2' }, endedSessions: 2 });
    expect(await api.changePassword(remote, 'Ab3dEf7h', true)).toBe(2);
    expect(calls[0]).toEqual({
      nodeId: 'node-b',
      path: '/api/share/sh2/password',
      method: 'POST',
      body: { password: 'Ab3dEf7h', endSessions: true },
    });
  });
});
