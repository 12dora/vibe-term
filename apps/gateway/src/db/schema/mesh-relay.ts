import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** 节点侧的中继目标表；`set-relays` 记录应用时整表替换，顺序由 priority 决定。 */
export const meshRelays = sqliteTable('mesh_relays', {
  url: text('url').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  tokenEnc: text('token_enc').notNull(),
  priority: integer('priority').notNull(),
  kicked: integer('kicked', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull(),
});

/** 租户密钥：K_log（kind='log'，epoch 恒为 0）与各世代 K_meta（kind='meta'）。 */
export const meshSecrets = sqliteTable(
  'mesh_secrets',
  {
    kind: text('kind').$type<'log' | 'meta'>().notNull(),
    epoch: integer('epoch').notNull(),
    keyEnc: text('key_enc').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.epoch] }),
    check('mesh_secrets_kind_check', sql`${table.kind} in ('log', 'meta')`),
  ]
);

export type MeshRelayRow = typeof meshRelays.$inferSelect;
export type MeshSecretRow = typeof meshSecrets.$inferSelect;
