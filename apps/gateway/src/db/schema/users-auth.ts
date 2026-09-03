import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    rootPublicKey: blob('root_public_key', { mode: 'buffer' }).notNull(),
    rootEpoch: integer('root_epoch').notNull(),
    kdfParamsJson: text('kdf_params_json').notNull(),
    totpRecordSeq: integer('totp_record_seq'),
    keyLogHeadSeq: integer('key_log_head_seq').notNull(),
    keyLogHeadHash: blob('key_log_head_hash', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [uniqueIndex('users_username_unique').on(table.username)]
);

export const userKeys = sqliteTable(
  'user_keys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: blob('credential_id', { mode: 'buffer' }).notNull(),
    publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
    rpId: text('rp_id').notNull(),
    origin: text('origin').notNull(),
    counter: integer('counter').notNull(),
    transports: text('transports', { mode: 'json' }).$type<string[]>().notNull().default([]),
    name: text('name'),
    logSeq: integer('log_seq').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('user_keys_credential_id_unique').on(table.credentialId)]
);

export const userKeyLog = sqliteTable(
  'user_key_log',
  {
    seq: integer('seq').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    prevHash: blob('prev_hash', { mode: 'buffer' }).notNull(),
    hash: blob('hash', { mode: 'buffer' }).notNull(),
    rootEpoch: integer('root_epoch').notNull(),
    type: text('type').notNull(),
    recordBytes: blob('record_bytes', { mode: 'buffer' }).notNull(),
    sig: blob('sig', { mode: 'buffer' }).notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.seq] }),
    uniqueIndex('user_key_log_user_id_seq_unique').on(table.userId, table.seq),
    check(
      'user_key_log_type_check',
      sql`${table.type} in ('add-passkey', 'remove-passkey', 'rotate-root', 'set-totp', 'clear-totp', 'admit-node', 'revoke-node', 'reset-root', 'admit-hub', 'retire-hub', 'rotate-root-keep')`
    ),
  ]
);

export const nodeSessions = sqliteTable(
  'node_sessions',
  {
    sid: blob('sid', { mode: 'buffer' }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    viaNodeId: text('via_node_id').notNull(),
    sessPublicKey: blob('sess_public_key', { mode: 'buffer' }).notNull(),
    delegationMethod: text('delegation_method').notNull(),
    credentialId: blob('credential_id', { mode: 'buffer' }),
    issuedAt: integer('issued_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    hardExpiresAt: integer('hard_expires_at').notNull(),
    renewedAt: integer('renewed_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('node_sessions_sid_unique').on(table.sid),
    index('node_sessions_user_id_via_node_id_idx').on(table.userId, table.viaNodeId),
    check(
      'node_sessions_delegation_method_check',
      sql`${table.delegationMethod} in ('root', 'passkey')`
    ),
  ]
);

export const nodeCerts = sqliteTable(
  'node_certs',
  {
    nodeId: text('node_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    admitRecordSeq: integer('admit_record_seq').notNull(),
    certificateBytes: blob('certificate_bytes', { mode: 'buffer' }).notNull(),
    certSig: blob('cert_sig', { mode: 'buffer' }).notNull(),
    authorizationBytes: blob('authorization_bytes', { mode: 'buffer' }).notNull(),
    authorizationSig: blob('authorization_sig', { mode: 'buffer' }).notNull(),
    revokedLogSeq: integer('revoked_log_seq'),
  },
  (table) => [uniqueIndex('node_certs_node_id_unique').on(table.nodeId)]
);

export const enrollmentTokens = sqliteTable(
  'enrollment_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    enrollPublicKey: blob('enroll_public_key', { mode: 'buffer' }).notNull(),
    authorizationJson: text('authorization_json').notNull(),
    authorizationSig: blob('authorization_sig', { mode: 'buffer' }).notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    nodeId: text('node_id'),
  },
  (table) => [uniqueIndex('enrollment_tokens_enroll_public_key_unique').on(table.enrollPublicKey)]
);
