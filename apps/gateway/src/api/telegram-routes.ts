import { randomUUID } from 'node:crypto';
import { toBCP47 } from '@vibeterm/shared';
import { encrypt } from '../crypto';
import {
  approveTelegramChat,
  createTelegramBot,
  deleteTelegramBot,
  deleteTelegramChat,
  getSiteSettings,
  getTelegramBotById,
  getTelegramBotsWithStats,
  listTelegramChatsByBot,
  updateTelegramBot,
} from '../db';
import { t } from '../i18n';
import { broadcastSettingsUpdate } from '../settings/broadcaster';
import { telegramService } from '../telegram/service';
import type { ConfigFieldSpec, FieldParseResult } from './config-field';
import { json } from './http';
import {
  createMessagingChannelRoutes,
  parseMessagingFlag,
  parseRequiredTrimmed,
} from './messaging-channel-routes';
import { type ApiRoute, route } from './route';

function parseBotName(raw: unknown): FieldParseResult<string> {
  return parseRequiredTrimmed(raw, t('apiError.botNameRequired'));
}

function parseBotToken(raw: unknown): FieldParseResult<string> {
  return parseRequiredTrimmed(raw, t('apiError.botTokenRequired'));
}

type TelegramBotCreateDraft = {
  name: string;
  token: string;
  enabled: boolean;
  allowAuthRequests: boolean;
  allowCommands: boolean;
};

type TelegramBotUpdateDraft = {
  name?: string;
  token?: string;
  enabled?: boolean;
  allowAuthRequests?: boolean;
  allowCommands?: boolean;
};

const TELEGRAM_CREATE_FIELDS: ConfigFieldSpec<unknown>[] = [
  { name: 'name', parse: parseBotName, onAbsent: 'parse' },
  { name: 'token', parse: parseBotToken, onAbsent: 'parse' },
  { name: 'enabled', parse: parseMessagingFlag, onAbsent: { default: true }, nullIsAbsent: true },
  {
    name: 'allowAuthRequests',
    parse: parseMessagingFlag,
    onAbsent: { default: true },
    nullIsAbsent: true,
  },
  {
    name: 'allowCommands',
    parse: parseMessagingFlag,
    onAbsent: { default: false },
    nullIsAbsent: true,
  },
];

const TELEGRAM_UPDATE_FIELDS: ConfigFieldSpec<unknown>[] = [
  { name: 'name', parse: parseBotName },
  { name: 'token', parse: parseBotToken },
  { name: 'enabled', parse: parseMessagingFlag },
  { name: 'allowAuthRequests', parse: parseMessagingFlag },
  { name: 'allowCommands', parse: parseMessagingFlag },
];

async function persistTelegramCreate(
  draft: TelegramBotCreateDraft
): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  createTelegramBot({
    id: randomUUID(),
    name: draft.name,
    tokenEnc: await encrypt(draft.token),
    enabled: draft.enabled,
    allowAuthRequests: draft.allowAuthRequests,
    allowCommands: draft.allowCommands,
    lastUpdateId: null,
    createdAt: now,
    updatedAt: now,
  });
  broadcastSettingsUpdate('telegram');
  await telegramService.refresh();
  return {};
}

async function persistTelegramUpdate(botId: string, draft: TelegramBotUpdateDraft): Promise<void> {
  const { token, ...rest } = draft;
  updateTelegramBot(botId, {
    ...rest,
    ...(token !== undefined ? { tokenEnc: await encrypt(token) } : {}),
  });
  broadcastSettingsUpdate('telegram');
  await telegramService.refresh();
}

async function persistTelegramDelete(botId: string): Promise<void> {
  deleteTelegramBot(botId);
  broadcastSettingsUpdate('telegram');
  await telegramService.refresh();
}

async function afterApproveTelegram(
  parent: { id: string; name: string },
  chatId: string
): Promise<void> {
  broadcastSettingsUpdate('telegram');
  const settings = getSiteSettings();
  await telegramService.sendTestMessage(
    parent.id,
    chatId,
    t('telegram.approveMessageTemplate', {
      botName: parent.name,
      time: new Date().toLocaleString(toBCP47(settings.language)),
    })
  );
}

async function handleDeleteTelegramChat(botId: string, chatId: string): Promise<Response> {
  const existing = getTelegramBotById(botId);
  if (!existing) {
    return json({ error: t('apiError.botNotFound') }, 404);
  }
  deleteTelegramChat(botId, chatId);
  broadcastSettingsUpdate('telegram');
  return json({ success: true });
}

async function handleTestTelegramChat(botId: string, chatId: string): Promise<Response> {
  const bot = getTelegramBotById(botId);
  if (!bot) {
    return json({ error: t('apiError.botNotFound') }, 404);
  }
  const settings = getSiteSettings();
  await telegramService.sendTestMessage(
    botId,
    chatId,
    t('telegram.testMessageTemplate', {
      siteName: settings.siteName,
      time: new Date().toLocaleString(toBCP47(settings.language)),
    })
  );
  return json({ success: true });
}

export const telegramRoutes: ApiRoute[] = [
  ...createMessagingChannelRoutes({
    channel: 'telegram',
    parentCollection: 'bots',
    childCollection: 'chats',
    parentParam: 'botId',
    childParam: 'chatId',
    listKey: 'bots',
    childListKey: 'chats',
    childKey: 'chat',
    parentNotFound: () => t('apiError.botNotFound'),
    childNotFound: () => t('apiError.chatNotFound'),
    createFields: TELEGRAM_CREATE_FIELDS,
    updateFields: TELEGRAM_UPDATE_FIELDS,
    getById: (id) => getTelegramBotById(id),
    listWithStats: () => getTelegramBotsWithStats(),
    listChildren: (parentId) => listTelegramChatsByBot(parentId),
    approveChild: (parentId, childId) => approveTelegramChat(parentId, childId),
    persistCreate: persistTelegramCreate,
    persistUpdate: persistTelegramUpdate,
    persistDelete: persistTelegramDelete,
    afterApprove: afterApproveTelegram,
  }),
  route({
    method: 'POST',
    path: '/api/settings/telegram/bots/:botId/chats/:chatId/test',
    handler: (_req, params) =>
      handleTestTelegramChat(params.botId, decodeURIComponent(params.chatId)),
  }),
  route({
    method: 'DELETE',
    path: '/api/settings/telegram/bots/:botId/chats/:chatId',
    handler: (_req, params) =>
      handleDeleteTelegramChat(params.botId, decodeURIComponent(params.chatId)),
  }),
];
