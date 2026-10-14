import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './users-auth';

/** 机器访问令牌。只存 sha256 摘要；撤销保留行以备审计。 */
export const accessTokens = sqliteTable(
  'access_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    scopes: text('scopes').notNull(),
    secretHash: text('secret_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at'),
    lastUsedAt: integer('last_used_at'),
    lastUsedIp: text('last_used_ip'),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('access_tokens_secret_hash_unique').on(table.secretHash),
    index('access_tokens_user_id_idx').on(table.userId),
  ]
);

export const accessTokenEvents = sqliteTable(
  'access_token_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenId: text('token_id').notNull(),
    userId: text('user_id').notNull(),
    event: text('event').notNull(),
    ip: text('ip'),
    at: integer('at').notNull(),
  },
  (table) => [
    check('access_token_events_event_check', sql`${table.event} in ('created', 'revoked', 'used')`),
    index('access_token_events_token_id_idx').on(table.tokenId),
  ]
);
