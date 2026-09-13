import type { WeixinAccountUser, WeixinAccountWithStats } from '@vibeterm/shared';
import { and, eq } from 'drizzle-orm';
import { i18next } from '../i18n';
import { getDb as getOrmDb } from './client';
import { toWeixinAccountRecord, toWeixinAccountUser } from './mappers';
import { createMessagingChannelStore, foldStatusCounters } from './messaging-channel';
import { weixinAccountUsers, weixinAccounts } from './schema';
import type { WeixinAccountConfigRecord } from './types';

export type { WeixinAccountConfigRecord };

const WEIXIN_USER_CAP = 16;

const WEIXIN_UPDATE_KEYS = [
  'name',
  'enabled',
  'allowAuthRequests',
  'allowCommands',
  'weixinUin',
  'botTokenEnc',
  'baseUrl',
  'syncBuf',
] as const;

type WeixinCounters = {
  pending: number;
  authorized: number;
  needsReactivation: number;
};

const store = createMessagingChannelStore({
  tables: {
    parent: weixinAccounts,
    child: weixinAccountUsers,
    parentId: weixinAccounts.id,
    parentCreatedAt: weixinAccounts.createdAt,
    childId: weixinAccountUsers.id,
    childParentId: weixinAccountUsers.accountId,
    childExternalId: weixinAccountUsers.userId,
    childStatus: weixinAccountUsers.status,
    childAppliedAt: weixinAccountUsers.appliedAt,
    childAuthorizedAt: weixinAccountUsers.authorizedAt,
  },
  toParent: toWeixinAccountRecord,
  toChild: toWeixinAccountUser,
  emptyCounters: (): WeixinCounters => ({ pending: 0, authorized: 0, needsReactivation: 0 }),
  extraStatsColumns: { needsReactivation: weixinAccountUsers.needsReactivation },
  foldChild: (acc: WeixinCounters, row) => {
    foldStatusCounters(acc, row.status);
    if (row.status === 'authorized' && row.needsReactivation) {
      acc.needsReactivation += 1;
    }
  },
  toStats: (account, counter): WeixinAccountWithStats => ({
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    allowAuthRequests: account.allowAuthRequests,
    allowCommands: account.allowCommands,
    loggedIn: account.loggedIn,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    pendingCount: counter.pending,
    authorizedCount: counter.authorized,
    needsReactivationCount: counter.needsReactivation,
  }),
  updateKeys: WEIXIN_UPDATE_KEYS,
});

export function createWeixinAccount(record: WeixinAccountConfigRecord): void {
  const { loggedIn: _loggedIn, ...values } = record;
  store.create(values);
}

export function getWeixinAccountById(accountId: string): WeixinAccountConfigRecord | null {
  return store.getById(accountId);
}

export function getAllWeixinAccounts(): WeixinAccountConfigRecord[] {
  return store.list();
}

export function getWeixinAccountsWithStats(): WeixinAccountWithStats[] {
  return store.listWithStats();
}

export function updateWeixinAccount(
  accountId: string,
  updates: Partial<
    Pick<
      WeixinAccountConfigRecord,
      | 'name'
      | 'enabled'
      | 'allowAuthRequests'
      | 'allowCommands'
      | 'weixinUin'
      | 'botTokenEnc'
      | 'baseUrl'
      | 'syncBuf'
    >
  >
): WeixinAccountConfigRecord | null {
  return store.update(accountId, updates);
}

export function deleteWeixinAccount(accountId: string): void {
  store.remove(accountId);
}

export function getWeixinUserByAccountAndUserId(
  accountId: string,
  userId: string
): WeixinAccountUser | null {
  return store.getChild(accountId, userId);
}

/** 收到 inbound 消息时落库：已存在则刷新会话（缓存 context_token、清除 needsReactivation）；
 * 新用户在 allowAuthRequests 时建 pending 行，否则忽略（返回 null）。 */
export function upsertWeixinUserOnInbound(params: {
  accountId: string;
  userId: string;
  displayName: string;
  contextToken: string | null;
  allowAuthRequests: boolean;
  at: string;
}): WeixinAccountUser | null {
  const existing = store.getChild(params.accountId, params.userId);
  const orm = getOrmDb();

  if (existing) {
    const setValues: Partial<typeof weixinAccountUsers.$inferInsert> = {
      displayName: params.displayName,
      lastInboundAt: params.at,
      needsReactivation: false,
      updatedAt: params.at,
    };
    if (params.contextToken != null) {
      setValues.lastContextToken = params.contextToken;
    }
    orm
      .update(weixinAccountUsers)
      .set(setValues)
      .where(eq(weixinAccountUsers.id, existing.id))
      .run();
    return store.getChild(params.accountId, params.userId);
  }

  if (!params.allowAuthRequests) {
    return null;
  }
  if (store.countChildren(params.accountId) >= WEIXIN_USER_CAP) {
    throw new Error(i18next.t('apiError.invalidRequest'));
  }

  orm
    .insert(weixinAccountUsers)
    .values({
      id: crypto.randomUUID(),
      accountId: params.accountId,
      userId: params.userId,
      displayName: params.displayName,
      status: 'pending',
      lastContextToken: params.contextToken,
      lastInboundAt: params.at,
      needsReactivation: false,
      appliedAt: params.at,
      authorizedAt: null,
      updatedAt: params.at,
    })
    .run();

  return store.getChild(params.accountId, params.userId);
}

export function listWeixinUsersByAccount(accountId: string): WeixinAccountUser[] {
  return store.listChildren(accountId);
}

export function listAuthorizedWeixinUsersByAccount(accountId: string): WeixinAccountUser[] {
  return store.listAuthorized(accountId);
}

/** 注水 WeixinClient 的 context_token 缓存：返回该账号下持有缓存 token 的所有用户。 */
export function getWeixinUserContextTokens(
  accountId: string
): Array<{ userId: string; contextToken: string }> {
  const orm = getOrmDb();
  return orm
    .select({
      userId: weixinAccountUsers.userId,
      contextToken: weixinAccountUsers.lastContextToken,
    })
    .from(weixinAccountUsers)
    .where(eq(weixinAccountUsers.accountId, accountId))
    .all()
    .filter((row): row is { userId: string; contextToken: string } => row.contextToken != null);
}

export function approveWeixinUser(accountId: string, userId: string): WeixinAccountUser | null {
  return store.approveChild(accountId, userId);
}

/** 标记/清除「会话过期、需重新激活」（发送失败置 true，inbound 恢复置 false）。 */
export function setWeixinUserNeedsReactivation(
  accountId: string,
  userId: string,
  value: boolean
): void {
  const orm = getOrmDb();
  orm
    .update(weixinAccountUsers)
    .set({ needsReactivation: value, updatedAt: new Date().toISOString() })
    .where(and(eq(weixinAccountUsers.accountId, accountId), eq(weixinAccountUsers.userId, userId)))
    .run();
}
