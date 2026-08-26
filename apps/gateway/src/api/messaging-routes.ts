import type {
  CreateTelegramBotRequest,
  CreateWeixinAccountRequest,
  UpdateTelegramBotRequest,
  UpdateWeixinAccountRequest,
  WebhookEndpoint,
} from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import { v4 as uuidv4 } from 'uuid';
import { encrypt } from '../crypto';
import {
  approveTelegramChat,
  approveWeixinUser,
  createTelegramBot,
  createWebhookEndpoint,
  createWeixinAccount,
  deleteTelegramBot,
  deleteTelegramChat,
  deleteWebhookEndpoint,
  deleteWeixinAccount,
  deleteWeixinUser,
  getAllWebhookEndpoints,
  getSiteSettings,
  getTelegramBotById,
  getTelegramBotsWithStats,
  getWeixinAccountById,
  getWeixinAccountsWithStats,
  listTelegramChatsByBot,
  listWeixinUsersByAccount,
  updateTelegramBot,
  updateWeixinAccount,
} from '../db';
import { t } from '../i18n';
import { broadcastSettingsUpdate } from '../settings/broadcaster';
import { telegramService } from '../telegram/service';
import { weixinService } from '../weixin/service';
import { json } from './http';
import { type ApiRoute, route } from './route';

async function handleGetTelegramBots(): Promise<Response> {
  const bots = getTelegramBotsWithStats();
  return json({ bots });
}

async function handleCreateTelegramBot(req: Request): Promise<Response> {
  const body = (await req.json()) as CreateTelegramBotRequest;

  if (!body.name?.trim()) {
    return json({ error: t('apiError.botNameRequired') }, 400);
  }
  if (!body.token?.trim()) {
    return json({ error: t('apiError.botTokenRequired') }, 400);
  }

  const now = new Date().toISOString();
  createTelegramBot({
    id: uuidv4(),
    name: body.name.trim(),
    tokenEnc: await encrypt(body.token.trim()),
    enabled: body.enabled ?? true,
    allowAuthRequests: body.allowAuthRequests ?? true,
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

  const body = (await req.json()) as UpdateTelegramBotRequest;
  const updates: Partial<{
    name: string;
    tokenEnc: string;
    enabled: boolean;
    allowAuthRequests: boolean;
  }> = {};

  if (body.name !== undefined) {
    const value = body.name.trim();
    if (!value) {
      return json({ error: t('apiError.botNameRequired') }, 400);
    }
    updates.name = value;
  }

  if (body.token !== undefined) {
    const token = body.token.trim();
    if (!token) {
      return json({ error: t('apiError.botTokenRequired') }, 400);
    }
    updates.tokenEnc = await encrypt(token);
  }

  if (body.enabled !== undefined) {
    updates.enabled = body.enabled;
  }

  if (body.allowAuthRequests !== undefined) {
    updates.allowAuthRequests = body.allowAuthRequests;
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

async function handleGetWeixinAccounts(): Promise<Response> {
  const accounts = getWeixinAccountsWithStats();
  return json({ accounts });
}

async function handleCreateWeixinAccount(req: Request): Promise<Response> {
  const body = (await req.json()) as CreateWeixinAccountRequest;

  if (!body.name?.trim()) {
    return json({ error: t('weixin.accountNameRequired') }, 400);
  }

  const now = new Date().toISOString();
  const id = uuidv4();
  createWeixinAccount({
    id,
    name: body.name.trim(),
    enabled: body.enabled ?? true,
    allowAuthRequests: body.allowAuthRequests ?? true,
    loggedIn: false,
    weixinUin: null,
    botTokenEnc: null,
    baseUrl: null,
    syncBuf: null,
    createdAt: now,
    updatedAt: now,
  });

  broadcastSettingsUpdate('weixin');
  return json({ success: true, accountId: id }, 201);
}

async function handleUpdateWeixinAccount(req: Request, accountId: string): Promise<Response> {
  const existing = getWeixinAccountById(accountId);
  if (!existing) {
    return json({ error: t('weixin.accountNotFound') }, 404);
  }

  const body = (await req.json()) as UpdateWeixinAccountRequest;
  const updates: Partial<{ name: string; enabled: boolean; allowAuthRequests: boolean }> = {};

  if (body.name !== undefined) {
    const value = body.name.trim();
    if (!value) {
      return json({ error: t('weixin.accountNameRequired') }, 400);
    }
    updates.name = value;
  }
  if (body.enabled !== undefined) {
    updates.enabled = body.enabled;
  }
  if (body.allowAuthRequests !== undefined) {
    updates.allowAuthRequests = body.allowAuthRequests;
  }

  updateWeixinAccount(accountId, updates);
  broadcastSettingsUpdate('weixin');
  await weixinService.refresh();

  return json({ success: true });
}

async function handleDeleteWeixinAccount(accountId: string): Promise<Response> {
  const existing = getWeixinAccountById(accountId);
  if (!existing) {
    return json({ error: t('weixin.accountNotFound') }, 404);
  }

  deleteWeixinAccount(accountId);
  broadcastSettingsUpdate('weixin');
  await weixinService.refresh();

  return json({ success: true });
}

async function handleStartWeixinLogin(accountId: string): Promise<Response> {
  const existing = getWeixinAccountById(accountId);
  if (!existing) {
    return json({ error: t('weixin.accountNotFound') }, 404);
  }

  try {
    const result = await weixinService.startLogin(accountId);
    return json(result);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : t('weixin.loginFailed') }, 502);
  }
}

async function handleGetWeixinLoginStatus(accountId: string): Promise<Response> {
  const existing = getWeixinAccountById(accountId);
  if (!existing) {
    return json({ error: t('weixin.accountNotFound') }, 404);
  }
  return json(weixinService.getLoginStatus(accountId));
}

async function handleListWeixinUsers(accountId: string): Promise<Response> {
  const existing = getWeixinAccountById(accountId);
  if (!existing) {
    return json({ error: t('weixin.accountNotFound') }, 404);
  }
  const users = listWeixinUsersByAccount(accountId);
  return json({ users });
}

async function handleApproveWeixinUser(accountId: string, userId: string): Promise<Response> {
  const existing = getWeixinAccountById(accountId);
  if (!existing) {
    return json({ error: t('weixin.accountNotFound') }, 404);
  }

  const user = approveWeixinUser(accountId, userId);
  if (!user) {
    return json({ error: t('weixin.userNotFound') }, 404);
  }
  broadcastSettingsUpdate('weixin');

  // 最佳努力发一条批准回执（会话可能已过期，失败不影响批准结果）。
  const settings = getSiteSettings();
  try {
    await weixinService.sendTestMessage(
      accountId,
      userId,
      t('weixin.approveMessageTemplate', {
        accountName: existing.name,
        time: new Date().toLocaleString(toBCP47(settings.language)),
      })
    );
  } catch (err) {
    console.error('[weixin] approve ack failed:', err);
  }

  return json({ user });
}

async function handleTestWeixinUser(accountId: string, userId: string): Promise<Response> {
  const existing = getWeixinAccountById(accountId);
  if (!existing) {
    return json({ error: t('weixin.accountNotFound') }, 404);
  }

  const settings = getSiteSettings();
  try {
    await weixinService.sendTestMessage(
      accountId,
      userId,
      t('weixin.testMessageTemplate', {
        siteName: settings.siteName,
        time: new Date().toLocaleString(toBCP47(settings.language)),
      })
    );
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : t('weixin.testMessageFailed') }, 400);
  }

  return json({ success: true });
}

async function handleTestWeixinAccount(accountId: string): Promise<Response> {
  const existing = getWeixinAccountById(accountId);
  if (!existing) {
    return json({ error: t('weixin.accountNotFound') }, 404);
  }

  const settings = getSiteSettings();
  try {
    await weixinService.sendTestMessageToBoundUser(
      accountId,
      t('weixin.testMessageTemplate', {
        siteName: settings.siteName,
        time: new Date().toLocaleString(toBCP47(settings.language)),
      })
    );
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : t('weixin.testMessageFailed') }, 400);
  }

  return json({ success: true });
}

async function handleDeleteWeixinUser(accountId: string, userId: string): Promise<Response> {
  const existing = getWeixinAccountById(accountId);
  if (!existing) {
    return json({ error: t('weixin.accountNotFound') }, 404);
  }
  deleteWeixinUser(accountId, userId);
  broadcastSettingsUpdate('weixin');
  return json({ success: true });
}

async function handleGetWebhooks(): Promise<Response> {
  const webhooks = getAllWebhookEndpoints();
  return json({ webhooks });
}

async function handleCreateWebhook(req: Request): Promise<Response> {
  const body = await req.json();

  if (!body.url || !body.secret) {
    return json({ error: t('apiError.urlAndSecretRequired') }, 400);
  }

  const now = new Date().toISOString();
  const endpoint: WebhookEndpoint = {
    id: uuidv4(),
    enabled: body.enabled ?? true,
    url: body.url,
    secret: body.secret,
    eventMask: body.eventMask ?? [],
    createdAt: now,
    updatedAt: now,
  };

  createWebhookEndpoint(endpoint);
  broadcastSettingsUpdate('webhooks');

  return json({ webhook: endpoint }, 201);
}

async function handleDeleteWebhook(id: string): Promise<Response> {
  deleteWebhookEndpoint(id);
  broadcastSettingsUpdate('webhooks');
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

export const weixinRoutes: ApiRoute[] = [
  route({
    method: 'GET',
    path: '/api/settings/weixin/accounts',
    handler: () => handleGetWeixinAccounts(),
  }),
  route({
    method: 'POST',
    path: '/api/settings/weixin/accounts',
    handler: (req) => handleCreateWeixinAccount(req),
  }),
  route({
    method: 'PATCH',
    path: '/api/settings/weixin/accounts/:accountId',
    handler: (req, params) => handleUpdateWeixinAccount(req, params.accountId),
  }),
  route({
    method: 'DELETE',
    path: '/api/settings/weixin/accounts/:accountId',
    handler: (_req, params) => handleDeleteWeixinAccount(params.accountId),
  }),
  route({
    method: 'POST',
    path: '/api/settings/weixin/accounts/:accountId/login/start',
    handler: (_req, params) => handleStartWeixinLogin(params.accountId),
  }),
  route({
    method: 'GET',
    path: '/api/settings/weixin/accounts/:accountId/login/status',
    handler: (_req, params) => handleGetWeixinLoginStatus(params.accountId),
  }),
  route({
    method: 'POST',
    path: '/api/settings/weixin/accounts/:accountId/test',
    handler: (_req, params) => handleTestWeixinAccount(params.accountId),
  }),
  route({
    method: 'GET',
    path: '/api/settings/weixin/accounts/:accountId/users',
    handler: (_req, params) => handleListWeixinUsers(params.accountId),
  }),
  route({
    method: 'POST',
    path: '/api/settings/weixin/accounts/:accountId/users/:userId/approve',
    handler: (_req, params) =>
      handleApproveWeixinUser(params.accountId, decodeURIComponent(params.userId)),
  }),
  route({
    method: 'POST',
    path: '/api/settings/weixin/accounts/:accountId/users/:userId/test',
    handler: (_req, params) =>
      handleTestWeixinUser(params.accountId, decodeURIComponent(params.userId)),
  }),
  route({
    method: 'DELETE',
    path: '/api/settings/weixin/accounts/:accountId/users/:userId',
    handler: (_req, params) =>
      handleDeleteWeixinUser(params.accountId, decodeURIComponent(params.userId)),
  }),
];

export const webhookRoutes: ApiRoute[] = [
  route({ method: 'GET', path: '/api/webhooks', handler: () => handleGetWebhooks() }),
  route({ method: 'POST', path: '/api/webhooks', handler: (req) => handleCreateWebhook(req) }),
  route({
    method: 'DELETE',
    path: '/api/webhooks/:id',
    handler: (_req, params) => handleDeleteWebhook(params.id),
  }),
];
