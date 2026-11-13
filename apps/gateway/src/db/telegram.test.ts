import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from './client';
import {
  approveTelegramChat,
  createOrUpdatePendingTelegramChat,
  createTelegramBot,
  getTelegramChatByBotAndChatId,
  listTelegramChatsByBot,
  pendingTelegramUserIdForUpsert,
} from './telegram';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

function seedBot(id: string): void {
  const now = new Date().toISOString();
  createTelegramBot({
    id,
    name: 'db',
    tokenEnc: 'enc',
    enabled: true,
    allowAuthRequests: true,
    allowCommands: false,
    lastUpdateId: null,
    createdAt: now,
    updatedAt: now,
  });
}

describe('createOrUpdatePendingTelegramChat user_id', () => {
  test('pendingTelegramUserIdForUpsert freezes authorized rows and first pending sender', () => {
    expect(pendingTelegramUserIdForUpsert(null, '1')).toBe('1');
    expect(pendingTelegramUserIdForUpsert({ status: 'pending' } as never, '2')).toBe('2');
    expect(
      pendingTelegramUserIdForUpsert({ status: 'pending', userId: '1' } as never, '2')
    ).toBeUndefined();
    expect(pendingTelegramUserIdForUpsert({ status: 'authorized' } as never, '3')).toBeUndefined();
  });

  test('pending rows keep the first user_id; authorized rows may not change it', () => {
    const botId = crypto.randomUUID();
    seedBot(botId);
    const now = new Date().toISOString();
    const pending = createOrUpdatePendingTelegramChat({
      botId,
      chatId: '-1',
      chatType: 'group',
      displayName: 'g',
      appliedAt: now,
      userId: '10',
    });
    expect(pending.userId).toBe('10');
    const rebound = createOrUpdatePendingTelegramChat({
      botId,
      chatId: '-1',
      chatType: 'group',
      displayName: 'g',
      appliedAt: now,
      userId: '11',
    });
    expect(rebound.status).toBe('pending');
    expect(rebound.userId).toBe('10');

    approveTelegramChat(botId, '-1');
    createOrUpdatePendingTelegramChat({
      botId,
      chatId: '-1',
      chatType: 'group',
      displayName: 'g2',
      appliedAt: now,
      userId: '99',
    });
    const frozen = getTelegramChatByBotAndChatId(botId, '-1');
    expect(frozen?.status).toBe('authorized');
    expect(frozen?.userId).toBe('10');
    expect(frozen?.displayName).toBe('g2');
  });

  test('listTelegramChatsByBot 暴露 boundUserId / boundUserName', () => {
    const botId = crypto.randomUUID();
    seedBot(botId);
    const now = new Date().toISOString();
    createOrUpdatePendingTelegramChat({
      botId,
      chatId: '-100',
      chatType: 'group',
      displayName: 'ops',
      appliedAt: now,
      userId: '42',
    });
    createOrUpdatePendingTelegramChat({
      botId,
      chatId: '7',
      chatType: 'private',
      displayName: 'Alice',
      appliedAt: now,
      userId: '7',
    });
    const rows = listTelegramChatsByBot(botId);
    const group = rows.find((row) => row.chatId === '-100');
    const dm = rows.find((row) => row.chatId === '7');
    expect(group?.boundUserId).toBe('42');
    expect(group?.boundUserName).toBeNull();
    expect(dm?.boundUserId).toBe('7');
    expect(dm?.boundUserName).toBe('Alice');
  });
});
