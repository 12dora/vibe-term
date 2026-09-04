import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { Server } from 'bun';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { deleteWeixinAccount, ensureSiteSettingsInitialized, getAllWeixinAccounts } from '../db';
import { getDb as getOrmDb } from '../db/client';
import { t } from '../i18n';
import { weixinService } from '../weixin/service';
import { handleApiRequest } from './index';

const fakeServer = {} as unknown as Server<unknown>;

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureSiteSettingsInitialized();
  // 测试库共享：清空既有微信账号，避免单例 refresh() 接管其它测试遗留的已登录账号去打真实网络。
  for (const account of getAllWeixinAccounts()) {
    deleteWeixinAccount(account.id);
  }
});

afterAll(async () => {
  await weixinService.stopAll();
});

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function bodyOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type AccountEntry = {
  id: string;
  name: string;
  loggedIn: boolean;
  authorizedCount: number;
};

describe('weixin account api routing', () => {
  test('account lifecycle: create / list / patch / users / login-status / delete', async () => {
    const created = await handleApiRequest(
      req('POST', '/api/settings/weixin/accounts', { name: 'wx-api' }),
      fakeServer
    );
    expect(created.status).toBe(201);
    const { accountId } = await bodyOf<{ accountId: string }>(created);
    expect(accountId).toBeTruthy();

    const list = await bodyOf<{ accounts: AccountEntry[] }>(
      await handleApiRequest(req('GET', '/api/settings/weixin/accounts'), fakeServer)
    );
    const entry = list.accounts.find((a) => a.id === accountId);
    expect(entry).toMatchObject({ name: 'wx-api', loggedIn: false, authorizedCount: 0 });

    const patched = await handleApiRequest(
      req('PATCH', `/api/settings/weixin/accounts/${accountId}`, {
        name: 'wx-api-2',
        allowAuthRequests: false,
      }),
      fakeServer
    );
    expect(patched.status).toBe(200);

    const usersRes = await handleApiRequest(
      req('GET', `/api/settings/weixin/accounts/${accountId}/users`),
      fakeServer
    );
    expect(usersRes.status).toBe(200);
    expect((await bodyOf<{ users: unknown[] }>(usersRes)).users).toEqual([]);

    const statusRes = await handleApiRequest(
      req('GET', `/api/settings/weixin/accounts/${accountId}/login/status`),
      fakeServer
    );
    expect(statusRes.status).toBe(200);
    expect((await bodyOf<{ loggedIn: boolean }>(statusRes)).loggedIn).toBe(false);

    const del = await handleApiRequest(
      req('DELETE', `/api/settings/weixin/accounts/${accountId}`),
      fakeServer
    );
    expect(del.status).toBe(200);

    const list2 = await bodyOf<{ accounts: AccountEntry[] }>(
      await handleApiRequest(req('GET', '/api/settings/weixin/accounts'), fakeServer)
    );
    expect(list2.accounts.some((a) => a.id === accountId)).toBe(false);
  });

  test('create requires non-empty name', async () => {
    const res = await handleApiRequest(
      req('POST', '/api/settings/weixin/accounts', { name: '   ' }),
      fakeServer
    );
    expect(res.status).toBe(400);
  });

  test('unknown account returns 404', async () => {
    const res = await handleApiRequest(
      req('GET', '/api/settings/weixin/accounts/does-not-exist/users'),
      fakeServer
    );
    expect(res.status).toBe(404);
  });

  test('POST /api/settings/weixin/accounts rejects null body', async () => {
    const res = await handleApiRequest(
      req('POST', '/api/settings/weixin/accounts', null),
      fakeServer
    );
    expect(res.status).toBe(400);
    expect(await bodyOf<{ error: string }>(res)).toEqual({ error: t('apiError.invalidRequest') });
  });

  test('POST /api/settings/weixin/accounts rejects wrong-type fields', async () => {
    const nameType = await handleApiRequest(
      req('POST', '/api/settings/weixin/accounts', { name: 42 }),
      fakeServer
    );
    expect(nameType.status).toBe(400);
    expect(await bodyOf<{ error: string }>(nameType)).toEqual({
      error: t('weixin.accountNameRequired'),
    });

    const enabledType = await handleApiRequest(
      req('POST', '/api/settings/weixin/accounts', { name: 'wx-typed', enabled: 'yes' }),
      fakeServer
    );
    expect(enabledType.status).toBe(400);
    expect(await bodyOf<{ error: string }>(enabledType)).toEqual({
      error: t('apiError.invalidRequest'),
    });
  });

  test('PATCH /api/settings/weixin/accounts/:accountId rejects null body and wrong-type fields', async () => {
    const created = await handleApiRequest(
      req('POST', '/api/settings/weixin/accounts', { name: 'wx-patch-body' }),
      fakeServer
    );
    expect(created.status).toBe(201);
    const { accountId } = await bodyOf<{ accountId: string }>(created);

    const nullBody = await handleApiRequest(
      req('PATCH', `/api/settings/weixin/accounts/${accountId}`, null),
      fakeServer
    );
    expect(nullBody.status).toBe(400);
    expect(await bodyOf<{ error: string }>(nullBody)).toEqual({
      error: t('apiError.invalidRequest'),
    });

    const nameType = await handleApiRequest(
      req('PATCH', `/api/settings/weixin/accounts/${accountId}`, { name: 42 }),
      fakeServer
    );
    expect(nameType.status).toBe(400);
    expect(await bodyOf<{ error: string }>(nameType)).toEqual({
      error: t('weixin.accountNameRequired'),
    });

    const flagType = await handleApiRequest(
      req('PATCH', `/api/settings/weixin/accounts/${accountId}`, { allowAuthRequests: 1 }),
      fakeServer
    );
    expect(flagType.status).toBe(400);
    expect(await bodyOf<{ error: string }>(flagType)).toEqual({
      error: t('apiError.invalidRequest'),
    });

    const commandsType = await handleApiRequest(
      req('PATCH', `/api/settings/weixin/accounts/${accountId}`, { allowCommands: 1 }),
      fakeServer
    );
    expect(commandsType.status).toBe(400);
    expect(await bodyOf<{ error: string }>(commandsType)).toEqual({
      error: t('apiError.invalidRequest'),
    });

    await handleApiRequest(req('DELETE', `/api/settings/weixin/accounts/${accountId}`), fakeServer);
  });
});
