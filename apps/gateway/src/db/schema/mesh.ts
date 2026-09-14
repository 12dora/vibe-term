import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { users } from './users-auth';

export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').notNull(),
    lastSeenAt: integer('last_seen_at'),
    version: text('version'),
    directCapable: integer('direct_capable', { mode: 'boolean' }).notNull().default(false),
    inventoryJson: text('inventory_json').notNull().default('{}'),
    inventoryVersion: integer('inventory_version').notNull().default(0),
    endpointsJson: text('endpoints_json').notNull().default('[]'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('nodes_id_unique').on(table.id),
    check('nodes_status_check', sql`${table.status} in ('enrolled', 'revoked')`),
  ]
);

export const nodeIdentity = sqliteTable(
  'node_identity',
  {
    id: integer('id').primaryKey(),
    nodeId: text('node_id').notNull(),
    privateKey: text('private_key').notNull(),
    x25519PrivateKey: text('x25519_private_key').notNull(),
    certificateJson: text('certificate_json').notNull(),
    certSig: blob('cert_sig', { mode: 'buffer' }).notNull(),
    userId: text('user_id'),
    uplinkKind: text('uplink_kind').$type<'relay' | 'none'>().notNull().default('none'),
    name: text('name'),
  },
  (table) => [check('node_identity_singleton_check', sql`${table.id} = 1`)]
);

export const peerCache = sqliteTable(
  'peer_cache',
  {
    nodeId: text('node_id').primaryKey(),
    name: text('name').notNull(),
    endpointsJson: text('endpoints_json').notNull().default('[]'),
    inventoryJson: text('inventory_json').notNull().default('{}'),
    directCapable: integer('direct_capable', { mode: 'boolean' }).notNull().default(false),
    lastSeenAt: integer('last_seen_at'),
    listVersion: integer('list_version').notNull().default(0),
    version: text('version'),
  },
  (table) => [uniqueIndex('peer_cache_node_id_unique').on(table.nodeId)]
);

/** dropped by 0057; kept only until store deletion */
export const hubTrust = sqliteTable('hub_trust', {
  hubUrl: text('hub_url').primaryKey(),
  caPem: text('ca_pem').notNull(),
  fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** dropped by 0057; kept only until store deletion */
export const meshHubs = sqliteTable('mesh_hubs', {
  hubNodeId: text('hub_node_id').primaryKey(),
  publicUrl: text('public_url').notNull(),
  name: text('name'),
  mode: text('mode').$type<'active' | 'standby'>().notNull(),
  priority: integer('priority').notNull(),
  writerEpoch: integer('writer_epoch').notNull(),
  caFingerprint: text('ca_fingerprint'),
  online: integer('online', { mode: 'boolean' }).notNull().default(false),
  lastSeenAt: integer('last_seen_at'),
  updatedAt: integer('updated_at').notNull(),
});

/** dropped by 0057; kept only until store deletion */
export const hubRoleTransitions = sqliteTable(
  'hub_role_transitions',
  {
    operationId: text('operation_id').primaryKey(),
    targetHubId: text('target_hub_id').notNull(),
    mode: text('mode').$type<'active' | 'standby'>().notNull(),
    writerEpoch: integer('writer_epoch'),
    phase: text('phase')
      .$type<'accepted' | 'persisting' | 'restarting' | 'complete' | 'failed'>()
      .notNull(),
    error: text('error'),
    startedAt: integer('started_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('hub_role_transitions_mode_check', sql`${table.mode} in ('active', 'standby')`),
    check(
      'hub_role_transitions_phase_check',
      sql`${table.phase} in ('accepted', 'persisting', 'restarting', 'complete', 'failed')`
    ),
    index('hub_role_transitions_updated_at_idx').on(table.updatedAt),
  ]
);

/** 入口本机对成员的偏好；不进 `peer_cache` / 成员 roster，避免被 node.list 覆盖。 */
export const nodeLocalPrefs = sqliteTable('node_local_prefs', {
  nodeId: text('node_id').primaryKey(),
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull(),
});

export type NodeRow = typeof nodes.$inferSelect;
