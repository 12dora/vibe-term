import { describe, expect, test } from 'bun:test';
import { ApiClient } from '../client';
import { LocalApi, LocalApiError } from './local-api';
import type { LocalStatusResponse } from './types';

type Call = { url: string; init?: RequestInit };

function recorder(responses: Response[]): { api: LocalApi; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const client = new ApiClient('', (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(responses[index++] ?? new Response('{}', { status: 200 }));
  });
  return { api: new LocalApi(client), calls };
}

const STATUS: LocalStatusResponse = {
  role: 'hub,node',
  nodeEnv: 'production',
  hubUrl: null,
  hubPublicUrl: 'https://hub.example',
  direct: {
    supported: true,
    installed: true,
    enabled: true,
    capable: true,
    version: '1.2.3',
    platform: 'darwin-arm64',
  },
  tls: { mode: 'none', listenerRunning: false, tlsPort: null },
  domainAccess: { allowed: true, viaDomain: false, hosts: [] },
};

function errorBody(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status });
}

describe('LocalApi.status', () => {
  test('GET /api/local/status 并原样返回契约字段', async () => {
    const { api, calls } = recorder([new Response(JSON.stringify(STATUS), { status: 200 })]);
    const status = await api.status();
    expect(calls[0].url).toBe('/api/local/status');
    expect(calls[0].init).toBeUndefined();
    expect(status).toEqual(STATUS);
  });

  test('401 抛出带 code / message 的 LocalApiError', async () => {
    const { api } = recorder([errorBody('unauthorized', 'login required', 401)]);
    const err = (await api.status().catch((e) => e)) as LocalApiError;
    expect(err).toBeInstanceOf(LocalApiError);
    expect(err.code).toBe('unauthorized');
    expect(err.message).toBe('login required');
    expect(err.status).toBe(401);
  });

  test('错误体不可解析时退化为 fallback code', async () => {
    const { api } = recorder([new Response('<html>502</html>', { status: 502 })]);
    const err = (await api.status().catch((e) => e)) as LocalApiError;
    expect(err.code).toBe('local_status_failed');
    expect(err.status).toBe(502);
  });
});

describe('LocalApi.setDirect', () => {
  test('POST /api/local/direct 带 action JSON body', async () => {
    const { api, calls } = recorder([
      new Response(
        JSON.stringify({
          ok: true,
          installed: true,
          enabled: true,
          capable: true,
          restartRequired: true,
        }),
        { status: 200 }
      ),
    ]);
    const out = await api.setDirect('install');
    expect(calls[0].url).toBe('/api/local/direct');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ action: 'install' });
    expect(out).toEqual({
      ok: true,
      installed: true,
      enabled: true,
      capable: true,
      restartRequired: true,
    });
  });

  test('disable 时透传 enabled 与 restartRequired', async () => {
    const { api, calls } = recorder([
      new Response(
        JSON.stringify({
          ok: true,
          installed: true,
          enabled: false,
          capable: true,
          restartRequired: true,
        }),
        {
          status: 200,
        }
      ),
    ]);
    const out = await api.setDirect('disable');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ action: 'disable' });
    expect(out.enabled).toBe(false);
    expect(out.restartRequired).toBe(true);
  });

  test('409 direct_unsupported 带出契约 message', async () => {
    const { api } = recorder([
      errorBody('direct_unsupported', 'no pinned manifest for linux-riscv64', 409),
    ]);
    const err = (await api.setDirect('install').catch((e) => e)) as LocalApiError;
    expect(err.code).toBe('direct_unsupported');
    expect(err.message).toBe('no pinned manifest for linux-riscv64');
    expect(err.status).toBe(409);
  });

  test('`{error: "..."}` 老形态也认', async () => {
    const { api } = recorder([
      new Response(JSON.stringify({ error: 'direct_failed' }), { status: 500 }),
    ]);
    const err = (await api.setDirect('enable').catch((e) => e)) as LocalApiError;
    expect(err.code).toBe('direct_failed');
    expect(err.status).toBe(500);
  });
});

describe('LocalApi.leave', () => {
  test('POST /api/local/leave 带 expectedRole JSON body', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ ok: true, fromRole: 'node', restarting: true }), {
        status: 200,
      }),
    ]);
    const out = await api.leave({ expectedRole: 'node' });
    expect(calls[0].url).toBe('/api/local/leave');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ expectedRole: 'node' });
    expect(out).toEqual({ ok: true, fromRole: 'node', restarting: true });
  });

  test('401 unauthorized 带出契约 code', async () => {
    const { api } = recorder([errorBody('unauthorized', 'login required', 401)]);
    const err = (await api.leave({ expectedRole: 'hub,node' }).catch((e) => e)) as LocalApiError;
    expect(err).toBeInstanceOf(LocalApiError);
    expect(err.code).toBe('unauthorized');
    expect(err.status).toBe(401);
  });
});
