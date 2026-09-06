// 建立 / 删除映射的顺序与回滚。`createNodeApiClient` 走 `globalThis.fetch`，这里整体替换掉。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApiError } from '@tmex/api-client';
import { createPortMapping, deletePortMapping, portMapErrorKey } from './portmap-actions';
import { flattenPortMaps } from './use-portmap-list';

const REMOTE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const originalFetch = globalThis.fetch;
let calls: Call[] = [];
let replies: Array<Response | Error> = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  replies = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = replies.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? json({}));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const LISTEN = { nodeId: 'self', meshId: ENTRY, host: '127.0.0.1', port: 8080 };
const TARGET = { nodeId: REMOTE, meshId: REMOTE, host: '127.0.0.1', port: 5432 };

describe('createPortMapping', () => {
  test('先在目标节点建放行记录，再拿 mapId 去监听节点建映射', async () => {
    replies = [
      json({ export: { mapId: 'm1', fromNodeId: ENTRY, host: '127.0.0.1', port: 5432 } }),
      json({ map: { id: 'm1', listenPort: 8080 } }),
    ];

    const map = await createPortMapping({ listen: LISTEN, target: TARGET, name: 'db' });

    expect(calls[0].url).toBe(`/n/${REMOTE}/api/portmap/exports`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ fromNodeId: ENTRY, host: '127.0.0.1', port: 5432 });

    expect(calls[1].url).toBe('/api/portmap');
    expect(calls[1].method).toBe('POST');
    expect(calls[1].body).toEqual({
      name: 'db',
      listenHost: '127.0.0.1',
      listenPort: 8080,
      targetNodeId: REMOTE,
      targetHost: '127.0.0.1',
      targetPort: 5432,
      mapId: 'm1',
    });
    expect(map.id).toBe('m1');
  });

  test('监听节点建失败时撤掉目标节点上的放行记录并抛原错', async () => {
    replies = [json({ export: { mapId: 'm1' } }), json({ code: 'port_in_use' }, 409), json({})];

    const error = await createPortMapping({ listen: LISTEN, target: TARGET, name: '' }).catch(
      (e: unknown) => e
    );

    expect((error as ApiError).code).toBe('port_in_use');
    expect(calls[2].url).toBe(`/n/${REMOTE}/api/portmap/exports/m1`);
    expect(calls[2].method).toBe('DELETE');
  });

  test('名称留空时不带 name 字段', async () => {
    replies = [json({ export: { mapId: 'm1' } }), json({ map: { id: 'm1' } })];
    await createPortMapping({ listen: LISTEN, target: TARGET, name: '' });
    expect((calls[1].body as { name?: string }).name).toBeUndefined();
  });
});

describe('deletePortMapping', () => {
  test('先删监听方，再尽力删目标方的放行记录', async () => {
    replies = [new Response(null, { status: 204 }), new Response(null, { status: 204 })];
    await deletePortMapping({ listenNodeId: 'self', targetNodeId: REMOTE, mapId: 'm1' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'DELETE /api/portmap/m1',
      `DELETE /n/${REMOTE}/api/portmap/exports/m1`,
    ]);
  });

  test('目标节点删失败不影响整体成功', async () => {
    replies = [new Response(null, { status: 204 }), json({ code: 'not_found' }, 404)];
    await deletePortMapping({ listenNodeId: 'self', targetNodeId: REMOTE, mapId: 'm1' });
    expect(calls).toHaveLength(2);
  });

  test('解析不到目标节点时只删监听方', async () => {
    replies = [new Response(null, { status: 204 })];
    await deletePortMapping({ listenNodeId: 'self', targetNodeId: null, mapId: 'm1' });
    expect(calls).toHaveLength(1);
  });

  test('监听方删失败直接抛出', async () => {
    replies = [json({ code: 'not_found' }, 404)];
    const error = await deletePortMapping({
      listenNodeId: 'self',
      targetNodeId: REMOTE,
      mapId: 'm1',
    }).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe('not_found');
    expect(calls).toHaveLength(1);
  });
});

describe('portMapErrorKey', () => {
  test('已知码映射到自己的文案，未知码落到 unknown', () => {
    expect(portMapErrorKey(new ApiError(409, 'busy', { code: 'port_in_use' }))).toBe(
      'devices.portmap.errors.port_in_use'
    );
    expect(portMapErrorKey(new ApiError(500, 'boom', { code: 'weird' }))).toBe(
      'devices.portmap.errors.unknown'
    );
    expect(portMapErrorKey(new Error('boom'))).toBe('devices.portmap.errors.unknown');
  });
});

describe('flattenPortMaps', () => {
  test('按节点顺序摊平，并带上监听方的 id 与名字', () => {
    const rows = flattenPortMaps(
      [
        {
          id: 'self',
          meshId: ENTRY,
          name: '本机',
          online: true,
          loggedIn: true,
          isSelf: true,
          usable: true,
        },
        {
          id: REMOTE,
          meshId: REMOTE,
          name: 'studio',
          online: true,
          loggedIn: true,
          isSelf: false,
          usable: true,
        },
      ],
      [{ data: [{ id: 'm1' }] as never }, { data: [{ id: 'm2' }] as never }]
    );
    expect(rows.map((row) => [row.id, row.nodeId, row.nodeName])).toEqual([
      ['m1', 'self', '本机'],
      ['m2', REMOTE, 'studio'],
    ]);
  });

  test('还没返回的节点直接跳过', () => {
    const rows = flattenPortMaps(
      [
        {
          id: 'self',
          meshId: ENTRY,
          name: '本机',
          online: true,
          loggedIn: true,
          isSelf: true,
          usable: true,
        },
      ],
      [{}]
    );
    expect(rows).toEqual([]);
  });
});
