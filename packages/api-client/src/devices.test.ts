import { describe, expect, test } from 'bun:test';
import type { CreateDeviceRequest, UpdateDeviceRequest } from '@tmex/shared';
import { ApiClient } from './client';
import {
  createDevice,
  deleteDevice,
  fetchDevices,
  reorderDevices,
  testDeviceConnection,
  updateDevice,
} from './devices';

class StubApiClient extends ApiClient {
  calls: Array<{ path: string; init?: RequestInit }> = [];

  constructor(private responses: Response[]) {
    super('');
  }

  override fetch(path: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ path, init });
    const next = this.responses.shift();
    if (!next) {
      return Promise.reject(new Error('unexpected request'));
    }
    return Promise.resolve(next);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('fetchDevices', () => {
  test('GET /api/devices，保留 { devices } 信封返回', async () => {
    const payload = { devices: [{ id: 'dev-1' }, { id: 'dev-2' }] };
    const client = new StubApiClient([jsonResponse(payload)]);

    const result = await fetchDevices(client);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].path).toBe('/api/devices');
    expect(client.calls[0].init).toBeUndefined();
    expect(result.devices.map((d) => d.id)).toEqual(['dev-1', 'dev-2']);
  });

  test('非 2xx 解析 error 字段，缺失时用 fallback', async () => {
    const withError = new StubApiClient([jsonResponse({ error: 'boom' }, 500)]);
    await expect(fetchDevices(withError)).rejects.toThrow('boom');

    const withoutError = new StubApiClient([new Response('oops', { status: 500 })]);
    await expect(fetchDevices(withoutError)).rejects.toThrow('Failed to load devices');
  });
});

describe('createDevice', () => {
  const body: CreateDeviceRequest = {
    name: 'vm',
    type: 'ssh',
    host: 'vm.example',
    port: 2222,
    username: 'root',
    session: 'tmex',
    authMode: 'password',
    password: 's3cret',
  };

  test('POST /api/devices，JSON 序列化请求体并拆信封', async () => {
    const client = new StubApiClient([jsonResponse({ device: { id: 'new-id', name: 'vm' } }, 201)]);

    const device = await createDevice(body, undefined, client);

    expect(client.calls[0].path).toBe('/api/devices');
    expect(client.calls[0].init?.method).toBe('POST');
    expect(client.calls[0].init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(client.calls[0].init?.body).toBe(JSON.stringify(body));
    expect(device.id).toBe('new-id');
  });

  test('失败时优先服务端 error，缺失时用传入 fallback', async () => {
    const withError = new StubApiClient([jsonResponse({ error: 'ssh requires host' }, 400)]);
    await expect(createDevice(body, '创建失败', withError)).rejects.toThrow('ssh requires host');

    const withoutError = new StubApiClient([new Response('oops', { status: 500 })]);
    await expect(createDevice(body, '创建失败', withoutError)).rejects.toThrow('创建失败');
  });
});

describe('updateDevice', () => {
  const patch: UpdateDeviceRequest = { name: 'renamed', host: 'new.example', port: 22 };

  test('PATCH /api/devices/:id，JSON 序列化请求体并拆信封', async () => {
    const client = new StubApiClient([jsonResponse({ device: { id: 'dev-1', name: 'renamed' } })]);

    const device = await updateDevice('dev-1', patch, undefined, client);

    expect(client.calls[0].path).toBe('/api/devices/dev-1');
    expect(client.calls[0].init?.method).toBe('PATCH');
    expect(client.calls[0].init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(client.calls[0].init?.body).toBe(JSON.stringify(patch));
    expect(device.name).toBe('renamed');
  });

  test('失败时抛出传入 fallback', async () => {
    const client = new StubApiClient([new Response('oops', { status: 500 })]);
    await expect(updateDevice('dev-1', patch, '更新失败', client)).rejects.toThrow('更新失败');
  });
});

describe('deleteDevice', () => {
  test('DELETE /api/devices/:id', async () => {
    const client = new StubApiClient([jsonResponse({ success: true })]);

    await deleteDevice('dev-1', undefined, client);

    expect(client.calls[0].path).toBe('/api/devices/dev-1');
    expect(client.calls[0].init?.method).toBe('DELETE');
  });

  test('失败时抛固定文案，不解析响应体 error', async () => {
    const client = new StubApiClient([jsonResponse({ error: 'device not found' }, 404)]);
    await expect(deleteDevice('missing', '删除失败', client)).rejects.toThrow('删除失败');
  });
});

describe('reorderDevices', () => {
  test('PUT /api/devices/order，请求体为 { deviceIds }', async () => {
    const payload = { devices: [{ id: 'b' }, { id: 'a' }] };
    const client = new StubApiClient([jsonResponse(payload)]);

    const result = await reorderDevices(['b', 'a'], client);

    expect(client.calls[0].path).toBe('/api/devices/order');
    expect(client.calls[0].init?.method).toBe('PUT');
    expect(client.calls[0].init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(client.calls[0].init?.body).toBe(JSON.stringify({ deviceIds: ['b', 'a'] }));
    expect(result.devices.map((d) => d.id)).toEqual(['b', 'a']);
  });

  test('非 2xx 抛错', async () => {
    const client = new StubApiClient([jsonResponse({ error: 'invalid request' }, 400)]);
    await expect(reorderDevices(['a'], client)).rejects.toThrow('invalid request');
  });
});

describe('testDeviceConnection', () => {
  test('POST /api/devices/:id/test-connection，200 载荷原样返回（含失败结果）', async () => {
    const failure = {
      success: false,
      tmuxAvailable: false,
      phase: 'connect',
      errorType: 'auth_failed',
      message: 'auth failed',
    };
    const client = new StubApiClient([jsonResponse(failure)]);

    const result = await testDeviceConnection('dev-1', undefined, client);

    expect(client.calls[0].path).toBe('/api/devices/dev-1/test-connection');
    expect(client.calls[0].init?.method).toBe('POST');
    expect(result.success).toBe(false);
    expect(result.message).toBe('auth failed');
  });

  test('非 2xx 解析 error 字段，缺失时用传入 fallback', async () => {
    const withError = new StubApiClient([jsonResponse({ error: 'device not found' }, 404)]);
    await expect(testDeviceConnection('missing', '测试失败', withError)).rejects.toThrow(
      'device not found'
    );

    const withoutError = new StubApiClient([new Response('oops', { status: 500 })]);
    await expect(testDeviceConnection('dev-1', '测试失败', withoutError)).rejects.toThrow(
      '测试失败'
    );
  });
});
