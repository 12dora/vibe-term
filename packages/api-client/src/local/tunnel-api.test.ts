import { describe, expect, test } from 'bun:test';
import { ApiClient } from '../client';
import { TunnelApiError, fetchTunnelStatus, runTunnelAction } from './tunnel-api';

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

describe('tunnel-api readError 折叠', () => {
  test('契约错误体 `{error:{code,message}}` 解出 code/message', async () => {
    const { client } = recorder([
      new Response(JSON.stringify({ error: { code: 'not_configured', message: 'not enabled' } }), {
        status: 409,
      }),
    ]);
    const error = await fetchTunnelStatus(client).catch((e) => e);
    expect(error).toBeInstanceOf(TunnelApiError);
    expect((error as TunnelApiError).code).toBe('not_configured');
    expect((error as TunnelApiError).message).toBe('not enabled');
    expect((error as TunnelApiError).status).toBe(409);
  });

  test('非 JSON 响应体与顶层字符串老形态都退化为 code:"unknown" + fallback 文案', async () => {
    const { client } = recorder([new Response('<html>502</html>', { status: 502 })]);
    const nonJson = await fetchTunnelStatus(client).catch((e) => e);
    expect((nonJson as TunnelApiError).code).toBe('unknown');
    expect((nonJson as TunnelApiError).message).toBe('Failed to load tunnel status');
    expect((nonJson as TunnelApiError).status).toBe(502);

    const { client: client2 } = recorder([
      new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
    ]);
    const legacyString = await runTunnelAction({ action: 'start' }, client2).catch((e) => e);
    expect((legacyString as TunnelApiError).code).toBe('unknown');
    expect((legacyString as TunnelApiError).message).toBe('Tunnel action failed');
    expect((legacyString as TunnelApiError).status).toBe(500);
  });
});
