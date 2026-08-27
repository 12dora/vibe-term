import { describe, expect, test } from 'bun:test';
import { ApiClient } from '../client';
import { AuthApi, nodeAuthPath } from './auth-api';

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

  test('其余 node 加 `/n/<id>` 前缀并转义', () => {
    expect(nodeAuthPath('node-a', '/api/auth/login')).toBe('/n/node-a/api/auth/login');
    expect(nodeAuthPath('a/b', '/api/auth/login')).toBe('/n/a%2Fb/api/auth/login');
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
    const out = await api.challenge('node-a', 'alice');
    expect(out.challenge_id).toBe('c1');
    expect(calls[0].url).toBe('/n/node-a/api/auth/challenge');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ uid: 'alice' });
  });

  test('login 401 返回 code 而不是抛异常', async () => {
    const { api } = recorder([
      new Response(JSON.stringify({ code: 'TOTP_REQUIRED' }), { status: 401 }),
    ]);
    const result = await api.login('node-a', {
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

  test('listPasskeys 在端点缺失（404）时返回空列表', async () => {
    const { api } = recorder([new Response('', { status: 404 })]);
    expect(await api.listPasskeys()).toEqual([]);
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
