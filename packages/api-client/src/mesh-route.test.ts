import { describe, expect, test } from 'bun:test';
import { ApiClient } from './client';
import { MESH_ROUTE_SETTINGS_PATH, getMeshRouteMode, setMeshRouteMode } from './mesh-route';

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

describe('getMeshRouteMode / setMeshRouteMode', () => {
  test('GET /api/settings/mesh-route', async () => {
    const { client, calls } = recorder([
      new Response(JSON.stringify({ mode: 'auto' }), { status: 200 }),
    ]);
    expect(await getMeshRouteMode(client)).toEqual({ mode: 'auto' });
    expect(calls[0]?.url).toBe(MESH_ROUTE_SETTINGS_PATH);
  });

  test('PUT /api/settings/mesh-route { mode }', async () => {
    const { client, calls } = recorder([
      new Response(JSON.stringify({ mode: 'relay' }), { status: 200 }),
    ]);
    expect(await setMeshRouteMode('relay', client)).toEqual({ mode: 'relay' });
    expect(calls[0]?.url).toBe(MESH_ROUTE_SETTINGS_PATH);
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ mode: 'relay' }));
  });

  test('non-OK JSON error uses error.message', async () => {
    const { client } = recorder([
      new Response(
        JSON.stringify({
          code: 'INVALID_MESH_ROUTE_MODE',
          error: {
            code: 'INVALID_MESH_ROUTE_MODE',
            message: 'mode must be auto, direct, or relay',
          },
        }),
        { status: 400 }
      ),
    ]);
    await expect(getMeshRouteMode(client)).rejects.toThrow('mode must be auto, direct, or relay');
  });
});
