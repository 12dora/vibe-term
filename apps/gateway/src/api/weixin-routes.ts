import { randomUUID } from 'node:crypto';
import { toBCP47 } from '@tmex/shared';
import {
  approveWeixinUser,
  createWeixinAccount,
  deleteWeixinAccount,
  getSiteSettings,
  getWeixinAccountById,
  getWeixinAccountsWithStats,
  listWeixinUsersByAccount,
  updateWeixinAccount,
} from '../db';
import { t } from '../i18n';
import { broadcastSettingsUpdate } from '../settings/broadcaster';
import { weixinService } from '../weixin/service';
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

function parseAccountName(raw: unknown): FieldParseResult<string> {
  return parseRequiredTrimmed(raw, t('weixin.accountNameRequired'));
}

function parseFlag(raw: unknown): FieldParseResult<boolean> {
  return parseBooleanField(raw, t('apiError.invalidRequest'));
}

type WeixinAccountCreateDraft = {
  name: string;
  enabled: boolean;
  allowAuthRequests: boolean;
};

type WeixinAccountUpdateDraft = {
  name?: string;
  enabled?: boolean;
  allowAuthRequests?: boolean;
};

const WEIXIN_CREATE_FIELDS: ConfigFieldSpec<unknown>[] = [
  { name: 'name', parse: parseAccountName, onAbsent: 'parse' },
  { name: 'enabled', parse: parseFlag, onAbsent: { default: true }, nullIsAbsent: true },
  {
    name: 'allowAuthRequests',
    parse: parseFlag,
    onAbsent: { default: true },
    nullIsAbsent: true,
  },
];

const WEIXIN_UPDATE_FIELDS: ConfigFieldSpec<unknown>[] = [
  { name: 'name', parse: parseAccountName },
  { name: 'enabled', parse: parseFlag },
  { name: 'allowAuthRequests', parse: parseFlag },
];

async function handleGetWeixinAccounts(): Promise<Response> {
  const accounts = getWeixinAccountsWithStats();
  return json({ accounts });
}

async function handleCreateWeixinAccount(req: Request): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const parsed = applyConfigFields<WeixinAccountCreateDraft>(raw, WEIXIN_CREATE_FIELDS, undefined);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  createWeixinAccount({
    id,
    name: parsed.fields.name,
    enabled: parsed.fields.enabled,
    allowAuthRequests: parsed.fields.allowAuthRequests,
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

  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const parsed = applyConfigFields<WeixinAccountUpdateDraft>(raw, WEIXIN_UPDATE_FIELDS, undefined);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }

  updateWeixinAccount(accountId, parsed.fields);
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
];
