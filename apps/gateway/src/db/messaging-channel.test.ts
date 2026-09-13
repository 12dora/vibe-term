import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from './client';
import { toTelegramBotConfigRecord, toTelegramChat } from './mappers';
import {
  createMessagingChannelStore,
  emptyStatusCounters,
  foldStatusCounters,
} from './messaging-channel';
import { telegramBotChats, telegramBots } from './schema';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

const store = createMessagingChannelStore({
  tables: {
    parent: telegramBots,
    child: telegramBotChats,
    parentId: telegramBots.id,
    parentCreatedAt: telegramBots.createdAt,
    childId: telegramBotChats.id,
    childParentId: telegramBotChats.botId,
    childExternalId: telegramBotChats.chatId,
    childStatus: telegramBotChats.status,
    childAppliedAt: telegramBotChats.appliedAt,
    childAuthorizedAt: telegramBotChats.authorizedAt,
  },
  toParent: toTelegramBotConfigRecord,
  toChild: toTelegramChat,
  emptyCounters: emptyStatusCounters,
  foldChild: (acc, row) => foldStatusCounters(acc, row.status),
  toStats: (bot, counter) => ({
    id: bot.id,
    name: bot.name,
    pendingCount: counter.pending,
    authorizedCount: counter.authorized,
  }),
  updateKeys: ['name', 'enabled', 'lastUpdateId'],
});

function seedBot(id: string): void {
  const now = new Date().toISOString();
  store.create({
    id,
    name: 'generic',
    tokenEnc: 'enc',
    enabled: true,
    allowAuthRequests: true,
    allowCommands: false,
    lastUpdateId: null,
    createdAt: now,
    updatedAt: now,
  });
}

function seedChat(botId: string, chatId: string, status: 'pending' | 'authorized'): void {
  const now = new Date().toISOString();
  getOrmDb()
    .insert(telegramBotChats)
    .values({
      id: crypto.randomUUID(),
      botId,
      chatId,
      chatType: 'private',
      displayName: chatId,
      userId: null,
      status,
      appliedAt: now,
      authorizedAt: status === 'authorized' ? now : null,
      updatedAt: now,
    })
    .run();
}

describe('createMessagingChannelStore', () => {
  test('parent CRUD, child stats, approve, and defined-key patch', () => {
    const botId = crypto.randomUUID();
    seedBot(botId);
    expect(store.getById(botId)?.name).toBe('generic');

    seedChat(botId, 'c-pending', 'pending');
    seedChat(botId, 'c-auth', 'authorized');
    expect(store.countChildren(botId)).toBe(2);

    const stats = store.listWithStats().find((row) => row.id === botId);
    expect(stats).toMatchObject({ pendingCount: 1, authorizedCount: 1 });

    const approved = store.approveChild(botId, 'c-pending');
    expect(approved?.status).toBe('authorized');
    expect(store.listAuthorized(botId)).toHaveLength(2);

    const named = store.update(botId, { name: 'renamed', enabled: undefined, lastUpdateId: 7 });
    expect(named?.name).toBe('renamed');
    expect(named?.enabled).toBe(true);
    expect(named?.lastUpdateId).toBe(7);

    const cleared = store.update(botId, { lastUpdateId: null });
    expect(cleared?.lastUpdateId).toBeNull();
    expect(cleared?.name).toBe('renamed');

    store.deleteChild(botId, 'c-auth');
    expect(store.getChild(botId, 'c-auth')).toBeNull();
    expect(store.countChildren(botId)).toBe(1);

    store.remove(botId);
    expect(store.getById(botId)).toBeNull();
    expect(store.getChild(botId, 'c-pending')).toBeNull();
  });
});
