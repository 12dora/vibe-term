import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import {
  approveTelegramChat,
  createOrUpdatePendingTelegramChat,
  createTelegramBot,
  deleteTelegramBot,
  updateTelegramBot,
} from '../db';
import { getDb as getOrmDb } from '../db/client';
import {
  approveWeixinUser,
  createWeixinAccount,
  deleteWeixinAccount,
  upsertWeixinUserOnInbound,
} from '../db/weixin';
import { authorizeMessagingActor } from './authorize';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

const now = () => new Date().toISOString();

describe('authorizeMessagingActor', () => {
  test('telegram matrix: pending / flag / group user mismatch / ok', () => {
    const botId = crypto.randomUUID();
    createTelegramBot({
      id: botId,
      name: 'b',
      tokenEnc: 'enc',
      enabled: true,
      allowAuthRequests: true,
      allowCommands: false,
      lastUpdateId: null,
      createdAt: now(),
      updatedAt: now(),
    });
    createOrUpdatePendingTelegramChat({
      botId,
      chatId: '100',
      chatType: 'group',
      displayName: 'g',
      appliedAt: now(),
      userId: '42',
    });
    const pending = authorizeMessagingActor({
      platform: 'telegram',
      accountId: botId,
      conversationId: '100',
      userId: '42',
    });
    expect(pending).toEqual({ ok: false, silent: true });

    approveTelegramChat(botId, '100');
    expect(
      authorizeMessagingActor({
        platform: 'telegram',
        accountId: botId,
        conversationId: '100',
        userId: '42',
      })
    ).toEqual({ ok: false, silent: true });

    updateTelegramBot(botId, { allowCommands: true });
    expect(
      authorizeMessagingActor({
        platform: 'telegram',
        accountId: botId,
        conversationId: '100',
        userId: '99',
      })
    ).toEqual({ ok: false, silent: true });
    expect(
      authorizeMessagingActor({
        platform: 'telegram',
        accountId: botId,
        conversationId: '100',
        userId: '42',
      })
    ).toEqual({ ok: true });

    deleteTelegramBot(botId);
  });

  test('weixin requires authorized user and allowCommands', () => {
    const accountId = crypto.randomUUID();
    createWeixinAccount({
      id: accountId,
      name: 'wx',
      enabled: true,
      allowAuthRequests: true,
      allowCommands: true,
      loggedIn: false,
      weixinUin: null,
      botTokenEnc: null,
      baseUrl: null,
      syncBuf: null,
      createdAt: now(),
      updatedAt: now(),
    });
    upsertWeixinUserOnInbound({
      accountId,
      userId: 'u1',
      displayName: 'u1',
      contextToken: 'ctx',
      allowAuthRequests: true,
      at: now(),
    });
    expect(
      authorizeMessagingActor({
        platform: 'weixin',
        accountId,
        conversationId: 'u1',
        userId: 'u1',
      })
    ).toEqual({ ok: false, silent: true });
    approveWeixinUser(accountId, 'u1');
    expect(
      authorizeMessagingActor({
        platform: 'weixin',
        accountId,
        conversationId: 'u1',
        userId: 'u1',
      })
    ).toEqual({ ok: true });
    deleteWeixinAccount(accountId);
  });
});
