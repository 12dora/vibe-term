import { describe, expect, test } from 'bun:test';
import { ApiClient } from '../client';
import { SetupApi, SetupApiError, probeHealth, readHealthStartedAt } from './setup-api';

type Call = { url: string; init?: RequestInit };

function recorder(responses: (Response | Error)[]): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const client = new ApiClient('', (url, init) => {
    calls.push({ url, init });
    const next = responses[index++];
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? new Response('{}', { status: 200 }));
  });
  return { client, calls };
}

function errorBody(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status });
}

describe('SetupApi.precheck', () => {
  test('POST /api/setup/precheck 带 url，返回可达性', async () => {
    const { client, calls } = recorder([
      Response.json({
        reachable: true,
        isSelf: false,
        status: 200,
        error: null,
        resolvedUrl: 'https://relay.example.com:13443',
        triedPorts: [443, 2053, 13443],
        probed: true,
      }),
    ]);
    const out = await new SetupApi(client).precheck('https://relay.example.com');
    expect(out).toEqual({
      reachable: true,
      isSelf: false,
      status: 200,
      error: null,
      resolvedUrl: 'https://relay.example.com:13443',
      triedPorts: [443, 2053, 13443],
      probed: true,
    });
    expect(calls[0].url).toBe('/api/setup/precheck');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      url: 'https://relay.example.com',
      kind: 'relay',
    });
  });

  test('非 2xx 抛出带 code 与 message 的 SetupApiError', async () => {
    const { client } = recorder([errorBody('not_standalone', 'already in a mesh', 409)]);
    const err = await new SetupApi(client).precheck('https://relay.example.com').catch((e) => e);
    expect(err).toBeInstanceOf(SetupApiError);
    expect((err as SetupApiError).code).toBe('not_standalone');
    expect((err as SetupApiError).message).toBe('already in a mesh');
    expect((err as SetupApiError).status).toBe(409);
  });
});

describe('SetupApi readError 折叠', () => {
  test('JSON 契约错误体解出 code/message，非 JSON 退化为 fallbackCode', async () => {
    const { client } = recorder([errorBody('setup_relay_failed', 'boom', 500)]);
    const jsonErr = await new SetupApi(client)
      .setupRelay({ role: 'relay', relayPublicUrl: 'https://relay.example' })
      .catch((e) => e);
    expect(jsonErr).toBeInstanceOf(SetupApiError);
    expect((jsonErr as SetupApiError).code).toBe('setup_relay_failed');
    expect((jsonErr as SetupApiError).message).toBe('boom');
    expect((jsonErr as SetupApiError).status).toBe(500);

    const { client: client2 } = recorder([new Response('<html>502</html>', { status: 502 })]);
    const nonJsonErr = await new SetupApi(client2)
      .setupRelay({ role: 'relay', relayPublicUrl: 'https://relay.example' })
      .catch((e) => e);
    expect((nonJsonErr as SetupApiError).code).toBe('setup_relay_failed');
    expect((nonJsonErr as SetupApiError).message).toBe('setup_relay_failed');
    expect((nonJsonErr as SetupApiError).status).toBe(502);
  });
});

describe('SetupApi.setupRelay', () => {
  test('POST /api/setup/relay 透传请求体', async () => {
    const { client, calls } = recorder([
      Response.json({
        ok: true,
        role: 'relay,node',
        relayPublicUrl: 'https://relay.example',
        hasPassword: true,
        restarting: true,
        fingerprint: 'abc123',
      }),
    ]);
    const out = await new SetupApi(client).setupRelay({
      role: 'relay,node',
      relayPublicUrl: 'https://relay.example',
      relayPassword: 'tenant-pass',
      username: 'alice',
      password: 'vibeterm-test-pass',
      directEnable: false,
    });
    expect(out.role).toBe('relay,node');
    expect(out.fingerprint).toBe('abc123');
    expect(calls[0].url).toBe('/api/setup/relay');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      role: 'relay,node',
      relayPublicUrl: 'https://relay.example',
      relayPassword: 'tenant-pass',
      username: 'alice',
      password: 'vibeterm-test-pass',
      directEnable: false,
    });
  });

  test('409 not_standalone 映射成 code', async () => {
    const { client } = recorder([errorBody('not_standalone', 'already in a mesh', 409)]);
    const err = await new SetupApi(client)
      .setupRelay({ role: 'relay', relayPublicUrl: 'https://relay.example' })
      .catch((e) => e);
    expect((err as SetupApiError).code).toBe('not_standalone');
    expect((err as SetupApiError).status).toBe(409);
  });
});

describe('SetupApi.relayJoin', () => {
  test('POST /api/setup/relay-join 透传请求体', async () => {
    const { client, calls } = recorder([
      Response.json({
        ok: true,
        relayUrl: 'https://relay.example',
        tenantId: 'tenant-1',
        username: 'alice',
        direct: 'skipped',
        directError: null,
        restarting: true,
      }),
    ]);
    const out = await new SetupApi(client).relayJoin({
      relayUrl: 'https://relay.example',
      tenantId: 'tenant-1',
      password: 'vibeterm-test-pass',
      name: 'studio',
    });
    expect(out.tenantId).toBe('tenant-1');
    expect(calls[0].url).toBe('/api/setup/relay-join');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      relayUrl: 'https://relay.example',
      tenantId: 'tenant-1',
      password: 'vibeterm-test-pass',
      name: 'studio',
    });
  });
});

describe('probeHealth / readHealthStartedAt', () => {
  test('健康响应返回 startedAt', async () => {
    const { client, calls } = recorder([Response.json({ status: 'ok', startedAt: 1700 })]);
    expect(await probeHealth(client)).toEqual({ ok: true, startedAt: 1700 });
    expect(calls[0].url).toBe('/healthz');
  });

  test('网络错误返回 ok:false', async () => {
    const { client } = recorder([new TypeError('connection refused')]);
    expect(await probeHealth(client)).toEqual({ ok: false, startedAt: null });
  });

  test('非 2xx 视为不健康', async () => {
    const { client } = recorder([new Response('', { status: 503 })]);
    expect(await probeHealth(client)).toEqual({ ok: false, startedAt: null });
  });

  test('缺 startedAt 字段时 ok:true 但 startedAt 为 null', async () => {
    const { client } = recorder([Response.json({ status: 'ok' })]);
    expect(await probeHealth(client)).toEqual({ ok: true, startedAt: null });
    const { client: other } = recorder([Response.json({ status: 'ok' })]);
    expect(await readHealthStartedAt(other)).toBeNull();
  });

  test('readHealthStartedAt 直接取数值', async () => {
    const { client } = recorder([Response.json({ startedAt: 42 })]);
    expect(await readHealthStartedAt(client)).toBe(42);
  });
});
