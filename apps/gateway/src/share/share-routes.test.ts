import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import type { ShareRecord, ShareSettings } from '@tmex/shared/share';
import type { Server } from 'bun';
import { handleApiRequest } from '../api';
import { createMigratedAuthDb } from '../auth/test-db';
import { type ShareService, createShareService, setShareServiceForTests } from './share-service';
import { ShareStore } from './share-store';
import {
  SHARE_ACCESS_TTL_MS,
  SHARE_COOKIE_PREFIX,
  X_TMEX_CLEAR_SHARE,
  X_TMEX_SET_SHARE,
  X_TMEX_SET_SHARE_MAX_AGE,
} from './share-token';

const fakeServer = {} as Server<unknown>;
let harness: ReturnType<typeof createMigratedAuthDb>;
let service: ShareService;
let clock = 2_000_000;

function snapshot(deviceId: string, windowIds: string[]): StateSnapshotPayload {
  return {
    deviceId,
    session: {
      id: '$0',
      name: 's',
      windows: windowIds.map((id, index) => ({
        id,
        name: `win-${index}`,
        index,
        active: index === 0,
        panes: [{ id: `%${index}`, windowId: id, index: 0, active: true, width: 80, height: 24 }],
      })),
    },
  };
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const init: RequestInit = { method, headers: { ...options.headers } };
  if (options.body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }
  const response = await handleApiRequest(new Request(`http://localhost${path}`, init), fakeServer);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    headers: response.headers,
  };
}

async function createShare(overrides: Record<string, unknown> = {}) {
  const result = await call('POST', '/api/share', {
    body: {
      deviceId: 'dev-1',
      windowId: '@1',
      password: 'secret123',
      expiresInMs: 3_600_000,
      ...overrides,
    },
  });
  return result;
}

beforeEach(() => {
  harness = createMigratedAuthDb();
  clock = 2_000_000;
  service = createShareService({
    store: new ShareStore(harness.db),
    now: () => clock,
    deviceExists: () => true,
    snapshotOf: (deviceId) => (deviceId === 'dev-1' ? snapshot('dev-1', ['@1']) : null),
    hashPassword: async (password) => `plain:${password}`,
    verifyPassword: async (stored, password) => stored === `plain:${password}`,
    autoStartRecorders: false,
    originSources: {
      localNodeId: () => 'node-1',
      hubs: () => [],
      siteUrl: () => 'https://site.example.com',
      tunnelUrl: () => null,
      baseUrl: () => null,
    },
  });
  setShareServiceForTests(service);
});

afterEach(async () => {
  await service.stop();
  harness.close();
});

afterAll(() => {
  setShareServiceForTests(null);
});

describe('分享方 HTTP', () => {
  test('POST /api/share 创建并返回链接与明文口令', async () => {
    const created = await createShare();
    expect(created.status).toBe(200);
    const share = created.body.share as ShareRecord;
    expect(created.body.password).toBe('secret123');
    expect(share.url).toBe(`https://site.example.com/s/${share.id}`);
    expect(share.state).toBe('active');
  });

  test('POST /api/share 校验：口令过短 400、窗口不存在 404、body 非法 400', async () => {
    expect((await createShare({ password: 'abc' })).status).toBe(400);
    expect((await createShare({ password: 'abc' })).body.code).toBe('SHARE_PASSWORD_TOO_SHORT');
    const missing = await createShare({ windowId: '@nope' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('SHARE_WINDOW_NOT_FOUND');
    const bad = await call('POST', '/api/share', { body: { deviceId: 'dev-1' } });
    expect(bad.status).toBe(400);
  });

  test('节点未开启登录时 POST /api/share 返回 409 SHARE_AUTH_REQUIRED', async () => {
    service.setAuthRequiredResolver(() => false);
    const denied = await createShare();
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe('SHARE_AUTH_REQUIRED');
    expect(typeof denied.body.error).toBe('string');
    service.setAuthRequiredResolver(null);
    expect((await createShare()).status).toBe(200);
  });

  test('GET /api/share 返回 active / history，可按 deviceId+windowId 过滤', async () => {
    const created = await createShare();
    const share = created.body.share as ShareRecord;
    const listed = await call('GET', '/api/share');
    expect((listed.body.active as ShareRecord[]).map((item) => item.id)).toEqual([share.id]);
    expect(listed.body.history).toEqual([]);

    const filtered = await call('GET', '/api/share?deviceId=dev-1&windowId=@1');
    expect(filtered.body.active as ShareRecord[]).toHaveLength(1);
    const other = await call('GET', '/api/share?deviceId=dev-9');
    expect(other.body.active).toEqual([]);
  });

  test('POST /api/share/:id/revoke 结束分享；未知 id 404', async () => {
    const created = await createShare();
    const share = created.body.share as ShareRecord;
    const revoked = await call('POST', `/api/share/${share.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect((revoked.body.share as ShareRecord).endReason).toBe('revoked');
    expect((await call('POST', '/api/share/nope/revoke')).status).toBe(404);
  });

  test('DELETE /api/share/:id 仅允许删已结束的记录', async () => {
    const created = await createShare();
    const share = created.body.share as ShareRecord;
    const active = await call('DELETE', `/api/share/${share.id}`);
    expect(active.status).toBe(409);
    await call('POST', `/api/share/${share.id}/revoke`);
    const removed = await call('DELETE', `/api/share/${share.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ ok: true });
    expect((await call('DELETE', `/api/share/${share.id}`)).status).toBe(404);
  });

  test('GET /api/share/:id/log 分页返回 base64 日志', async () => {
    const created = await createShare();
    const share = created.body.share as ShareRecord;
    new ShareStore(harness.db).appendLogEntries(
      share.id,
      [
        { at: 1, kind: 'out', paneId: '%0', data: new TextEncoder().encode('ab') },
        { at: 2, kind: 'out', paneId: '%0', data: new TextEncoder().encode('cd') },
      ],
      1_000_000
    );
    const page = await call('GET', `/api/share/${share.id}/log?limit=1`);
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(2);
    expect(page.body.nextAfter).toBe(1);
    const next = await call('GET', `/api/share/${share.id}/log?after=1&limit=10`);
    expect(next.body.nextAfter).toBeNull();
    expect((await call('GET', '/api/share/nope/log')).status).toBe(404);
  });

  test('GET/PUT /api/share/settings 读写设置', async () => {
    const initial = await call('GET', '/api/share/settings');
    expect(initial.body).toMatchObject({ recordLogs: true, logRetentionDays: 30 });
    const updated = await call('PUT', '/api/share/settings', {
      body: { recordLogs: false, logRetentionDays: 7 },
    });
    expect(updated.body as unknown as ShareSettings).toMatchObject({
      recordLogs: false,
      logRetentionDays: 7,
      logMaxBytes: 52_428_800,
    });
    expect((await call('GET', '/api/share/settings')).body).toEqual(updated.body);
  });

  test('GET /api/share/origins 返回候选与推荐地址', async () => {
    const origins = await call('GET', '/api/share/origins');
    expect(origins.body.recommended).toBe('https://site.example.com');
    expect(origins.body.candidates).toEqual([
      { url: 'https://site.example.com', kind: 'site', label: 'site.example.com' },
    ]);
    expect(origins.body.nodePrefix).toBeNull();
  });
});

describe('被分享人 HTTP', () => {
  test('GET /api/share-access/:id 未登录时不暴露设备与窗口', async () => {
    const created = await createShare();
    const share = created.body.share as ShareRecord;
    const view = await call('GET', `/api/share-access/${share.id}`);
    expect(view.status).toBe(200);
    expect(view.body).toEqual({
      id: share.id,
      name: share.name,
      state: 'active',
      expiresAt: share.expiresAt,
      authenticated: false,
    });
    expect((await call('GET', '/api/share-access/nope')).status).toBe(404);
  });

  test('login 成功走 x-tmex-set-share 头而不是 Set-Cookie', async () => {
    const created = await createShare();
    const share = created.body.share as ShareRecord;
    const login = await call('POST', `/api/share-access/${share.id}/login`, {
      body: { password: 'secret123' },
    });
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);
    expect(login.headers.get('set-cookie')).toBeNull();
    const token = login.headers.get(X_TMEX_SET_SHARE);
    expect(token).toBeTruthy();
    expect(Number(login.headers.get('x-tmex-set-share-max-age'))).toBe(3_600);

    const authed = await call('GET', `/api/share-access/${share.id}`, {
      headers: { cookie: `${SHARE_COOKIE_PREFIX}self=${token}` },
    });
    expect(authed.body).toMatchObject({
      authenticated: true,
      deviceId: 'dev-1',
      windowId: '@1',
    });
  });

  test('长期分享续期时 GET /api/share-access/:id 重新下发 cookie 头', async () => {
    const created = await createShare({ expiresInMs: null });
    const share = created.body.share as ShareRecord;
    const login = await call('POST', `/api/share-access/${share.id}/login`, {
      body: { password: 'secret123' },
    });
    const token = login.headers.get(X_TMEX_SET_SHARE);
    const cookie = `${SHARE_COOKIE_PREFIX}self=${token}`;

    const fresh = await call('GET', `/api/share-access/${share.id}`, { headers: { cookie } });
    expect(fresh.headers.get(X_TMEX_SET_SHARE)).toBeNull();

    clock += SHARE_ACCESS_TTL_MS * 0.6;
    const renewed = await call('GET', `/api/share-access/${share.id}`, { headers: { cookie } });
    expect(renewed.headers.get(X_TMEX_SET_SHARE)).toBe(token);
    expect(Number(renewed.headers.get(X_TMEX_SET_SHARE_MAX_AGE))).toBe(SHARE_ACCESS_TTL_MS / 1000);
  });

  test('任意 tmex_sh_* cookie 只要 shareId 匹配即可回退识别', async () => {
    const created = await createShare();
    const share = created.body.share as ShareRecord;
    const login = await call('POST', `/api/share-access/${share.id}/login`, {
      body: { password: 'secret123' },
    });
    const token = login.headers.get(X_TMEX_SET_SHARE);
    const authed = await call('GET', `/api/share-access/${share.id}`, {
      headers: { cookie: `${SHARE_COOKIE_PREFIX}abcdef=${token}` },
    });
    expect(authed.body.authenticated).toBe(true);
  });

  test('口令错误 401，锁定后 429 带 retryAfterMs', async () => {
    const created = await createShare();
    const share = created.body.share as ShareRecord;
    for (let i = 0; i < 9; i++) {
      const failed = await call('POST', `/api/share-access/${share.id}/login`, {
        body: { password: 'nope' },
      });
      expect(failed.status).toBe(401);
      expect(failed.body.code).toBe('SHARE_PASSWORD_INVALID');
    }
    const locked = await call('POST', `/api/share-access/${share.id}/login`, {
      body: { password: 'nope' },
    });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('SHARE_LOGIN_LOCKED');
    expect(locked.body.retryAfterMs as number).toBeGreaterThan(0);
    expect(locked.headers.get('retry-after')).toBeTruthy();
  });

  test('分享已结束时 login 返回 410，未知分享 404', async () => {
    const created = await createShare();
    const share = created.body.share as ShareRecord;
    await call('POST', `/api/share/${share.id}/revoke`);
    const ended = await call('POST', `/api/share-access/${share.id}/login`, {
      body: { password: 'secret123' },
    });
    expect(ended.status).toBe(410);
    expect(ended.body.code).toBe('SHARE_ENDED');
    const missing = await call('POST', '/api/share-access/nope/login', {
      body: { password: 'secret123' },
    });
    expect(missing.status).toBe(404);
  });

  test('logout 清除凭证并带 x-tmex-clear-share', async () => {
    const created = await createShare();
    const share = created.body.share as ShareRecord;
    const login = await call('POST', `/api/share-access/${share.id}/login`, {
      body: { password: 'secret123' },
    });
    const token = login.headers.get(X_TMEX_SET_SHARE);
    const cookie = `${SHARE_COOKIE_PREFIX}self=${token}`;
    const out = await call('POST', `/api/share-access/${share.id}/logout`, {
      headers: { cookie },
    });
    expect(out.status).toBe(200);
    expect(out.headers.get(X_TMEX_CLEAR_SHARE)).toBe('1');
    const view = await call('GET', `/api/share-access/${share.id}`, { headers: { cookie } });
    expect(view.body.authenticated).toBe(false);
  });
});
