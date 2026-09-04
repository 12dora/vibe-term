import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from './client';
import {
  approveTelegramChat,
  createOrUpdatePendingTelegramChat,
  createTelegramBot,
  getTelegramChatByBotAndChatId,
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
  test('pendingTelegramUserIdForUpsert freezes authorized rows', () => {
    expect(pendingTelegramUserIdForUpsert(null, '1')).toBe('1');
    expect(pendingTelegramUserIdForUpsert({ status: 'pending' } as never, '2')).toBe('2');
    expect(pendingTelegramUserIdForUpsert({ status: 'authorized' } as never, '3')).toBeUndefined();
  });

  test('pending rows may update user_id; authorized rows may not', () => {
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
    expect(rebound.userId).toBe('11');

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
    expect(frozen?.userId).toBe('11');
    expect(frozen?.displayName).toBe('g2');
  });
});
