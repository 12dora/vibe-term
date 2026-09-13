import { describe, expect, test } from 'bun:test';
import { ApiClient } from './client';
import { WeixinApi } from './weixin';

type Call = { url: string; init?: RequestInit };

function recorder(responses: Response[]): { api: WeixinApi; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const client = new ApiClient('', (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(responses[index++] ?? new Response('{}', { status: 200 }));
  });
  return { api: new WeixinApi(client), calls };
}

describe('WeixinApi', () => {
  test('lists and creates accounts', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ accounts: [] }), { status: 200 }),
      new Response(JSON.stringify({ success: true, accountId: 'a1' }), { status: 201 }),
    ]);
    expect(await api.listAccounts()).toEqual({ accounts: [] });
    await api.createAccount({ name: 'ops' });
    expect(calls[0].url).toBe('/api/settings/weixin/accounts');
    expect(calls[1].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ name: 'ops' });
  });

  test('login start/status, test, users approve encode ids', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ qrcodeUrl: 'https://q', qrcodeId: 'q1' }), { status: 200 }),
      new Response(JSON.stringify({ status: 'pending', loggedIn: false }), { status: 200 }),
      new Response(JSON.stringify({ success: true }), { status: 200 }),
      new Response(JSON.stringify({ users: [] }), { status: 200 }),
      new Response(JSON.stringify({ user: { userId: 'u:1' } }), { status: 200 }),
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    ]);
    await api.startLogin('acc1');
    await api.loginStatus('acc1');
    await api.testAccount('acc1');
    await api.listUsers('acc1');
    await api.approveUser('acc1', 'user:2');
    await api.deleteAccount('acc1');
    expect(calls[0].url).toBe('/api/settings/weixin/accounts/acc1/login/start');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[1].url).toBe('/api/settings/weixin/accounts/acc1/login/status');
    expect(calls[2].url).toBe('/api/settings/weixin/accounts/acc1/test');
    expect(calls[3].url).toBe('/api/settings/weixin/accounts/acc1/users');
    expect(calls[4].url).toBe('/api/settings/weixin/accounts/acc1/users/user%3A2/approve');
    expect(calls[5].init?.method).toBe('DELETE');
  });
});
