import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

/** 终端分享记录；ended 后仍保留作为历史，日志随记录删除一起清掉。 */
export const shares = sqliteTable(
  'shares',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    deviceId: text('device_id').notNull(),
    windowId: text('window_id').notNull(),
    windowName: text('window_name').notNull(),
    state: text('state').notNull().default('active'),
    endReason: text('end_reason'),
    passwordHash: text('password_hash').notNull(),
    origin: text('origin').notNull(),
    url: text('url').notNull(),
    recordLog: integer('record_log', { mode: 'boolean' }).notNull().default(true),
    logBytes: integer('log_bytes').notNull().default(0),
    logTruncated: integer('log_truncated', { mode: 'boolean' }).notNull().default(false),
    logSeq: integer('log_seq').notNull().default(0),
    logPurgedAt: integer('log_purged_at'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at'),
    endedAt: integer('ended_at'),
  },
  (table) => [
    check('shares_state_check', sql`${table.state} in ('active', 'ended')`),
    check(
      'shares_end_reason_check',
      sql`${table.endReason} is null or ${table.endReason} in ('revoked', 'expired', 'window_closed', 'device_removed')`
    ),
    index('shares_state_idx').on(table.state),
    index('shares_device_window_idx').on(table.deviceId, table.windowId),
  ]
);

/** 被分享人登录凭证；只存 token 的 SHA-256 十六进制。 */
export const shareAccessTokens = sqliteTable(
  'share_access_tokens',
  {
    id: text('id').primaryKey(),
    shareId: text('share_id')
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    clientIp: text('client_ip'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    lastSeenAt: integer('last_seen_at'),
  },
  (table) => [index('share_access_tokens_share_idx').on(table.shareId)]
);

/** 录屏式日志：输出 / 输入 / 尺寸 / 首帧快照，按 (share_id, seq) 单调递增。 */
export const shareLogs = sqliteTable(
  'share_logs',
  {
    shareId: text('share_id')
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: integer('at').notNull(),
    kind: text('kind').notNull(),
    paneId: text('pane_id').notNull(),
    cols: integer('cols'),
    rows: integer('rows'),
    data: blob('data', { mode: 'buffer' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.shareId, table.seq] }),
    check('share_logs_kind_check', sql`${table.kind} in ('out', 'in', 'resize', 'checkpoint')`),
  ]
);

export const shareSettings = sqliteTable(
  'share_settings',
  {
    id: integer('id').primaryKey(),
    recordLogs: integer('record_logs', { mode: 'boolean' }).notNull().default(true),
    logRetentionDays: integer('log_retention_days').notNull().default(30),
    logMaxBytes: integer('log_max_bytes').notNull().default(52428800),
    defaultOrigin: text('default_origin'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [check('share_settings_singleton_check', sql`${table.id} = 1`)]
);
