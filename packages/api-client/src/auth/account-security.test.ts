import { describe, expect, test } from 'bun:test';
import { ApiClient } from '../client';
import { bootstrapLocalAuth, localAuthErrorCode, setLocalAuthEnabled } from './account-security';
import { LocalAuthApiError } from './types';

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

const localAuth = {
  supported: true,
  enabled: true,
  effective: true,
  credentialsPresent: true,
};

describe('local auth client', () => {
  test('bootstrap posts username and password', async () => {
    const { client, calls } = recorder([
      new Response(JSON.stringify({ ok: true, localAuth }), { status: 200 }),
    ]);
    expect(await bootstrapLocalAuth({ username: 'ivy', password: 'secret-pass' }, client)).toEqual(
      localAuth
    );
    expect(calls[0].url).toBe('/api/auth/local/bootstrap');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      username: 'ivy',
      password: 'secret-pass',
    });
  });

  test('set enabled posts {enabled}', async () => {
    const { client, calls } = recorder([
      new Response(JSON.stringify({ ok: true, localAuth }), { status: 200 }),
    ]);
    await setLocalAuthEnabled(false, client);
    expect(calls[0].url).toBe('/api/auth/local');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ enabled: false });
  });

  test('non-2xx becomes LocalAuthApiError with server code', async () => {
    const { client } = recorder([
      new Response(JSON.stringify({ code: 'LOCAL_ONLY' }), { status: 403 }),
    ]);
    const error = await bootstrapLocalAuth({ username: 'a', password: 'b' }, client).catch(
      (err) => err
    );
    expect(error).toBeInstanceOf(LocalAuthApiError);
    expect(localAuthErrorCode(error)).toBe('LOCAL_ONLY');
  });
});
