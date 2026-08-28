import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createMigratedAuthDb } from './test-db';

const HUB_TABLES = [
  'users',
  'user_keys',
  'user_key_log',
  'node_sessions',
  'node_certs',
  'nodes',
  'enrollment_tokens',
  'node_identity',
  'peer_cache',
] as const;

const EXPECTED_INDEXES = [
  'users_username_unique',
  'user_keys_credential_id_unique',
  'user_key_log_user_id_seq_unique',
  'node_certs_node_id_unique',
  'nodes_id_unique',
  'peer_cache_node_id_unique',
  'node_sessions_sid_unique',
  'node_sessions_user_id_via_node_id_idx',
];

describe('hub auth schema migration', () => {
  test('0018 applies on top of 0017 and creates the hub/node tables and indexes', () => {
    const { sqlite, close } = createMigratedAuthDb();
    try {
      const tables = new Set(
        sqlite
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => (row as { name: string }).name)
      );
      for (const name of HUB_TABLES) {
        expect(tables.has(name)).toBe(true);
      }

      const indexes = new Set(
        sqlite
          .query("SELECT name FROM sqlite_master WHERE type = 'index'")
          .all()
          .map((row) => (row as { name: string }).name)
      );
      for (const name of EXPECTED_INDEXES) {
        expect(indexes.has(name)).toBe(true);
      }

      const columns = sqlite.query('PRAGMA table_info(user_key_log)').all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        'seq',
        'user_id',
        'prev_hash',
        'hash',
        'root_epoch',
        'type',
        'record_bytes',
        'sig',
        'payload_json',
        'created_at',
      ]);
    } finally {
      close();
    }
  });

  test('applying the migration chain a second time is idempotent', () => {
    const { db, sqlite, close } = createMigratedAuthDb();
    try {
      migrate(db, { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
      const users = sqlite.query('SELECT name FROM sqlite_master WHERE name = ?').get('users');
      expect(users).not.toBeNull();
    } finally {
      close();
    }
  });

  test('0020 adds nullable user_id on node_identity so pre-existing rows stay valid', () => {
    const { sqlite, close } = createMigratedAuthDb();
    try {
      const columns = sqlite.query('PRAGMA table_info(node_identity)').all() as Array<{
        name: string;
        notnull: number;
      }>;
      const userId = columns.find((column) => column.name === 'user_id');
      expect(userId).toBeTruthy();
      expect(userId?.notnull).toBe(0);

      sqlite
        .query(
          `INSERT INTO node_identity (id, node_id, hub_url, private_key, x25519_private_key, certificate_json, cert_sig)
           VALUES (1, 'aa', NULL, 'enc', 'enc2', '{}', X'00')`
        )
        .run();
      const row = sqlite.query('SELECT user_id FROM node_identity WHERE id = 1').get() as {
        user_id: string | null;
      };
      expect(row.user_id).toBeNull();
    } finally {
      close();
    }
  });
});
