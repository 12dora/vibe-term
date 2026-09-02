import { describe, expect, test } from 'bun:test';
import { ApiClient } from '../client';
import { TlsApi, TlsApiError } from './tls-api';
import type { TlsStatusResponse } from './tls-types';

type Call = { url: string; init?: RequestInit };

function recorder(responses: Response[]): { api: TlsApi; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const client = new ApiClient('', (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(responses[index++] ?? new Response('{}', { status: 200 }));
  });
  return { api: new TlsApi(client), calls };
}

const STATUS: TlsStatusResponse = {
  mode: 'selfsigned',
  https: { source: 'builtin', verified: true, publicUrl: null },
  trustProxy: false,
  tlsPort: 9443,
  bindHost: '0.0.0.0',
  sans: ['hub.lan', '192.168.1.10'],
  caFingerprint: 'a'.repeat(64),
  certificate: {
    subject: 'CN=hub.lan',
    sans: ['hub.lan', '192.168.1.10'],
    notBefore: 1_700_000_000_000,
    notAfter: 1_734_000_000_000,
    issuer: 'CN=tmex local CA',
  },
  listener: { running: true, port: 9443, error: null },
  acme: null,
  restartRequired: false,
};

function errorBody(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status });
}

describe('TlsApi.status', () => {
  test('GET /api/tls 并原样返回契约字段', async () => {
    const { api, calls } = recorder([new Response(JSON.stringify(STATUS), { status: 200 })]);
    const status = await api.status();
    expect(calls[0].url).toBe('/api/tls');
    expect(calls[0].init).toBeUndefined();
    expect(status).toEqual(STATUS);
  });

  test('401 抛出带 code / message 的 TlsApiError', async () => {
    const { api } = recorder([errorBody('unauthorized', 'login required', 401)]);
    const err = (await api.status().catch((e) => e)) as TlsApiError;
    expect(err).toBeInstanceOf(TlsApiError);
    expect(err.code).toBe('unauthorized');
    expect(err.message).toBe('login required');
    expect(err.status).toBe(401);
  });

  test('错误体不可解析时退化为 fallback code', async () => {
    const { api } = recorder([new Response('<html>502</html>', { status: 502 })]);
    const err = (await api.status().catch((e) => e)) as TlsApiError;
    expect(err.code).toBe('tls_status_failed');
    expect(err.status).toBe(502);
  });
});

describe('TlsApi.update', () => {
  test('external 模式 PUT 带 trustProxy 并透传 restartRequired', async () => {
    const { api, calls } = recorder([
      new Response(
        JSON.stringify({ ...STATUS, mode: 'external', trustProxy: true, restartRequired: true }),
        { status: 200 }
      ),
    ]);
    const out = await api.update({ mode: 'external', trustProxy: true });
    expect(calls[0].url).toBe('/api/tls');
    expect(calls[0].init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ mode: 'external', trustProxy: true });
    expect(out.restartRequired).toBe(true);
  });

  test('selfsigned 模式原样送 sans / tlsPort / bindHost', async () => {
    const { api, calls } = recorder([new Response(JSON.stringify(STATUS), { status: 200 })]);
    await api.update({
      mode: 'selfsigned',
      sans: ['hub.lan', '192.168.1.10'],
      tlsPort: 9443,
      bindHost: '0.0.0.0',
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      mode: 'selfsigned',
      sans: ['hub.lan', '192.168.1.10'],
      tlsPort: 9443,
      bindHost: '0.0.0.0',
    });
  });

  test('acme 模式省略 cloudflareToken 时 body 里不出现该键', async () => {
    const { api, calls } = recorder([new Response(JSON.stringify(STATUS), { status: 200 })]);
    await api.update({
      mode: 'acme',
      domain: 'hub.example.com',
      email: 'ops@example.com',
      challenge: 'http-01',
      staging: false,
      tlsPort: 9443,
      bindHost: '0.0.0.0',
    });
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect('cloudflareToken' in body).toBe(false);
    expect(body.challenge).toBe('http-01');
  });

  test('400 invalid_sans 带出契约 message', async () => {
    const { api } = recorder([errorBody('invalid_sans', 'not a hostname: ??', 400)]);
    const err = (await api
      .update({ mode: 'selfsigned', sans: ['??'], tlsPort: 9443, bindHost: '0.0.0.0' })
      .catch((e) => e)) as TlsApiError;
    expect(err.code).toBe('invalid_sans');
    expect(err.message).toBe('not a hostname: ??');
    expect(err.status).toBe(400);
  });

  test('409 port_in_use 也走类型化错误', async () => {
    const { api } = recorder([errorBody('port_in_use', 'address already in use :9443', 409)]);
    const err = (await api
      .update({ mode: 'selfsigned', sans: ['hub.lan'], tlsPort: 9443, bindHost: '0.0.0.0' })
      .catch((e) => e)) as TlsApiError;
    expect(err.code).toBe('port_in_use');
    expect(err.status).toBe(409);
  });

  test('`{error: "..."}` 老形态也认', async () => {
    const { api } = recorder([
      new Response(JSON.stringify({ error: 'tls_failed' }), { status: 500 }),
    ]);
    const err = (await api.update({ mode: 'none' }).catch((e) => e)) as TlsApiError;
    expect(err.code).toBe('tls_failed');
    expect(err.status).toBe(500);
  });
});

describe('TlsApi.renew', () => {
  test('POST /api/tls/renew 无 body', async () => {
    const { api, calls } = recorder([new Response(JSON.stringify(STATUS), { status: 200 })]);
    const out = await api.renew();
    expect(calls[0].url).toBe('/api/tls/renew');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBeUndefined();
    expect(out.mode).toBe('selfsigned');
  });

  test('409 not_applicable', async () => {
    const { api } = recorder([errorBody('not_applicable', 'mode is external', 409)]);
    const err = (await api.renew().catch((e) => e)) as TlsApiError;
    expect(err.code).toBe('not_applicable');
    expect(err.status).toBe(409);
  });
});

describe('TlsApi.caDownloadUrl', () => {
  test('self 走无前缀路径', () => {
    const api = new TlsApi(new ApiClient(''));
    expect(api.caDownloadUrl()).toBe('/api/tls/ca.crt');
  });

  test('带 baseUrl 的 client 会拼上前缀', () => {
    const api = new TlsApi(new ApiClient('/n/0123456789abcdef0123456789abcdef'));
    expect(api.caDownloadUrl()).toBe('/n/0123456789abcdef0123456789abcdef/api/tls/ca.crt');
  });
});
