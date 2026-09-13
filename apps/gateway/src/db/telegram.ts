import type { TelegramBotChat, TelegramBotWithStats, TelegramChatType } from '@vibeterm/shared';
import { eq } from 'drizzle-orm';
import { i18next } from '../i18n';
import { getDb as getOrmDb } from './client';
import { toTelegramBotConfigRecord, toTelegramChat } from './mappers';
import {
  createMessagingChannelStore,
  emptyStatusCounters,
  foldStatusCounters,
} from './messaging-channel';
import { telegramBotChats, telegramBots } from './schema';
import type { TelegramBotConfigRecord } from './types';

export type { TelegramBotConfigRecord };

const TELEGRAM_UPDATE_KEYS = [
  'name',
  'tokenEnc',
  'enabled',
  'allowAuthRequests',
  'allowCommands',
  'lastUpdateId',
] as const;

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
  toStats: (bot, counter): TelegramBotWithStats => ({
    id: bot.id,
    name: bot.name,
    enabled: bot.enabled,
    allowAuthRequests: bot.allowAuthRequests,
    allowCommands: bot.allowCommands,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    pendingCount: counter.pending,
    authorizedCount: counter.authorized,
  }),
  updateKeys: TELEGRAM_UPDATE_KEYS,
});

export function createTelegramBot(configRecord: TelegramBotConfigRecord): void {
  store.create(configRecord);
}

export function getTelegramBotById(botId: string): TelegramBotConfigRecord | null {
  return store.getById(botId);
}

export function getAllTelegramBots(): TelegramBotConfigRecord[] {
  return store.list();
}

export function getTelegramBotsWithStats(): TelegramBotWithStats[] {
  return store.listWithStats();
}

export function updateTelegramBot(
  botId: string,
  updates: Partial<
    Pick<
      TelegramBotConfigRecord,
      'name' | 'tokenEnc' | 'enabled' | 'allowAuthRequests' | 'allowCommands' | 'lastUpdateId'
    >
  >
): TelegramBotConfigRecord | null {
  return store.update(botId, updates);
}

export function deleteTelegramBot(botId: string): void {
  store.remove(botId);
}

export function getTelegramChatByBotAndChatId(
  botId: string,
  chatId: string
): TelegramBotChat | null {
  return store.getChild(botId, chatId);
}

/**
 * 已授权行禁止改 user_id（防群成员 /start 接管）。仅 pending 可写入本次 from.id。
 * 历史 authorized + user_id IS NULL 的群须删除后再绑定，不能靠 /start 认领。
 */
export function pendingTelegramUserIdForUpsert(
  existing: TelegramBotChat | null,
  incoming: string | null | undefined
): string | null | undefined {
  if (existing?.status === 'authorized') return undefined;
  return incoming;
}

export function createOrUpdatePendingTelegramChat(params: {
  botId: string;
  chatId: string;
  chatType: TelegramChatType;
  displayName: string;
  appliedAt: string;
  userId?: string | null;
}): TelegramBotChat {
  const existing = store.getChild(params.botId, params.chatId);
  if (!existing && store.countChildren(params.botId) >= 8) {
    throw new Error(i18next.t('apiError.invalidRequest'));
  }

  const now = new Date().toISOString();
  const orm = getOrmDb();
  const userId = pendingTelegramUserIdForUpsert(existing, params.userId);

  if (!existing) {
    orm
      .insert(telegramBotChats)
      .values({
        id: crypto.randomUUID(),
        botId: params.botId,
        chatId: params.chatId,
        chatType: params.chatType,
        displayName: params.displayName,
        userId: userId ?? null,
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
        ...(userId !== undefined ? { userId } : {}),
        appliedAt: params.appliedAt,
        status: 'pending',
        updatedAt: now,
      })
      .where(eq(telegramBotChats.id, existing.id))
      .run();
  }

  const next = store.getChild(params.botId, params.chatId);
  if (!next) {
    throw new Error('failed to upsert telegram chat');
  }
  return next;
}

export function listTelegramChatsByBot(botId: string): TelegramBotChat[] {
  return store.listChildren(botId);
}

export function listAuthorizedTelegramChatsByBot(botId: string): TelegramBotChat[] {
  return store.listAuthorized(botId);
}

export function approveTelegramChat(botId: string, chatId: string): TelegramBotChat | null {
  return store.approveChild(botId, chatId);
}

export function deleteTelegramChat(botId: string, chatId: string): void {
  store.deleteChild(botId, chatId);
}
