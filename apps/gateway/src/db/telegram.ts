import type { TelegramBotChat, TelegramBotWithStats, TelegramChatType } from '@tmex/shared';
import { and, count, desc, eq } from 'drizzle-orm';
import { i18next } from '../i18n';
import { getDb as getOrmDb } from './client';
import { toTelegramBotConfigRecord, toTelegramChat } from './mappers';
import { telegramBotChats, telegramBots } from './schema';
import { aggregateByParent } from './stats';
import type { TelegramBotConfigRecord } from './types';

export type { TelegramBotConfigRecord };

export function createTelegramBot(configRecord: TelegramBotConfigRecord): void {
  const orm = getOrmDb();
  orm
    .insert(telegramBots)
    .values({
      id: configRecord.id,
      name: configRecord.name,
      tokenEnc: configRecord.tokenEnc,
      enabled: configRecord.enabled,
      allowAuthRequests: configRecord.allowAuthRequests,
      lastUpdateId: configRecord.lastUpdateId,
      createdAt: configRecord.createdAt,
      updatedAt: configRecord.updatedAt,
    })
    .run();
}

export function getTelegramBotById(botId: string): TelegramBotConfigRecord | null {
  const orm = getOrmDb();
  const row = orm.select().from(telegramBots).where(eq(telegramBots.id, botId)).get();
  if (!row) {
    return null;
  }
  return toTelegramBotConfigRecord(row);
}

export function getAllTelegramBots(): TelegramBotConfigRecord[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(telegramBots)
    .orderBy(desc(telegramBots.createdAt))
    .all()
    .map(toTelegramBotConfigRecord);
}

export function getTelegramBotsWithStats(): TelegramBotWithStats[] {
  const orm = getOrmDb();
  const bots = orm.select().from(telegramBots).orderBy(desc(telegramBots.createdAt)).all();

  const chatRows = orm
    .select({ botId: telegramBotChats.botId, status: telegramBotChats.status })
    .from(telegramBotChats)
    .all();

  const counters = aggregateByParent(
    chatRows,
    (row) => row.botId,
    () => ({ pending: 0, authorized: 0 }),
    (current, row) => {
      if (row.status === 'pending') {
        current.pending += 1;
      }
      if (row.status === 'authorized') {
        current.authorized += 1;
      }
    }
  );

  return bots.map((bot) => {
    const counter = counters.get(bot.id) ?? { pending: 0, authorized: 0 };
    return {
      id: bot.id,
      name: bot.name,
      enabled: bot.enabled,
      allowAuthRequests: bot.allowAuthRequests,
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
      pendingCount: counter.pending,
      authorizedCount: counter.authorized,
    };
  });
}

export function updateTelegramBot(
  botId: string,
  updates: Partial<
    Pick<
      TelegramBotConfigRecord,
      'name' | 'tokenEnc' | 'enabled' | 'allowAuthRequests' | 'lastUpdateId'
    >
  >
): TelegramBotConfigRecord | null {
  const orm = getOrmDb();
  const setValues: Partial<typeof telegramBots.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  if (updates.name !== undefined) {
    setValues.name = updates.name;
  }
  if (updates.tokenEnc !== undefined) {
    setValues.tokenEnc = updates.tokenEnc;
  }
  if (updates.enabled !== undefined) {
    setValues.enabled = updates.enabled;
  }
  if (updates.allowAuthRequests !== undefined) {
    setValues.allowAuthRequests = updates.allowAuthRequests;
  }
  if (updates.lastUpdateId !== undefined) {
    setValues.lastUpdateId = updates.lastUpdateId;
  }

  orm.update(telegramBots).set(setValues).where(eq(telegramBots.id, botId)).run();
  return getTelegramBotById(botId);
}

export function deleteTelegramBot(botId: string): void {
  const orm = getOrmDb();
  orm.delete(telegramBots).where(eq(telegramBots.id, botId)).run();
}

function getTelegramChatCount(botId: string): number {
  const orm = getOrmDb();
  const row = orm
    .select({ total: count() })
    .from(telegramBotChats)
    .where(eq(telegramBotChats.botId, botId))
    .get();

  return Number(row?.total ?? 0);
}

export function getTelegramChatByBotAndChatId(
  botId: string,
  chatId: string
): TelegramBotChat | null {
  const orm = getOrmDb();
  const row = orm
    .select()
    .from(telegramBotChats)
    .where(and(eq(telegramBotChats.botId, botId), eq(telegramBotChats.chatId, chatId)))
    .get();

  if (!row) {
    return null;
  }

  return toTelegramChat(row);
}

export function createOrUpdatePendingTelegramChat(params: {
  botId: string;
  chatId: string;
  chatType: TelegramChatType;
  displayName: string;
  appliedAt: string;
}): TelegramBotChat {
  const existing = getTelegramChatByBotAndChatId(params.botId, params.chatId);
  if (!existing && getTelegramChatCount(params.botId) >= 8) {
    throw new Error(i18next.t('apiError.invalidRequest'));
  }

  const now = new Date().toISOString();
  const orm = getOrmDb();

  if (!existing) {
    orm
      .insert(telegramBotChats)
      .values({
        id: crypto.randomUUID(),
        botId: params.botId,
        chatId: params.chatId,
        chatType: params.chatType,
        displayName: params.displayName,
        status: 'pending',
        appliedAt: params.appliedAt,
        authorizedAt: null,
        updatedAt: now,
      })
      .run();
  } else if (existing.status === 'authorized') {
    orm
      .update(telegramBotChats)
      .set({
        chatType: params.chatType,
        displayName: params.displayName,
        updatedAt: now,
      })
      .where(eq(telegramBotChats.id, existing.id))
      .run();
  } else {
    orm
      .update(telegramBotChats)
      .set({
        chatType: params.chatType,
        displayName: params.displayName,
        appliedAt: params.appliedAt,
        status: 'pending',
        updatedAt: now,
      })
      .where(eq(telegramBotChats.id, existing.id))
      .run();
  }

  const next = getTelegramChatByBotAndChatId(params.botId, params.chatId);
  if (!next) {
    throw new Error('failed to upsert telegram chat');
  }

  return next;
}

export function listTelegramChatsByBot(botId: string): TelegramBotChat[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(telegramBotChats)
    .where(eq(telegramBotChats.botId, botId))
    .orderBy(desc(telegramBotChats.appliedAt))
    .all()
    .map(toTelegramChat);
}

export function listAuthorizedTelegramChatsByBot(botId: string): TelegramBotChat[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(telegramBotChats)
    .where(and(eq(telegramBotChats.botId, botId), eq(telegramBotChats.status, 'authorized')))
    .orderBy(desc(telegramBotChats.authorizedAt))
    .all()
    .map(toTelegramChat);
}

export function approveTelegramChat(botId: string, chatId: string): TelegramBotChat | null {
  const existing = getTelegramChatByBotAndChatId(botId, chatId);
  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  const orm = getOrmDb();
  orm
    .update(telegramBotChats)
    .set({
      status: 'authorized',
      authorizedAt: now,
      updatedAt: now,
    })
    .where(eq(telegramBotChats.id, existing.id))
    .run();

  return getTelegramChatByBotAndChatId(botId, chatId);
}

export function deleteTelegramChat(botId: string, chatId: string): void {
  const orm = getOrmDb();
  orm
    .delete(telegramBotChats)
    .where(and(eq(telegramBotChats.botId, botId), eq(telegramBotChats.chatId, chatId)))
    .run();
}
