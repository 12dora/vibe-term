// 建立 / 删除映射的顺序与回滚。`createNodeApiClient` 走 `globalThis.fetch`，这里整体替换掉。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApiError } from '@vibeterm/api-client';
import type { PendingExportCleanup } from './pending-cleanup';
import {
  createPortMapping,
  deletePortMapping,
  portMapErrorKey,
  retryExportCleanup,
} from './portmap-actions';
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
let pending: PendingExportCleanup[] = [];
const sink = (record: PendingExportCleanup) => {
  pending.push(record);
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  replies = [];
  pending = [];
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

  test('监听节点明确拒绝（4xx）时撤掉目标节点上的放行记录并抛原错', async () => {
    replies = [json({ export: { mapId: 'm1' } }), json({ code: 'port_in_use' }, 409), json({})];

    const error = await createPortMapping({ listen: LISTEN, target: TARGET, name: '' }, sink).catch(
      (e: unknown) => e
    );

    expect((error as ApiError).code).toBe('port_in_use');
    // 明确拒绝不必再查 A 的列表，直接撤放行
    expect(calls[2].url).toBe(`/n/${REMOTE}/api/portmap/exports/m1`);
    expect(calls[2].method).toBe('DELETE');
    expect(pending).toHaveLength(0);
  });

  test('回滚时放行记录删不掉则登记待清理', async () => {
    replies = [
      json({ export: { mapId: 'm1' } }),
      json({ code: 'port_in_use' }, 409),
      json({ code: 'node_unreachable' }, 503),
    ];

    await createPortMapping({ listen: LISTEN, target: TARGET, name: 'db' }, sink).catch(
      () => undefined
    );

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      mapId: 'm1',
      listenMeshId: ENTRY,
      targetMeshId: REMOTE,
      label: 'db',
      confirmed: true,
    });
  });

  test('响应丢了但 A 其实建成了：复核后当作成功，绝不撤放行', async () => {
    replies = [
      json({ export: { mapId: 'm1' } }),
      new Error('network down'),
      json({ maps: [{ id: 'm1', listenPort: 8080 }] }),
    ];

    const map = await createPortMapping({ listen: LISTEN, target: TARGET, name: '' }, sink);

    expect(map.id).toBe('m1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST /n/${REMOTE}/api/portmap/exports`,
      'POST /api/portmap',
      'GET /api/portmap',
    ]);
    expect(pending).toHaveLength(0);
  });

  test('不确定失败且复核后 A 上没有这条映射：撤放行', async () => {
    replies = [
      json({ export: { mapId: 'm1' } }),
      json({ code: 'internal' }, 500),
      json({ maps: [] }),
      json({}),
    ];

    const error = await createPortMapping({ listen: LISTEN, target: TARGET, name: '' }, sink).catch(
      (e: unknown) => e
    );

    expect((error as ApiError).status).toBe(500);
    expect(calls[3].url).toBe(`/n/${REMOTE}/api/portmap/exports/m1`);
    expect(pending).toHaveLength(0);
  });

  test('复核也失败时不动放行记录，只登记未确认的待清理', async () => {
    replies = [
      json({ export: { mapId: 'm1' } }),
      new Error('network down'),
      new Error('network down'),
    ];

    await createPortMapping({ listen: LISTEN, target: TARGET, name: '' }, sink).catch(
      () => undefined
    );

    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'GET']);
    expect(pending).toHaveLength(1);
    expect(pending[0].confirmed).toBe(false);
  });

  test('名称留空时不带 name 字段', async () => {
    replies = [json({ export: { mapId: 'm1' } }), json({ map: { id: 'm1' } })];
    await createPortMapping({ listen: LISTEN, target: TARGET, name: '' });
    expect((calls[1].body as { name?: string }).name).toBeUndefined();
  });
});

describe('deletePortMapping', () => {
  const LISTEN_SIDE = { nodeId: 'self', meshId: ENTRY, host: '127.0.0.1', port: 8080 };
  const TARGET_SIDE = {
    nodeId: REMOTE as string | null,
    meshId: REMOTE,
    host: '127.0.0.1',
    port: 5432,
  };

  function params(overrides: Partial<{ nodeId: string | null }> = {}) {
    return {
      listen: LISTEN_SIDE,
      target: { ...TARGET_SIDE, ...overrides },
      mapId: 'm1',
      name: 'db',
    };
  }

  test('先删监听方，再删目标方的放行记录', async () => {
    replies = [new Response(null, { status: 204 }), new Response(null, { status: 204 })];
    await deletePortMapping(params(), sink);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'DELETE /api/portmap/m1',
      `DELETE /n/${REMOTE}/api/portmap/exports/m1`,
    ]);
    expect(pending).toHaveLength(0);
  });

  test('A 已顺带清掉放行记录时不再请求目标方', async () => {
    replies = [json({ ok: true, exportRemoved: true })];
    await deletePortMapping(params(), sink);
    expect(calls).toHaveLength(1);
    expect(pending).toHaveLength(0);
  });

  test('目标方删不掉则登记待清理', async () => {
    replies = [new Response(null, { status: 204 }), json({ code: 'node_unreachable' }, 503)];
    await deletePortMapping(params(), sink);
    expect(pending).toEqual([
      expect.objectContaining({
        mapId: 'm1',
        listenMeshId: ENTRY,
        targetMeshId: REMOTE,
        label: 'db',
        confirmed: true,
      }),
    ]);
  });

  test('目标方说放行记录不存在等同已清理', async () => {
    replies = [new Response(null, { status: 204 }), json({ code: 'not_found' }, 404)];
    await deletePortMapping(params(), sink);
    expect(pending).toHaveLength(0);
  });

  test('解析不到目标节点时登记待清理', async () => {
    replies = [new Response(null, { status: 204 })];
    await deletePortMapping(params({ nodeId: null }), sink);
    expect(calls).toHaveLength(1);
    expect(pending).toHaveLength(1);
  });

  test('监听方返回 not_found 视为已删，继续清理放行记录', async () => {
    replies = [json({ code: 'not_found' }, 404), new Response(null, { status: 204 })];
    await deletePortMapping(params(), sink);
    expect(calls).toHaveLength(2);
    expect(pending).toHaveLength(0);
  });

  test('监听方其它错误直接抛出，不登记待清理', async () => {
    replies = [json({ code: 'invalid_request' }, 400)];
    const error = await deletePortMapping(params(), sink).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe('invalid_request');
    expect(calls).toHaveLength(1);
    expect(pending).toHaveLength(0);
  });
});

describe('retryExportCleanup', () => {
  const RECORD: PendingExportCleanup = {
    mapId: 'm1',
    listenMeshId: ENTRY,
    targetMeshId: REMOTE,
    label: 'db',
    confirmed: true,
    createdAt: 1,
  };

  test('已确认的记录直接删放行记录', async () => {
    replies = [new Response(null, { status: 204 })];
    expect(
      await retryExportCleanup({ record: RECORD, listenNodeId: 'self', targetNodeId: REMOTE })
    ).toBe('removed');
    expect(calls[0].url).toBe(`/n/${REMOTE}/api/portmap/exports/m1`);
  });

  test('放行记录仍删不掉时保持待清理', async () => {
    replies = [json({ code: 'node_unreachable' }, 503)];
    expect(
      await retryExportCleanup({ record: RECORD, listenNodeId: 'self', targetNodeId: REMOTE })
    ).toBe('pending');
  });

  test('目标节点解析不到时保持待清理', async () => {
    expect(
      await retryExportCleanup({ record: RECORD, listenNodeId: 'self', targetNodeId: null })
    ).toBe('pending');
    expect(calls).toHaveLength(0);
  });

  test('未确认的记录先复核 A：映射还在就不清理', async () => {
    replies = [json({ maps: [{ id: 'm1' }] })];
    expect(
      await retryExportCleanup({
        record: { ...RECORD, confirmed: false },
        listenNodeId: 'self',
        targetNodeId: REMOTE,
      })
    ).toBe('live');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/portmap']);
  });

  test('未确认的记录复核后 A 上确实没有：删放行记录', async () => {
    replies = [json({ maps: [] }), new Response(null, { status: 204 })];
    expect(
      await retryExportCleanup({
        record: { ...RECORD, confirmed: false },
        listenNodeId: 'self',
        targetNodeId: REMOTE,
      })
    ).toBe('removed');
  });

  test('未确认的记录复核不了时不碰放行记录', async () => {
    replies = [new Error('network down')];
    expect(
      await retryExportCleanup({
        record: { ...RECORD, confirmed: false },
        listenNodeId: 'self',
        targetNodeId: REMOTE,
      })
    ).toBe('pending');
    expect(calls).toHaveLength(1);

    expect(
      await retryExportCleanup({
        record: { ...RECORD, confirmed: false },
        listenNodeId: null,
        targetNodeId: REMOTE,
      })
    ).toBe('pending');
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
