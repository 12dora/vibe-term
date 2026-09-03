import { sql } from 'drizzle-orm';
import { blob, check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const relayConfig = sqliteTable(
  'relay_config',
  {
    id: integer('id').primaryKey(),
    passwordHash: text('password_hash'),
    passwordEpoch: integer('password_epoch').notNull().default(0),
    minTokenEpoch: integer('min_token_epoch').notNull().default(0),
    adminTokenHash: text('admin_token_hash'),
    defaultQuotaJson: text('default_quota_json').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [check('relay_config_singleton_check', sql`${table.id} = 1`)]
);

export const relayTenants = sqliteTable('relay_tenants', {
  id: text('id').primaryKey(),
  rootPublicKey: blob('root_public_key', { mode: 'buffer' }).notNull(),
  rootEpoch: integer('root_epoch').notNull(),
  tokenHash: text('token_hash').notNull(),
  tokenEpoch: integer('token_epoch').notNull(),
  quotaJson: text('quota_json'),
  label: text('label'),
  kicked: integer('kicked', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at'),
  bytesIn: integer('bytes_in').notNull().default(0),
  bytesOut: integer('bytes_out').notNull().default(0),
  keyLogHeadSeq: integer('key_log_head_seq').notNull().default(0),
});

export const relayNodes = sqliteTable(
  'relay_nodes',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => relayTenants.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    edPk: blob('ed_pk', { mode: 'buffer' }).notNull(),
    x25519Pk: blob('x25519_pk', { mode: 'buffer' }).notNull(),
    status: text('status').notNull(),
    admitSeq: integer('admit_seq'),
    lastSeenAt: integer('last_seen_at'),
    protoVersion: integer('proto_version'),
    clientVersion: text('client_version'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.nodeId] }),
    check('relay_nodes_status_check', sql`${table.status} in ('pending', 'admitted', 'revoked')`),
  ]
);

export const relayEnrollments = sqliteTable('relay_enrollments', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => relayTenants.id, { onDelete: 'cascade' }),
  enrollPk: blob('enroll_pk', { mode: 'buffer' }).notNull().unique(),
  authorizationBytes: blob('authorization_bytes', { mode: 'buffer' }).notNull(),
  authorizationSig: blob('authorization_sig', { mode: 'buffer' }).notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  nodeId: text('node_id'),
  createdAt: integer('created_at').notNull(),
});

export const relayKeyLog = sqliteTable(
  'relay_key_log',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => relayTenants.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    blobJson: text('blob').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.seq] })]
);
