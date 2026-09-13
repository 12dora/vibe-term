import { randomUUID } from 'node:crypto';
import { toBCP47 } from '@vibeterm/shared';
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
import type { ConfigFieldSpec, FieldParseResult } from './config-field';
import { json } from './http';
import {
  createMessagingChannelRoutes,
  parseMessagingFlag,
  parseRequiredTrimmed,
} from './messaging-channel-routes';
import { type ApiRoute, route } from './route';

function parseAccountName(raw: unknown): FieldParseResult<string> {
  return parseRequiredTrimmed(raw, t('weixin.accountNameRequired'));
}

type WeixinAccountCreateDraft = {
  name: string;
  enabled: boolean;
  allowAuthRequests: boolean;
  allowCommands: boolean;
};

type WeixinAccountUpdateDraft = {
  name?: string;
  enabled?: boolean;
  allowAuthRequests?: boolean;
  allowCommands?: boolean;
};

const WEIXIN_CREATE_FIELDS: ConfigFieldSpec<unknown>[] = [
  { name: 'name', parse: parseAccountName, onAbsent: 'parse' },
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

const WEIXIN_UPDATE_FIELDS: ConfigFieldSpec<unknown>[] = [
  { name: 'name', parse: parseAccountName },
  { name: 'enabled', parse: parseMessagingFlag },
  { name: 'allowAuthRequests', parse: parseMessagingFlag },
  { name: 'allowCommands', parse: parseMessagingFlag },
];

async function persistWeixinCreate(
  draft: WeixinAccountCreateDraft
): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  const id = randomUUID();
  createWeixinAccount({
    id,
    name: draft.name,
    enabled: draft.enabled,
    allowAuthRequests: draft.allowAuthRequests,
    allowCommands: draft.allowCommands,
    loggedIn: false,
    weixinUin: null,
    botTokenEnc: null,
    baseUrl: null,
    syncBuf: null,
    createdAt: now,
    updatedAt: now,
  });
  broadcastSettingsUpdate('weixin');
  return { accountId: id };
}

async function persistWeixinUpdate(
  accountId: string,
  draft: WeixinAccountUpdateDraft
): Promise<void> {
  updateWeixinAccount(accountId, draft);
  broadcastSettingsUpdate('weixin');
  await weixinService.refresh();
}

async function persistWeixinDelete(accountId: string): Promise<void> {
  deleteWeixinAccount(accountId);
  broadcastSettingsUpdate('weixin');
  await weixinService.refresh();
}

async function afterApproveWeixin(
  parent: { id: string; name: string },
  userId: string
): Promise<void> {
  broadcastSettingsUpdate('weixin');
  const settings = getSiteSettings();
  try {
    await weixinService.sendTestMessage(
      parent.id,
      userId,
      t('weixin.approveMessageTemplate', {
        accountName: parent.name,
        time: new Date().toLocaleString(toBCP47(settings.language)),
      })
    );
  } catch (err) {
    console.error('[weixin] approve ack failed:', err);
  }
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
  ...createMessagingChannelRoutes({
    channel: 'weixin',
    parentCollection: 'accounts',
    childCollection: 'users',
    parentParam: 'accountId',
    childParam: 'userId',
    listKey: 'accounts',
    childListKey: 'users',
    childKey: 'user',
    parentNotFound: () => t('weixin.accountNotFound'),
    childNotFound: () => t('weixin.userNotFound'),
    createFields: WEIXIN_CREATE_FIELDS,
    updateFields: WEIXIN_UPDATE_FIELDS,
    getById: (id) => getWeixinAccountById(id),
    listWithStats: () => getWeixinAccountsWithStats(),
    listChildren: (parentId) => listWeixinUsersByAccount(parentId),
    approveChild: (parentId, childId) => approveWeixinUser(parentId, childId),
    persistCreate: persistWeixinCreate,
    persistUpdate: persistWeixinUpdate,
    persistDelete: persistWeixinDelete,
    afterApprove: afterApproveWeixin,
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
];
