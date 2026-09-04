import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import {
  approveTelegramChat,
  createOrUpdatePendingTelegramChat,
  createTelegramBot,
  updateTelegramBot,
} from '../db';
import { getDb as getOrmDb } from '../db/client';
import { TelegramService } from './service';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

describe('TelegramService.handleIncomingText', () => {
  test('/start records from.id and keeps binding replies', async () => {
    const botId = crypto.randomUUID();
    const now = new Date().toISOString();
    createTelegramBot({
      id: botId,
      name: 'svc',
      tokenEnc: 'enc',
      enabled: true,
      allowAuthRequests: true,
      allowCommands: false,
      lastUpdateId: null,
      createdAt: now,
      updatedAt: now,
    });
    const service = new TelegramService();
    const replies: string[] = [];
    await service.handleIncomingText({
      botId,
      text: '/start',
      chatId: '-100',
      chatType: 'group',
      fromId: '42',
      title: 'ops',
      reply: async (text) => {
        replies.push(text);
      },
    });
    expect(replies.length).toBe(1);
    const chat = createOrUpdatePendingTelegramChat({
      botId,
      chatId: '-100',
      chatType: 'group',
      displayName: 'ops',
      appliedAt: now,
    });
    expect(chat.userId).toBe('42');
    expect(chat.status).toBe('pending');
  });

  test('commands stay silent until authorized with allowCommands and matching from.id', async () => {
    const botId = crypto.randomUUID();
    const now = new Date().toISOString();
    createTelegramBot({
      id: botId,
      name: 'svc2',
      tokenEnc: 'enc',
      enabled: true,
      allowAuthRequests: true,
      allowCommands: true,
      lastUpdateId: null,
      createdAt: now,
      updatedAt: now,
    });
    createOrUpdatePendingTelegramChat({
      botId,
      chatId: '-200',
      chatType: 'group',
      displayName: 'ops',
      appliedAt: now,
      userId: '7',
    });
    const service = new TelegramService();
    const replies: string[] = [];
    const reply = async (text: string) => {
      replies.push(text);
    };
    await service.handleIncomingText({
      botId,
      text: 'help',
      chatId: '-200',
      chatType: 'group',
      fromId: '7',
      reply,
    });
    expect(replies).toEqual([]);
    approveTelegramChat(botId, '-200');
    await service.handleIncomingText({
      botId,
      text: 'help',
      chatId: '-200',
      chatType: 'group',
      fromId: '99',
      reply,
    });
    expect(replies).toEqual([]);
    await service.handleIncomingText({
      botId,
      text: 'help',
      chatId: '-200',
      chatType: 'group',
      fromId: '7',
      reply,
    });
    expect(replies.length).toBeGreaterThan(0);
  });

  test('allowCommands false stays silent even when authorized', async () => {
    const botId = crypto.randomUUID();
    const now = new Date().toISOString();
    createTelegramBot({
      id: botId,
      name: 'svc3',
      tokenEnc: 'enc',
      enabled: true,
      allowAuthRequests: true,
      allowCommands: false,
      lastUpdateId: null,
      createdAt: now,
      updatedAt: now,
    });
    createOrUpdatePendingTelegramChat({
      botId,
      chatId: '300',
      chatType: 'private',
      displayName: 'me',
      appliedAt: now,
      userId: '1',
    });
    approveTelegramChat(botId, '300');
    const replies: string[] = [];
    await new TelegramService().handleIncomingText({
      botId,
      text: 'help',
      chatId: '300',
      chatType: 'private',
      fromId: '1',
      reply: async (text) => {
        replies.push(text);
      },
    });
    expect(replies).toEqual([]);
    updateTelegramBot(botId, { allowCommands: true });
    await new TelegramService().handleIncomingText({
      botId,
      text: 'not-a-command',
      chatId: '300',
      chatType: 'private',
      fromId: '1',
      reply: async (text) => {
        replies.push(text);
      },
    });
    expect(replies.length).toBeGreaterThan(0);
  });
});
