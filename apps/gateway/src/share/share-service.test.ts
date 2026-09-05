import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { createMigratedAuthDb } from '../auth/test-db';
import { type ShareService, type ShareServiceDeps, createShareService } from './share-service';
import { ShareStore } from './share-store';
import { SHARE_ACCESS_TTL_MS, parseShareToken } from './share-token';
import type { ShareEndedEvent } from './types';

let harness: ReturnType<typeof createMigratedAuthDb>;
let store: ShareStore;
let clock = 1_000_000;
let snapshots: Map<string, StateSnapshotPayload | null>;
let devices: Set<string>;

function snapshotWith(deviceId: string, windowIds: string[]): StateSnapshotPayload {
  return {
    deviceId,
    session: {
      id: '$0',
      name: 'tmex-test',
      windows: windowIds.map((id, index) => ({
        id,
        name: `win-${index}`,
        index,
        active: index === 0,
        panes: [
          {
            id: `%${index}`,
            windowId: id,
            index: 0,
            active: true,
            width: 80,
            height: 24,
          },
        ],
      })),
    },
  };
}

function makeService(overrides: ShareServiceDeps = {}): ShareService {
  return createShareService({
    store,
    now: () => clock,
    deviceExists: (deviceId) => devices.has(deviceId),
    snapshotOf: (deviceId) => snapshots.get(deviceId) ?? null,
    hashPassword: async (password) => `plain:${password}`,
    verifyPassword: async (stored, password) => stored === `plain:${password}`,
    autoStartRecorders: false,
    originSources: {
      localNodeId: () => 'node-1',
      hubs: () => [{ hubNodeId: 'hub-1', publicUrl: 'https://hub.example.com', name: 'hub' }],
      siteUrl: () => 'https://site.example.com',
      tunnelUrl: () => 'https://tunnel.example.com',
      baseUrl: () => 'http://127.0.0.1:9663',
    },
    ...overrides,
  });
}

async function createShare(
  service: ShareService,
  overrides: Partial<Parameters<ShareService['create']>[0]> = {}
) {
  const result = await service.create({
    deviceId: 'dev-1',
    windowId: '@1',
    name: null,
    password: 'secret123',
    expiresInMs: 3_600_000,
    origin: null,
    ...overrides,
  });
  if (!result.ok) throw new Error(`create failed: ${result.code}`);
  return result;
}

beforeEach(() => {
  harness = createMigratedAuthDb();
  store = new ShareStore(harness.db);
  clock = 1_000_000;
  devices = new Set(['dev-1']);
  snapshots = new Map([['dev-1', snapshotWith('dev-1', ['@1', '@2'])]]);
});

afterEach(() => {
  harness.close();
});

describe('create', () => {
  test('成功创建：快照 windowName、按推荐地址生成 URL、返回明文口令', async () => {
    const service = makeService();
    const result = await createShare(service);
    expect(result.password).toBe('secret123');
    expect(result.share.windowName).toBe('win-0');
    expect(result.share.name).toBe('win-0');
    expect(result.share.state).toBe('active');
    expect(result.share.recordLog).toBe(true);
    expect(result.share.expiresAt).toBe(clock + 3_600_000);
    expect(result.share.origin).toBe('https://site.example.com');
    expect(result.share.url).toBe(`https://site.example.com/s/${result.share.id}`);
    expect(result.share.id).toHaveLength(22);
  });

  test('hub 地址带节点前缀', async () => {
    const service = makeService();
    const result = await createShare(service, { origin: 'https://hub.example.com' });
    expect(result.share.url).toBe(`https://hub.example.com/n/node-1/s/${result.share.id}`);
  });

  test('口令过短 / 窗口不存在 / 地址非公网都被拒', async () => {
    const service = makeService();
    await expect(
      service.create({
        deviceId: 'dev-1',
        windowId: '@1',
        password: 'abc',
        expiresInMs: null,
      })
    ).resolves.toEqual({ ok: false, code: 'SHARE_PASSWORD_TOO_SHORT' });
    await expect(
      service.create({
        deviceId: 'dev-1',
        windowId: '@nope',
        password: 'secret123',
        expiresInMs: null,
      })
    ).resolves.toEqual({ ok: false, code: 'SHARE_WINDOW_NOT_FOUND' });
    await expect(
      service.create({
        deviceId: 'dev-1',
        windowId: '@1',
        password: 'secret123',
        expiresInMs: null,
        origin: 'http://192.168.1.9:9663',
      })
    ).resolves.toEqual({ ok: false, code: 'SHARE_ORIGIN_INVALID' });
  });

  test('recordLog 按设置快照', async () => {
    const service = makeService();
    service.updateSettings({ recordLogs: false });
    const result = await createShare(service);
    expect(result.share.recordLog).toBe(false);
  });

  test('永久分享 expiresAt 为 null', async () => {
    const service = makeService();
    const result = await createShare(service, { expiresInMs: null });
    expect(result.share.expiresAt).toBeNull();
  });
});

describe('list / revoke / remove / onEnded', () => {
  test('list 拆分进行中与历史，viewers 走计数器', async () => {
    const service = makeService();
    const first = await createShare(service);
    clock += 10;
    const second = await createShare(service, { windowId: '@2' });
    service.setViewerCounter((shareId) => (shareId === first.share.id ? 3 : 0));
    service.revoke(second.share.id);

    const listed = service.list();
    expect(listed.active.map((item) => item.id)).toEqual([first.share.id]);
    expect(listed.active[0]?.viewers).toBe(3);
    expect(listed.history.map((item) => item.id)).toEqual([second.share.id]);
    expect(listed.history[0]?.viewers).toBe(0);
    expect(listed.history[0]?.endReason).toBe('revoked');
    expect(service.list({ windowId: '@2' }).history).toHaveLength(1);
  });

  test('onEnded 在终止时触发一次，退订后不再触发', async () => {
    const service = makeService();
    const events: ShareEndedEvent[] = [];
    const off = service.onEnded((event) => events.push(event));
    const created = await createShare(service);
    service.revoke(created.share.id);
    service.revoke(created.share.id);
    expect(events).toEqual([{ shareId: created.share.id, reason: 'revoked' }]);
    off();
    const other = await createShare(service);
    service.revoke(other.share.id);
    expect(events).toHaveLength(1);
  });

  test('remove 只删已结束的分享', async () => {
    const service = makeService();
    const created = await createShare(service);
    expect(service.remove(created.share.id)).toBe(false);
    service.revoke(created.share.id);
    expect(service.remove(created.share.id)).toBe(true);
    expect(service.get(created.share.id)).toBeNull();
  });
});

describe('过期 / 窗口关闭 / 设备删除', () => {
  test('watchTick 在到期后结束分享', async () => {
    const service = makeService();
    const created = await createShare(service, { expiresInMs: 1_000 });
    const events: ShareEndedEvent[] = [];
    service.onEnded((event) => events.push(event));
    clock += 999;
    service.watchTick();
    expect(service.get(created.share.id)?.state).toBe('active');
    clock += 2;
    service.watchTick();
    expect(service.get(created.share.id)?.endReason).toBe('expired');
    expect(events).toEqual([{ shareId: created.share.id, reason: 'expired' }]);
  });

  test('窗口从快照消失 → window_closed', async () => {
    const service = makeService();
    const created = await createShare(service);
    snapshots.set('dev-1', snapshotWith('dev-1', ['@2']));
    service.watchTick();
    expect(service.get(created.share.id)?.endReason).toBe('window_closed');
  });

  test('快照缺失时不误判窗口关闭', async () => {
    const service = makeService();
    const created = await createShare(service);
    snapshots.set('dev-1', null);
    service.watchTick();
    expect(service.get(created.share.id)?.state).toBe('active');
  });

  test('设备被删除 → device_removed', async () => {
    const service = makeService();
    const created = await createShare(service);
    devices.delete('dev-1');
    service.watchTick();
    expect(service.get(created.share.id)?.endReason).toBe('device_removed');
  });

  test('startSweeper 启动时收掉已过期的分享', async () => {
    const service = makeService();
    const created = await createShare(service, { expiresInMs: 1_000 });
    clock += 5_000;
    const revived = makeService();
    revived.startSweeper();
    try {
      expect(revived.get(created.share.id)?.endReason).toBe('expired');
    } finally {
      await revived.stop();
      await service.stop();
    }
  });
});

describe('凭证登录与校验', () => {
  test('登录成功签发 token，verifyAccessToken 返回 scope', async () => {
    const service = makeService();
    const created = await createShare(service);
    const login = await service.loginAccess(created.share.id, 'secret123', '203.0.113.1');
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(parseShareToken(login.token)?.shareId).toBe(created.share.id);
    expect(login.expiresAt).toBe(created.share.expiresAt ?? 0);
    expect(login.maxAgeSec).toBe(3_600);

    const verified = service.verifyAccessToken(login.token);
    expect(verified?.scope).toEqual({
      shareId: created.share.id,
      deviceId: 'dev-1',
      windowId: '@1',
    });
    expect(verified?.expiresAt).toBe(login.expiresAt);
    expect(service.verifyAccessToken(`share:${login.token}`)).not.toBeNull();
  });

  test('永久分享的凭证按 7 天签发并滑动续期', async () => {
    const service = makeService();
    const created = await createShare(service, { expiresInMs: null });
    const login = await service.loginAccess(created.share.id, 'secret123', 'ip');
    if (!login.ok) throw new Error('login failed');
    expect(login.expiresAt).toBe(clock + SHARE_ACCESS_TTL_MS);
    clock += SHARE_ACCESS_TTL_MS * 0.6;
    const verified = service.verifyAccessToken(login.token);
    expect(verified?.expiresAt).toBe(clock + SHARE_ACCESS_TTL_MS);
  });

  test('口令错误返回 SHARE_PASSWORD_INVALID；10 次后锁定 15 分钟', async () => {
    const service = makeService();
    const created = await createShare(service, { expiresInMs: null });
    for (let i = 0; i < 9; i++) {
      const failed = await service.loginAccess(created.share.id, 'nope', '203.0.113.5');
      expect(failed).toEqual({ ok: false, code: 'SHARE_PASSWORD_INVALID' });
    }
    const tenth = await service.loginAccess(created.share.id, 'nope', '203.0.113.5');
    expect(tenth.ok).toBe(false);
    if (tenth.ok) return;
    expect(tenth.code).toBe('SHARE_LOGIN_LOCKED');
    expect(tenth.retryAfterMs).toBeGreaterThan(0);

    const correctButLocked = await service.loginAccess(
      created.share.id,
      'secret123',
      '203.0.113.5'
    );
    expect(correctButLocked).toMatchObject({ ok: false, code: 'SHARE_LOGIN_LOCKED' });

    const otherIp = await service.loginAccess(created.share.id, 'secret123', '203.0.113.6');
    expect(otherIp.ok).toBe(true);

    clock += 15 * 60 * 1000 + 1;
    const afterWindow = await service.loginAccess(created.share.id, 'secret123', '203.0.113.5');
    expect(afterWindow.ok).toBe(true);
  });

  test('分享结束 / 到期后凭证失效', async () => {
    const service = makeService();
    const created = await createShare(service, { expiresInMs: 1_000 });
    const login = await service.loginAccess(created.share.id, 'secret123', 'ip');
    if (!login.ok) throw new Error('login failed');
    clock += 2_000;
    expect(service.verifyAccessToken(login.token)).toBeNull();
    expect(service.get(created.share.id)?.endReason).toBe('expired');
    expect(await service.loginAccess(created.share.id, 'secret123', 'ip')).toEqual({
      ok: false,
      code: 'SHARE_ENDED',
    });
  });

  test('终止后 verifyAccessToken 返回 null，logout 删除凭证', async () => {
    const service = makeService();
    const created = await createShare(service, { expiresInMs: null });
    const login = await service.loginAccess(created.share.id, 'secret123', 'ip');
    if (!login.ok) throw new Error('login failed');
    service.logoutAccess(login.token);
    expect(service.verifyAccessToken(login.token)).toBeNull();

    const again = await service.loginAccess(created.share.id, 'secret123', 'ip');
    if (!again.ok) throw new Error('login failed');
    service.revoke(created.share.id);
    expect(service.verifyAccessToken(again.token)).toBeNull();
  });

  test('伪造 / 畸形 token 一律拒绝', async () => {
    const service = makeService();
    const created = await createShare(service, { expiresInMs: null });
    expect(service.verifyAccessToken('')).toBeNull();
    expect(service.verifyAccessToken('garbage')).toBeNull();
    expect(service.verifyAccessToken(`${created.share.id}.${'A'.repeat(43)}`)).toBeNull();
    expect(await service.loginAccess('missing-share', 'secret123', 'ip')).toEqual({
      ok: false,
      code: 'SHARE_NOT_FOUND',
    });
  });
});

describe('设置与地址', () => {
  test('updateSettings 合并并夹紧非法值', () => {
    const service = makeService();
    expect(service.updateSettings({ logRetentionDays: -5 }).logRetentionDays).toBe(0);
    expect(service.updateSettings({ logMaxBytes: 1 }).logMaxBytes).toBe(1024);
    expect(service.updateSettings({ defaultOrigin: 'http://localhost' }).defaultOrigin).toBeNull();
    const saved = service.updateSettings({
      recordLogs: false,
      defaultOrigin: 'https://custom.example.com/',
    });
    expect(saved.recordLogs).toBe(false);
    expect(saved.defaultOrigin).toBe('https://custom.example.com');
    expect(service.getSettings()).toEqual(saved);
  });

  test('listOrigins 按优先级排序，内网地址被过滤', () => {
    const service = makeService();
    const view = service.listOrigins();
    expect(view.candidates.map((item) => item.kind)).toEqual(['site', 'hub', 'tunnel']);
    expect(view.candidates.map((item) => item.url)).toEqual([
      'https://site.example.com',
      'https://hub.example.com',
      'https://tunnel.example.com',
    ]);
    expect(view.recommended).toBe('https://site.example.com');
    expect(view.nodePrefix).toBeNull();
  });

  test('默认分享地址被置为 custom 且优先推荐，hub 同域时带节点前缀', () => {
    const service = makeService();
    service.updateSettings({ defaultOrigin: 'https://hub.example.com' });
    const view = service.listOrigins();
    expect(view.candidates[0]?.kind).toBe('custom');
    expect(view.recommended).toBe('https://hub.example.com');
    expect(view.nodePrefix).toBe('/n/node-1');
  });
});

describe('日志读取', () => {
  test('readLog 返回分页；未知分享返回 null', async () => {
    const service = makeService();
    const created = await createShare(service);
    store.appendLogEntries(
      created.share.id,
      [{ at: clock, kind: 'out', paneId: '%0', data: new TextEncoder().encode('hi') }],
      1_000_000
    );
    const page = service.readLog(created.share.id);
    expect(page?.entries).toHaveLength(1);
    expect(page?.entries[0]?.data).toBe('aGk=');
    expect(service.readLog('missing')).toBeNull();
  });
});
