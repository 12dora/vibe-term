import type { EventType } from '@tmex/shared';
import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const webhookEndpoints = sqliteTable('webhook_endpoints', {
  id: text('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  eventMask: text('event_mask', { mode: 'json' }).$type<EventType[]>().notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const telegramBots = sqliteTable('telegram_bots', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenEnc: text('token_enc').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  allowAuthRequests: integer('allow_auth_requests', { mode: 'boolean' }).notNull().default(true),
  lastUpdateId: integer('last_update_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const telegramBotChats = sqliteTable(
  'telegram_bot_chats',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => telegramBots.id, { onDelete: 'cascade' }),
    chatId: text('chat_id').notNull(),
    chatType: text('chat_type').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull(),
    appliedAt: text('applied_at').notNull(),
    authorizedAt: text('authorized_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    unique('telegram_bot_chats_bot_chat_unique').on(table.botId, table.chatId),
    check('telegram_bot_chats_status_check', sql`${table.status} in ('pending', 'authorized')`),
    check(
      'telegram_bot_chats_chat_type_check',
      sql`${table.chatType} in ('private', 'group', 'supergroup', 'channel', 'unknown')`
    ),
  ]
);

// 微信 (iLink) 账号：扫码登录后写入凭证（botTokenEnc 加密落库）。未登录时凭证列为 null。
export const weixinAccounts = sqliteTable('weixin_accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  allowAuthRequests: integer('allow_auth_requests', { mode: 'boolean' }).notNull().default(true),
  // iLink 登录确认返回：账号自身标识（uin）/ bearer token / baseurl。
  weixinUin: text('weixin_uin'),
  botTokenEnc: text('bot_token_enc'),
  baseUrl: text('base_url'),
  // 长轮询游标 get_updates_buf（重启续传）。
  syncBuf: text('sync_buf'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// 微信账号的会话对象：授权状态 + 半主动推送的最佳努力 context_token 缓存。
export const weixinAccountUsers = sqliteTable(
  'weixin_account_users',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => weixinAccounts.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull(),
    // 最近 inbound 消息的 context_token（iLink 发送必需，失效后置 needsReactivation）。
    lastContextToken: text('last_context_token'),
    lastInboundAt: text('last_inbound_at'),
    needsReactivation: integer('needs_reactivation', { mode: 'boolean' }).notNull().default(false),
    appliedAt: text('applied_at').notNull(),
    authorizedAt: text('authorized_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    unique('weixin_account_users_account_user_unique').on(table.accountId, table.userId),
    check('weixin_account_users_status_check', sql`${table.status} in ('pending', 'authorized')`),
  ]
);
