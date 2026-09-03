import type { WeixinAccountUser, WeixinAccountWithStats } from '@tmex/shared';
import { and, count, desc, eq } from 'drizzle-orm';
import { i18next } from '../i18n';
import { getDb as getOrmDb } from './client';
import { toWeixinAccountRecord, toWeixinAccountUser } from './mappers';
import { weixinAccountUsers, weixinAccounts } from './schema';
import { aggregateByParent } from './stats';
import type { WeixinAccountConfigRecord } from './types';

export type { WeixinAccountConfigRecord };

const WEIXIN_USER_CAP = 16;

export function createWeixinAccount(record: WeixinAccountConfigRecord): void {
  const orm = getOrmDb();
  orm
    .insert(weixinAccounts)
    .values({
      id: record.id,
      name: record.name,
      enabled: record.enabled,
      allowAuthRequests: record.allowAuthRequests,
      weixinUin: record.weixinUin,
      botTokenEnc: record.botTokenEnc,
      baseUrl: record.baseUrl,
      syncBuf: record.syncBuf,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })
    .run();
}

export function getWeixinAccountById(accountId: string): WeixinAccountConfigRecord | null {
  const orm = getOrmDb();
  const row = orm.select().from(weixinAccounts).where(eq(weixinAccounts.id, accountId)).get();
  if (!row) {
    return null;
  }
  return toWeixinAccountRecord(row);
}

export function getAllWeixinAccounts(): WeixinAccountConfigRecord[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(weixinAccounts)
    .orderBy(desc(weixinAccounts.createdAt))
    .all()
    .map(toWeixinAccountRecord);
}

export function getWeixinAccountsWithStats(): WeixinAccountWithStats[] {
  const orm = getOrmDb();
  const accounts = orm.select().from(weixinAccounts).orderBy(desc(weixinAccounts.createdAt)).all();

  const userRows = orm
    .select({
      accountId: weixinAccountUsers.accountId,
      status: weixinAccountUsers.status,
      needsReactivation: weixinAccountUsers.needsReactivation,
    })
    .from(weixinAccountUsers)
    .all();

  const counters = aggregateByParent(
    userRows,
    (row) => row.accountId,
    () => ({ pending: 0, authorized: 0, needsReactivation: 0 }),
    (current, row) => {
      if (row.status === 'pending') {
        current.pending += 1;
      }
      if (row.status === 'authorized') {
        current.authorized += 1;
        if (row.needsReactivation) {
          current.needsReactivation += 1;
        }
      }
    }
  );

  return accounts.map((account) => {
    const counter = counters.get(account.id) ?? {
      pending: 0,
      authorized: 0,
      needsReactivation: 0,
    };
    return {
      id: account.id,
      name: account.name,
      enabled: account.enabled,
      allowAuthRequests: account.allowAuthRequests,
      loggedIn: account.botTokenEnc != null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      pendingCount: counter.pending,
      authorizedCount: counter.authorized,
      needsReactivationCount: counter.needsReactivation,
    };
  });
}

export function updateWeixinAccount(
  accountId: string,
  updates: Partial<
    Pick<
      WeixinAccountConfigRecord,
      'name' | 'enabled' | 'allowAuthRequests' | 'weixinUin' | 'botTokenEnc' | 'baseUrl' | 'syncBuf'
    >
  >
): WeixinAccountConfigRecord | null {
  const orm = getOrmDb();
  const setValues: Partial<typeof weixinAccounts.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  if (updates.name !== undefined) {
    setValues.name = updates.name;
  }
  if (updates.enabled !== undefined) {
    setValues.enabled = updates.enabled;
  }
  if (updates.allowAuthRequests !== undefined) {
    setValues.allowAuthRequests = updates.allowAuthRequests;
  }
  if (updates.weixinUin !== undefined) {
    setValues.weixinUin = updates.weixinUin;
  }
  if (updates.botTokenEnc !== undefined) {
    setValues.botTokenEnc = updates.botTokenEnc;
  }
  if (updates.baseUrl !== undefined) {
    setValues.baseUrl = updates.baseUrl;
  }
  if (updates.syncBuf !== undefined) {
    setValues.syncBuf = updates.syncBuf;
  }

  orm.update(weixinAccounts).set(setValues).where(eq(weixinAccounts.id, accountId)).run();
  return getWeixinAccountById(accountId);
}

export function deleteWeixinAccount(accountId: string): void {
  const orm = getOrmDb();
  orm.delete(weixinAccounts).where(eq(weixinAccounts.id, accountId)).run();
}

function getWeixinUserCount(accountId: string): number {
  const orm = getOrmDb();
  const row = orm
    .select({ total: count() })
    .from(weixinAccountUsers)
    .where(eq(weixinAccountUsers.accountId, accountId))
    .get();

  return Number(row?.total ?? 0);
}

export function getWeixinUserByAccountAndUserId(
  accountId: string,
  userId: string
): WeixinAccountUser | null {
  const orm = getOrmDb();
  const row = orm
    .select()
    .from(weixinAccountUsers)
    .where(and(eq(weixinAccountUsers.accountId, accountId), eq(weixinAccountUsers.userId, userId)))
    .get();

  if (!row) {
    return null;
  }

  return toWeixinAccountUser(row);
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
  const existing = getWeixinUserByAccountAndUserId(params.accountId, params.userId);
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
    return getWeixinUserByAccountAndUserId(params.accountId, params.userId);
  }

  if (!params.allowAuthRequests) {
    return null;
  }
  if (getWeixinUserCount(params.accountId) >= WEIXIN_USER_CAP) {
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

  return getWeixinUserByAccountAndUserId(params.accountId, params.userId);
}

export function listWeixinUsersByAccount(accountId: string): WeixinAccountUser[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(weixinAccountUsers)
    .where(eq(weixinAccountUsers.accountId, accountId))
    .orderBy(desc(weixinAccountUsers.appliedAt))
    .all()
    .map(toWeixinAccountUser);
}

export function listAuthorizedWeixinUsersByAccount(accountId: string): WeixinAccountUser[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(weixinAccountUsers)
    .where(
      and(eq(weixinAccountUsers.accountId, accountId), eq(weixinAccountUsers.status, 'authorized'))
    )
    .orderBy(desc(weixinAccountUsers.authorizedAt))
    .all()
    .map(toWeixinAccountUser);
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
  const existing = getWeixinUserByAccountAndUserId(accountId, userId);
  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  const orm = getOrmDb();
  orm
    .update(weixinAccountUsers)
    .set({
      status: 'authorized',
      authorizedAt: now,
      updatedAt: now,
    })
    .where(eq(weixinAccountUsers.id, existing.id))
    .run();

  return getWeixinUserByAccountAndUserId(accountId, userId);
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
