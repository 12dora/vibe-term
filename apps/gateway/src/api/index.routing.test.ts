import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Server } from 'bun';
import { ensureSiteSettingsInitialized } from '../db';
import * as devicesDb from '../db/devices';
import { runMigrations } from '../db/migrate';
import * as telegramDb from '../db/telegram';
import * as weixinDb from '../db/weixin';
import { telegramService } from '../telegram/service';
import { weixinService } from '../weixin/service';
import { handleApiRequest } from './index';

const fakeServer = {} as Server<unknown>;
const spies: Array<{ mockRestore: () => void }> = [];

function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

beforeAll(() => {
  runMigrations();
  ensureSiteSettingsInitialized();
});

afterEach(() => {
  while (spies.length > 0) {
    spies.pop()?.mockRestore();
  }
});

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('handleApiRequest production route table', () => {
  test('PUT /api/devices/order hits reorderDevices and not the :id handler', async () => {
    const reorder = track(spyOn(devicesDb, 'reorderDevices').mockImplementation(() => {}));
    const getById = track(spyOn(devicesDb, 'getDeviceById'));
    track(spyOn(devicesDb, 'getAllDevices').mockReturnValue([]));
    track(
      spyOn(devicesDb, 'getDeviceRuntimeStatus').mockReturnValue({
        deviceId: 'unused',
        lastSeenAt: null,
        lastError: null,
        lastErrorType: null,
        tmuxAvailable: false,
      })
    );

    const res = await handleApiRequest(
      req('PUT', '/api/devices/order', { deviceIds: ['b', 'a'] }),
      fakeServer
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ devices: [] });
    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder.mock.calls[0]?.[0]).toEqual(['b', 'a']);
    expect(getById).not.toHaveBeenCalled();
  });

  test('GET /api/devices/order hits the :id handler with id "order"', async () => {
    const reorder = track(spyOn(devicesDb, 'reorderDevices').mockImplementation(() => {}));
    const getById = track(spyOn(devicesDb, 'getDeviceById').mockReturnValue(null));

    const res = await handleApiRequest(req('GET', '/api/devices/order'), fakeServer);

    expect(res.status).toBe(404);
    expect(getById).toHaveBeenCalledWith('order');
    expect(reorder).not.toHaveBeenCalled();
  });

  test('percent-encoded device ids stay raw on GET /api/devices/:id', async () => {
    const getById = track(spyOn(devicesDb, 'getDeviceById').mockReturnValue(null));

    const res = await handleApiRequest(req('GET', '/api/devices/abc%2Fdef'), fakeServer);

    expect(res.status).toBe(404);
    expect(getById).toHaveBeenCalledWith('abc%2Fdef');
  });

  test('percent-encoded telegram chatId is decoded before the chat handler', async () => {
    const now = new Date().toISOString();
    track(
      spyOn(telegramDb, 'getTelegramBotById').mockReturnValue({
        id: 'bot1',
        name: 'bot',
        tokenEnc: 'enc',
        enabled: true,
        allowAuthRequests: true,
        lastUpdateId: null,
        createdAt: now,
        updatedAt: now,
      })
    );
    const approve = track(
      spyOn(telegramDb, 'approveTelegramChat').mockImplementation((_botId, chatId) => ({
        id: 'chat-row',
        botId: 'bot1',
        chatId,
        chatType: 'private',
        displayName: 'n',
        status: 'authorized',
        appliedAt: now,
        authorizedAt: now,
        updatedAt: now,
      }))
    );
    track(spyOn(telegramService, 'sendTestMessage').mockResolvedValue(undefined));

    const res = await handleApiRequest(
      req('POST', '/api/settings/telegram/bots/bot1/chats/chat%3A2/approve'),
      fakeServer
    );

    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledWith('bot1', 'chat:2');
  });

  test('percent-encoded weixin userId is decoded before the user handler', async () => {
    const now = new Date().toISOString();
    track(
      spyOn(weixinDb, 'getWeixinAccountById').mockReturnValue({
        id: 'acc1',
        name: 'wx',
        enabled: true,
        allowAuthRequests: true,
        loggedIn: false,
        weixinUin: null,
        botTokenEnc: null,
        baseUrl: null,
        syncBuf: null,
        createdAt: now,
        updatedAt: now,
      })
    );
    const approve = track(
      spyOn(weixinDb, 'approveWeixinUser').mockImplementation((_accountId, userId) => ({
        id: 'user-row',
        accountId: 'acc1',
        userId,
        displayName: 'n',
        status: 'authorized',
        needsReactivation: false,
        lastInboundAt: now,
        appliedAt: now,
        authorizedAt: now,
        updatedAt: now,
      }))
    );
    track(spyOn(weixinService, 'sendTestMessage').mockResolvedValue(undefined));

    const res = await handleApiRequest(
      req('POST', '/api/settings/weixin/accounts/acc1/users/user%3A2/approve'),
      fakeServer
    );

    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledWith('acc1', 'user:2');
  });
});
