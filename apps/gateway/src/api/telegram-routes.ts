import { toBCP47 } from '@tmex/shared';
import { v4 as uuidv4 } from 'uuid';
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
import {
  type ConfigFieldSpec,
  type FieldParseResult,
  applyConfigFields,
  parseBooleanField,
} from './config-field';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

function parseRequiredTrimmed(raw: unknown, error: string): FieldParseResult<string> {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, error };
  return { ok: true, value };
}

function parseBotName(raw: unknown): FieldParseResult<string> {
  return parseRequiredTrimmed(raw, t('apiError.botNameRequired'));
}

function parseBotToken(raw: unknown): FieldParseResult<string> {
  return parseRequiredTrimmed(raw, t('apiError.botTokenRequired'));
}

function parseFlag(raw: unknown): FieldParseResult<boolean> {
  return parseBooleanField(raw, t('apiError.invalidRequest'));
}

type TelegramBotCreateDraft = {
  name: string;
  token: string;
  enabled: boolean;
  allowAuthRequests: boolean;
};

type TelegramBotUpdateDraft = {
  name?: string;
  token?: string;
  enabled?: boolean;
  allowAuthRequests?: boolean;
};

const TELEGRAM_CREATE_FIELDS: ConfigFieldSpec<unknown>[] = [
  { name: 'name', parse: parseBotName, onAbsent: 'parse' },
  { name: 'token', parse: parseBotToken, onAbsent: 'parse' },
  { name: 'enabled', parse: parseFlag, onAbsent: { default: true }, nullIsAbsent: true },
  {
    name: 'allowAuthRequests',
    parse: parseFlag,
    onAbsent: { default: true },
    nullIsAbsent: true,
  },
];

const TELEGRAM_UPDATE_FIELDS: ConfigFieldSpec<unknown>[] = [
  { name: 'name', parse: parseBotName },
  { name: 'token', parse: parseBotToken },
  { name: 'enabled', parse: parseFlag },
  { name: 'allowAuthRequests', parse: parseFlag },
];

async function handleGetTelegramBots(): Promise<Response> {
  const bots = getTelegramBotsWithStats();
  return json({ bots });
}

async function handleCreateTelegramBot(req: Request): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const parsed = applyConfigFields<TelegramBotCreateDraft>(raw, TELEGRAM_CREATE_FIELDS, undefined);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }

  const now = new Date().toISOString();
  createTelegramBot({
    id: uuidv4(),
    name: parsed.fields.name,
    tokenEnc: await encrypt(parsed.fields.token),
    enabled: parsed.fields.enabled,
    allowAuthRequests: parsed.fields.allowAuthRequests,
    lastUpdateId: null,
    createdAt: now,
    updatedAt: now,
  });

  broadcastSettingsUpdate('telegram');
  await telegramService.refresh();

  return json({ success: true }, 201);
}

async function handleUpdateTelegramBot(req: Request, botId: string): Promise<Response> {
  const existing = getTelegramBotById(botId);
  if (!existing) {
    return json({ error: t('apiError.botNotFound') }, 404);
  }

  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const parsed = applyConfigFields<TelegramBotUpdateDraft>(raw, TELEGRAM_UPDATE_FIELDS, undefined);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }

  const updates: Partial<{
    name: string;
    tokenEnc: string;
    enabled: boolean;
    allowAuthRequests: boolean;
  }> = {};
  if (parsed.fields.name !== undefined) updates.name = parsed.fields.name;
  if (parsed.fields.token !== undefined) updates.tokenEnc = await encrypt(parsed.fields.token);
  if (parsed.fields.enabled !== undefined) updates.enabled = parsed.fields.enabled;
  if (parsed.fields.allowAuthRequests !== undefined) {
    updates.allowAuthRequests = parsed.fields.allowAuthRequests;
  }

  updateTelegramBot(botId, updates);
  broadcastSettingsUpdate('telegram');
  await telegramService.refresh();

  return json({ success: true });
}

async function handleDeleteTelegramBot(botId: string): Promise<Response> {
  const existing = getTelegramBotById(botId);
  if (!existing) {
    return json({ error: t('apiError.botNotFound') }, 404);
  }

  deleteTelegramBot(botId);
  broadcastSettingsUpdate('telegram');
  await telegramService.refresh();

  return json({ success: true });
}

async function handleListTelegramChats(botId: string): Promise<Response> {
  const existing = getTelegramBotById(botId);
  if (!existing) {
    return json({ error: t('apiError.botNotFound') }, 404);
  }

  const chats = listTelegramChatsByBot(botId);
  return json({ chats });
}

async function handleApproveTelegramChat(botId: string, chatId: string): Promise<Response> {
  const existing = getTelegramBotById(botId);
  if (!existing) {
    return json({ error: t('apiError.botNotFound') }, 404);
  }

  const chat = approveTelegramChat(botId, chatId);
  if (!chat) {
    return json({ error: t('apiError.chatNotFound') }, 404);
  }
  broadcastSettingsUpdate('telegram');

  const settings = getSiteSettings();
  await telegramService.sendTestMessage(
    botId,
    chatId,
    t('telegram.approveMessageTemplate', {
      botName: existing.name,
      time: new Date().toLocaleString(toBCP47(settings.language)),
    })
  );

  return json({ chat });
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
  route({
    method: 'GET',
    path: '/api/settings/telegram/bots',
    handler: () => handleGetTelegramBots(),
  }),
  route({
    method: 'POST',
    path: '/api/settings/telegram/bots',
    handler: (req) => handleCreateTelegramBot(req),
  }),
  route({
    method: 'PATCH',
    path: '/api/settings/telegram/bots/:botId',
    handler: (req, params) => handleUpdateTelegramBot(req, params.botId),
  }),
  route({
    method: 'DELETE',
    path: '/api/settings/telegram/bots/:botId',
    handler: (_req, params) => handleDeleteTelegramBot(params.botId),
  }),
  route({
    method: 'GET',
    path: '/api/settings/telegram/bots/:botId/chats',
    handler: (_req, params) => handleListTelegramChats(params.botId),
  }),
  route({
    method: 'POST',
    path: '/api/settings/telegram/bots/:botId/chats/:chatId/approve',
    handler: (_req, params) =>
      handleApproveTelegramChat(params.botId, decodeURIComponent(params.chatId)),
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
