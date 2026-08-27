import { describe, expect, test } from 'bun:test';
import { ApiClient } from '../client';
import { InvalidNodeIdError } from '../node-url';
import { AuthApi, nodeAuthPath } from './auth-api';
import { NoPasskeyForOriginError } from './types';

const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

type Call = { url: string; init?: RequestInit };

function recorder(responses: Response[]): { api: AuthApi; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const client = new ApiClient('', (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(responses[index++] ?? new Response('{}', { status: 200 }));
  });
  return { api: new AuthApi(client), calls };
}

describe('nodeAuthPath', () => {
  test('self 不加前缀', () => {
    expect(nodeAuthPath('self', '/api/auth/login')).toBe('/api/auth/login');
  });

  test('其余 node 加 `/n/<id>` 前缀', () => {
    expect(nodeAuthPath(NODE_A, '/api/auth/login')).toBe(`/n/${NODE_A}/api/auth/login`);
  });

  test('与 node-url 共用同一个校验：非法 nodeId 直接抛', () => {
    expect(() => nodeAuthPath('a/b', '/api/auth/login')).toThrow(InvalidNodeIdError);
    expect(() => nodeAuthPath('..', '/api/auth/login')).toThrow(InvalidNodeIdError);
  });
});

describe('AuthApi', () => {
  test('getMode 读 /api/auth/mode', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ mode: 'none', nodeId: 'self' }), { status: 200 }),
    ]);
    const mode = await api.getMode();
    expect(mode.mode).toBe('none');
    expect(calls[0].url).toBe('/api/auth/mode');
  });

  test('challenge POST 到目标 node 并带 uid', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ challenge_id: 'c1', nonce: 'AA', nodePk: 'BB' }), {
        status: 200,
      }),
    ]);
    const out = await api.challenge(NODE_A, 'alice');
    expect(out.challenge_id).toBe('c1');
    expect(calls[0].url).toBe(`/n/${NODE_A}/api/auth/challenge`);
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ uid: 'alice' });
  });

  test('login 401 返回 code 而不是抛异常', async () => {
    const { api } = recorder([
      new Response(JSON.stringify({ code: 'TOTP_REQUIRED' }), { status: 401 }),
    ]);
    const result = await api.login(NODE_A, {
      login: 'a',
      sig: 'b',
      delegation: 'c',
      delegation_sig: 'd',
    });
    expect(result).toEqual({ ok: false, status: 401, code: 'TOTP_REQUIRED' });
  });

  test('login 429 无 body 时回落 RATE_LIMITED', async () => {
    const { api } = recorder([new Response('', { status: 429 })]);
    const result = await api.login('self', {
      login: 'a',
      sig: 'b',
      delegation: 'c',
      delegation_sig: 'd',
    });
    expect(result).toEqual({ ok: false, status: 429, code: 'RATE_LIMITED' });
  });

  test('appendKeyLog 409 返回 KEY_LOG_FORK', async () => {
    const { api } = recorder([
      new Response(JSON.stringify({ code: 'KEY_LOG_FORK' }), { status: 409 }),
    ]);
    expect(await api.appendKeyLog({ bytes: 'x', sig: 'y' })).toEqual({
      ok: false,
      code: 'KEY_LOG_FORK',
    });
  });

  test('listPasskeys 打真实端点；失败一律抛错而不是静默空列表', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ passkeys: [{ credential_id: 'c1' }] }), { status: 200 }),
    ]);
    expect(await api.listPasskeys()).toEqual([{ credential_id: 'c1' }] as never);
    expect(calls[0].url).toBe('/api/auth/passkeys');

    const failing = recorder([new Response('', { status: 404 })]);
    await expect(failing.api.listPasskeys()).rejects.toThrow();
  });

  test('keyLogHead 打 /api/auth/keylog/head', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ seq: 3, hash: 'AA', rootEpoch: 1 }), { status: 200 }),
    ]);
    expect(await api.keyLogHead()).toMatchObject({ seq: 3, rootEpoch: 1 });
    expect(calls[0].url).toBe('/api/auth/keylog/head');
  });

  test('listPublicNodes 打公开的 /api/auth/nodes', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ nodes: [{ id: 'a', name: 'A', online: true }] }), {
        status: 200,
      }),
    ]);
    expect((await api.listPublicNodes()).map((row) => row.id)).toEqual(['a']);
    expect(calls[0].url).toBe('/api/auth/nodes');
  });

  test('appendKeyLog(hubSync) 走 ?hub=sync 并透出 hubAck', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ ok: true, seq: 9, hash: 'HH', hubAck: true }), { status: 200 }),
    ]);
    expect(await api.appendKeyLog({ bytes: 'x', sig: 'y' }, { hubSync: true })).toEqual({
      ok: true,
      seq: 9,
      hash: 'HH',
      hubAck: true,
      hubError: undefined,
    });
    expect(calls[0].url).toBe('/api/auth/keylog?hub=sync');
  });

  test('hub 未确认时 hubAck=false 原样透出（调用方据此保留 pending）', async () => {
    const { api } = recorder([
      new Response(JSON.stringify({ ok: true, seq: 9, hubAck: false, hubError: 'uplink down' }), {
        status: 200,
      }),
    ]);
    expect(await api.appendKeyLog({ bytes: 'x', sig: 'y' }, { hubSync: true })).toMatchObject({
      ok: true,
      hubAck: false,
      hubError: 'uplink down',
    });
  });

  test('listNodes 解包 nodes 字段', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }] }), { status: 200 }),
    ]);
    const nodes = await api.listNodes();
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(calls[0].url).toBe('/api/mesh/nodes');
  });
});

describe('AuthApi.getConnection（F3-4）', () => {
  test('200 → 带 node 前缀取到 connectionId', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ connectionId: 'conn-1' }), { status: 200 }),
    ]);
    expect(await api.getConnection(NODE_A)).toEqual({ ok: true, connectionId: 'conn-1' });
    expect(calls[0].url).toBe(`/n/${NODE_A}/api/mesh/connection`);
    expect(calls[0].init?.headers).toBeUndefined();
  });

  test('传 connectionId 时带 x-tmex-connection 头（多标签定位）', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ connectionId: 'conn-2' }), { status: 200 }),
    ]);
    expect(await api.getConnection('self', { connectionId: 'conn-2' })).toEqual({
      ok: true,
      connectionId: 'conn-2',
    });
    expect(calls[0].url).toBe('/api/mesh/connection');
    expect(calls[0].init?.headers).toEqual({ 'x-tmex-connection': 'conn-2' });
  });

  test('传 cid 时拼进 query（浏览器唯一能带上握手的定位信息）', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ connectionId: 'srv-1' }), { status: 200 }),
    ]);
    expect(await api.getConnection(NODE_A, { cid: 'nonce/+a=' })).toEqual({
      ok: true,
      connectionId: 'srv-1',
    });
    expect(calls[0].url).toBe(`/n/${NODE_A}/api/mesh/connection?cid=nonce%2F%2Ba%3D`);
    // 返回的是**服务端** id，nonce 不能拿去 authorize
    expect(calls[0].init?.headers).toBeUndefined();
  });

  test('404 NO_CONNECTION 不抛异常，透出 status + code', async () => {
    const { api } = recorder([
      new Response(JSON.stringify({ code: 'NO_CONNECTION' }), { status: 404 }),
    ]);
    expect(await api.getConnection(NODE_A)).toEqual({
      ok: false,
      status: 404,
      code: 'NO_CONNECTION',
    });
  });

  test('409 MULTIPLE_CONNECTIONS 同样透出，由调用方决定等待策略', async () => {
    const { api } = recorder([
      new Response(JSON.stringify({ code: 'MULTIPLE_CONNECTIONS', hint: 'send header' }), {
        status: 409,
      }),
    ]);
    expect(await api.getConnection(NODE_A)).toEqual({
      ok: false,
      status: 409,
      code: 'MULTIPLE_CONNECTIONS',
    });
  });

  test('200 但缺 connectionId → MALFORMED', async () => {
    const { api } = recorder([new Response(JSON.stringify({}), { status: 200 })]);
    expect(await api.getConnection(NODE_A)).toEqual({
      ok: false,
      status: 200,
      code: 'MALFORMED',
    });
  });

  test('无 body 的 500 回落到 CONNECTION_LOOKUP_FAILED', async () => {
    const { api } = recorder([new Response('', { status: 500 })]);
    expect(await api.getConnection(NODE_A)).toEqual({
      ok: false,
      status: 500,
      code: 'CONNECTION_LOOKUP_FAILED',
    });
  });
});

describe('passkeyLoginOptions 的 origin 过滤（B2-8）', () => {
  test('404 NO_PASSKEY_FOR_ORIGIN → 可判别的类型化错误，不是泛化 Error', async () => {
    const { api } = recorder([
      new Response(JSON.stringify({ code: 'NO_PASSKEY_FOR_ORIGIN' }), { status: 404 }),
    ]);

    const error = await api.passkeyLoginOptions('alice', 'DELEGATION').then(
      () => null,
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(NoPasskeyForOriginError);
    // 登录页据此提示「本入口没有可用 passkey」
    expect((error as NoPasskeyForOriginError).code).toBe('NO_PASSKEY_FOR_ORIGIN');
  });

  test('别的 404（UNKNOWN_USER）不冒充成「本入口没有 passkey」', async () => {
    const { api } = recorder([
      new Response(JSON.stringify({ code: 'UNKNOWN_USER' }), { status: 404 }),
    ]);
    const error = await api.passkeyLoginOptions('alice', 'DELEGATION').then(
      () => null,
      (err: unknown) => err
    );
    expect(error).not.toBeInstanceOf(NoPasskeyForOriginError);
    expect((error as Error).message).toBe('UNKNOWN_USER');
  });

  test('200 原样返回后端已按精确 origin 过滤过的 allowCredentials', async () => {
    const { api, calls } = recorder([
      new Response(
        JSON.stringify({ challenge: 'CH', rpId: 'node.example', allowCredentials: [{ id: 'a' }] }),
        { status: 200 }
      ),
    ]);
    const options = await api.passkeyLoginOptions('alice', 'DELEGATION');
    expect(options.allowCredentials).toEqual([{ id: 'a' }]);
    expect(calls[0].url).toBe('/api/auth/passkey/login/options');
  });
});
