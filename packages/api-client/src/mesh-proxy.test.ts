import { describe, expect, test } from 'bun:test';
import { ApiClient } from './client';
import { MESH_PROXY_SETTINGS_PATH, getMeshProxy, setMeshProxy } from './mesh-proxy';

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

describe('getMeshProxy / setMeshProxy', () => {
  test('GET /api/settings/mesh-proxy', async () => {
    const { client, calls } = recorder([
      new Response(JSON.stringify({ meshProxy: 'direct' }), { status: 200 }),
    ]);
    expect(await getMeshProxy(client)).toEqual({ meshProxy: 'direct' });
    expect(calls[0]?.url).toBe(MESH_PROXY_SETTINGS_PATH);
  });

  test('PUT /api/settings/mesh-proxy { meshProxy }', async () => {
    const { client, calls } = recorder([
      new Response(JSON.stringify({ meshProxy: 'system' }), { status: 200 }),
    ]);
    expect(await setMeshProxy('system', client)).toEqual({ meshProxy: 'system' });
    expect(calls[0]?.url).toBe(MESH_PROXY_SETTINGS_PATH);
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ meshProxy: 'system' }));
  });

  test('non-OK JSON error uses error.message', async () => {
    const { client } = recorder([
      new Response(
        JSON.stringify({
          code: 'INVALID_MESH_PROXY_MODE',
          error: {
            code: 'INVALID_MESH_PROXY_MODE',
            message: 'meshProxy must be direct or system',
          },
        }),
        { status: 400 }
      ),
    ]);
    await expect(getMeshProxy(client)).rejects.toThrow('meshProxy must be direct or system');
  });
});
