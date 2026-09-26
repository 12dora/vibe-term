import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** 本节点处理过的登录尝试。成功与失败分开封顶，避免暴力尝试把库写满。 */
export const loginRecords = sqliteTable(
  'login_records',
  {
    id: text('id').primaryKey(),
    at: integer('at').notNull(),
    outcome: text('outcome').notNull(),
    uid: text('uid'),
    username: text('username'),
    method: text('method'),
    second: text('second'),
    client: text('client').notNull(),
    kind: text('kind').notNull(),
    viaNodeId: text('via_node_id'),
    targetNodeId: text('target_node_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    origin: text('origin'),
    code: text('code'),
  },
  (table) => [
    check('login_records_outcome_check', sql`${table.outcome} in ('success', 'failed')`),
    check(
      'login_records_method_check',
      sql`${table.method} is null or ${table.method} in ('root', 'passkey')`
    ),
    check(
      'login_records_second_check',
      sql`${table.second} is null or ${table.second} in ('totp', 'passkey', 'waived', 'none')`
    ),
    check('login_records_client_check', sql`${table.client} in ('web', 'cli', 'unknown')`),
    check('login_records_kind_check', sql`${table.kind} in ('interactive', 'background')`),
    index('login_records_outcome_at_idx').on(table.outcome, table.at),
  ]
);
