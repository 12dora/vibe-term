import { describe, expect, test } from 'bun:test';
import { ApiClient, ApiError } from './client';
import {
  createPortMap,
  createPortMapExport,
  deletePortMap,
  deletePortMapExport,
  listPortMapExports,
  listPortMaps,
  portMapExportPath,
  portMapPath,
  portProbePath,
  probeListenPort,
  probeTargetPort,
  targetProbePath,
  updatePortMap,
} from './portmap';

class StubApiClient extends ApiClient {
  calls: Array<{ path: string; init?: RequestInit }> = [];

  constructor(
    private responses: Response[],
    baseUrl = ''
  ) {
    super(baseUrl);
  }

  override fetch(path: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ path, init });
    const next = this.responses.shift();
    if (!next) return Promise.reject(new Error('unexpected request'));
    return Promise.resolve(next);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('路径构造', () => {
  test('映射与放行记录路径对 id 转义', () => {
    expect(portMapPath('m/1')).toBe('/api/portmap/m%2F1');
    expect(portMapExportPath('m 1')).toBe('/api/portmap/exports/m%201');
  });

  test('两个探测端点各带 host / port 查询串', () => {
    expect(portProbePath('127.0.0.1', 8080)).toBe('/api/portmap/probe?host=127.0.0.1&port=8080');
    expect(targetProbePath('0.0.0.0', 22)).toBe('/api/portmap/target-probe?host=0.0.0.0&port=22');
  });
});

describe('listPortMaps', () => {
  test('GET 并拆 { maps } 信封', async () => {
    const client = new StubApiClient([jsonResponse({ maps: [{ id: 'm1' }] })], '/n/aa');
    const maps = await listPortMaps(client);
    expect(client.calls[0].path).toBe('/api/portmap');
    expect(maps).toHaveLength(1);
  });

  test('透传 AbortSignal', async () => {
    const client = new StubApiClient([jsonResponse({ maps: [] })]);
    const controller = new AbortController();
    await listPortMaps(client, controller.signal);
    expect(client.calls[0].init?.signal).toBe(controller.signal);
  });
});

describe('createPortMap', () => {
  test('POST 契约请求体并拆 { map } 信封', async () => {
    const client = new StubApiClient([jsonResponse({ map: { id: 'm1', listenPort: 8080 } })]);

    const map = await createPortMap(client, {
      name: 'db',
      listenHost: '127.0.0.1',
      listenPort: 8080,
      targetNodeId: 'bb',
      targetHost: '127.0.0.1',
      targetPort: 5432,
      mapId: 'm1',
    });

    expect(client.calls[0].path).toBe('/api/portmap');
    expect(client.calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(client.calls[0].init?.body)).mapId).toBe('m1');
    expect(map.id).toBe('m1');
  });

  test('端口占用返回 409 时抛带 code 的 ApiError', async () => {
    const client = new StubApiClient([jsonResponse({ code: 'port_in_use' }, 409)]);

    const error = await createPortMap(client, {
      listenPort: 8080,
      targetNodeId: 'bb',
      targetPort: 5432,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('port_in_use');
  });
});

describe('updatePortMap / deletePortMap', () => {
  test('PATCH 只带改动字段', async () => {
    const client = new StubApiClient([jsonResponse({ map: { id: 'm1', paused: true } })]);
    const map = await updatePortMap(client, 'm1', { paused: true });
    expect(client.calls[0].path).toBe('/api/portmap/m1');
    expect(client.calls[0].init?.method).toBe('PATCH');
    expect(JSON.parse(String(client.calls[0].init?.body))).toEqual({ paused: true });
    expect(map.paused).toBe(true);
  });

  test('DELETE 映射；空响应体按「未清理放行记录」处理', async () => {
    const client = new StubApiClient([new Response(null, { status: 204 })]);
    const result = await deletePortMap(client, 'm1');
    expect(client.calls[0].path).toBe('/api/portmap/m1');
    expect(client.calls[0].init?.method).toBe('DELETE');
    expect(result.exportRemoved).toBe(false);
  });

  test('DELETE 映射：响应带 exportRemoved 时透传', async () => {
    const client = new StubApiClient([jsonResponse({ ok: true, exportRemoved: true })]);
    expect(await deletePortMap(client, 'm1')).toEqual({ exportRemoved: true });
  });

  test('DELETE 映射：响应只有 ok 时仍按未清理处理', async () => {
    const client = new StubApiClient([jsonResponse({ ok: true })]);
    expect(await deletePortMap(client, 'm1')).toEqual({ exportRemoved: false });
  });
});

describe('放行记录', () => {
  test('列表拆 { exports } 信封', async () => {
    const client = new StubApiClient([jsonResponse({ exports: [{ mapId: 'm1' }] })]);
    const exports = await listPortMapExports(client);
    expect(client.calls[0].path).toBe('/api/portmap/exports');
    expect(exports[0].mapId).toBe('m1');
  });

  test('创建时带 fromNodeId，拆 { export } 信封', async () => {
    const client = new StubApiClient([
      jsonResponse({ export: { mapId: 'm1', fromNodeId: 'aa', port: 5432 } }),
    ]);
    const created = await createPortMapExport(client, {
      fromNodeId: 'aa',
      host: '127.0.0.1',
      port: 5432,
    });
    expect(client.calls[0].path).toBe('/api/portmap/exports');
    expect(JSON.parse(String(client.calls[0].init?.body)).fromNodeId).toBe('aa');
    expect(created.mapId).toBe('m1');
  });

  test('删除按 mapId', async () => {
    const client = new StubApiClient([new Response(null, { status: 204 })]);
    await deletePortMapExport(client, 'm1');
    expect(client.calls[0].path).toBe('/api/portmap/exports/m1');
    expect(client.calls[0].init?.method).toBe('DELETE');
  });
});

describe('探测', () => {
  test('监听端口探测走 A 侧 probe', async () => {
    const client = new StubApiClient([
      jsonResponse({
        host: '127.0.0.1',
        port: 8080,
        free: false,
        reserved: false,
        usedByMapId: null,
      }),
    ]);
    const probe = await probeListenPort(client, '127.0.0.1', 8080);
    expect(client.calls[0].path).toBe('/api/portmap/probe?host=127.0.0.1&port=8080');
    expect(probe.free).toBe(false);
  });

  test('目标端口探测走 B 侧 target-probe', async () => {
    const client = new StubApiClient([
      jsonResponse({ host: '127.0.0.1', port: 5432, listening: true }),
    ]);
    const probe = await probeTargetPort(client, '127.0.0.1', 5432);
    expect(client.calls[0].path).toBe('/api/portmap/target-probe?host=127.0.0.1&port=5432');
    expect(probe.listening).toBe(true);
  });
});
