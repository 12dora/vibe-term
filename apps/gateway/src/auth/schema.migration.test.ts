import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createMigratedAuthDb } from './test-db';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');

const KEEPER_TABLES = [
  'users',
  'user_keys',
  'user_key_log',
  'node_sessions',
  'node_certs',
  'nodes',
  'enrollment_tokens',
  'node_identity',
  'peer_cache',
  'mesh_relays',
  'mesh_secrets',
  'node_local_prefs',
  'relay_ca_pins',
] as const;

const DROPPED_HUB_TABLES = [
  'user_hub_authorizations',
  'hub_trust',
  'mesh_hubs',
  'hub_role_transitions',
  'enrollment_token_repl',
  'enrollment_token_repl_meta',
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

function statementsOf(name: string): string[] {
  return readFileSync(resolve(migrationsFolder, name), 'utf8')
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function migratedUpTo(until: string): Database {
  const sqlite = new Database(':memory:');
  sqlite.run('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(migrationsFolder)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    if (name === until) break;
    for (const statement of statementsOf(name)) sqlite.run(statement);
  }
  return sqlite;
}

describe('auth schema migration', () => {
  test('full chain keeps membership tables and drops hub tables', () => {
    const { sqlite, close } = createMigratedAuthDb();
    try {
      const tables = new Set(
        sqlite
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => (row as { name: string }).name)
      );
      for (const name of KEEPER_TABLES) {
        expect(tables.has(name)).toBe(true);
      }
      for (const name of DROPPED_HUB_TABLES) {
        expect(tables.has(name)).toBe(false);
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
      expect(indexes.has('user_hub_authorizations_user_id_hub_node_id_unique')).toBe(false);

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
          `INSERT INTO node_identity (id, node_id, private_key, x25519_private_key, certificate_json, cert_sig)
           VALUES (1, 'aa', 'enc', 'enc2', '{}', X'00')`
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

  test('0036 allows rotate-root-keep on user_key_log type check', () => {
    const { sqlite, close } = createMigratedAuthDb();
    try {
      sqlite
        .query(
          `INSERT INTO users (id, username, root_public_key, root_epoch, kdf_params_json, key_log_head_seq, key_log_head_hash, created_at, updated_at)
           VALUES ('u1', 'alice', X'00', 1, '{}', 0, X'00', 1, 1)`
        )
        .run();
      sqlite
        .query(
          `INSERT INTO user_key_log (seq, user_id, prev_hash, hash, root_epoch, type, record_bytes, sig, payload_json, created_at)
           VALUES (1, 'u1', X'00', X'00', 1, 'rotate-root-keep', X'00', X'00', '{}', 1)`
        )
        .run();
      const row = sqlite
        .query(`SELECT type FROM user_key_log WHERE user_id = 'u1' AND seq = 1`)
        .get() as { type: string };
      expect(row.type).toBe('rotate-root-keep');
      expect(() =>
        sqlite
          .query(
            `INSERT INTO user_key_log (seq, user_id, prev_hash, hash, root_epoch, type, record_bytes, sig, payload_json, created_at)
             VALUES (2, 'u1', X'00', X'00', 1, 'not-a-type', X'00', X'00', '{}', 1)`
          )
          .run()
      ).toThrow();
    } finally {
      close();
    }
  });

  test('0041 adds nullable version on peer_cache', () => {
    const { sqlite, close } = createMigratedAuthDb();
    try {
      const columns = sqlite.query('PRAGMA table_info(peer_cache)').all() as Array<{
        name: string;
        notnull: number;
      }>;
      const version = columns.find((column) => column.name === 'version');
      expect(version).toBeTruthy();
      expect(version?.notnull).toBe(0);
    } finally {
      close();
    }
  });

  test('0045 allows readmit-node on user_key_log type check', () => {
    const { sqlite, close } = createMigratedAuthDb();
    try {
      sqlite
        .query(
          `INSERT INTO users (id, username, root_public_key, root_epoch, kdf_params_json, key_log_head_seq, key_log_head_hash, created_at, updated_at)
           VALUES ('u1', 'alice', X'00', 1, '{}', 0, X'00', 1, 1)`
        )
        .run();
      sqlite
        .query(
          `INSERT INTO user_key_log (seq, user_id, prev_hash, hash, root_epoch, type, record_bytes, sig, payload_json, created_at)
           VALUES (1, 'u1', X'00', X'00', 1, 'readmit-node', X'00', X'00', '{}', 1)`
        )
        .run();
      const row = sqlite
        .query(`SELECT type FROM user_key_log WHERE user_id = 'u1' AND seq = 1`)
        .get() as { type: string };
      expect(row.type).toBe('readmit-node');
      expect(() =>
        sqlite
          .query(
            `INSERT INTO user_key_log (seq, user_id, prev_hash, hash, root_epoch, type, record_bytes, sig, payload_json, created_at)
             VALUES (2, 'u1', X'00', X'00', 1, 'not-a-type', X'00', X'00', '{}', 1)`
          )
          .run()
      ).toThrow();
    } finally {
      close();
    }
  });

  test('0043 adds nullable kdf_params_json / sealed_pack on relay_tenants', () => {
    const { sqlite, close } = createMigratedAuthDb();
    try {
      const columns = sqlite.query('PRAGMA table_info(relay_tenants)').all() as Array<{
        name: string;
        notnull: number;
      }>;
      for (const name of ['kdf_params_json', 'sealed_pack']) {
        const column = columns.find((row) => row.name === name);
        expect(column).toBeTruthy();
        expect(column?.notnull).toBe(0);
      }
    } finally {
      close();
    }
  });

  test('0057 drops hub tables, sentinel peer, hub_url, and maps uplink_kind hub→none', () => {
    const sqlite = migratedUpTo('0057_remove_hub.sql');
    const hubNodeId = 'aa'.repeat(16);
    const peerNodeId = 'bb'.repeat(16);
    const selfNodeId = 'cc'.repeat(16);
    try {
      sqlite
        .query(
          `INSERT INTO mesh_hubs (hub_node_id, public_url, mode, priority, writer_epoch, updated_at)
           VALUES (?, 'https://hub.example', 'active', 1, 1, 1)`
        )
        .run(hubNodeId);
      sqlite
        .query(
          `INSERT INTO hub_trust (hub_url, ca_pem, fingerprint, created_at)
           VALUES ('https://hub.example', '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----', ?, 1)`
        )
        .run('ab'.repeat(32));
      sqlite.query(`INSERT INTO peer_cache (node_id, name) VALUES ('hub', 'Hub')`).run();
      sqlite.query(`INSERT INTO peer_cache (node_id, name) VALUES (?, 'studio')`).run(peerNodeId);
      sqlite
        .query(
          `INSERT INTO node_identity (id, node_id, hub_url, private_key, x25519_private_key, certificate_json, cert_sig, user_id, uplink_kind, name)
           VALUES (1, ?, 'https://hub.example', 'enc-ed', 'enc-x', '{"keep":true}', X'0102', 'user-1', 'hub', 'studio')`
        )
        .run(selfNodeId);

      expect(
        sqlite
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mesh_hubs'")
          .get()
      ).not.toBeNull();
      const before = sqlite.query('PRAGMA table_info(node_identity)').all() as Array<{
        name: string;
      }>;
      expect(before.map((column) => column.name)).toContain('hub_url');

      for (const statement of statementsOf('0057_remove_hub.sql')) sqlite.run(statement);

      const tables = new Set(
        sqlite
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => (row as { name: string }).name)
      );
      for (const name of DROPPED_HUB_TABLES) {
        expect(tables.has(name)).toBe(false);
      }
      expect(tables.has('peer_cache')).toBe(true);
      expect(tables.has('node_identity')).toBe(true);
      expect(tables.has('relay_ca_pins')).toBe(true);
      const pin = sqlite.query('SELECT * FROM relay_ca_pins').get() as {
        relay_url: string;
        ca_pem: string;
        fingerprint: string;
        created_at: number;
      };
      expect(pin.relay_url).toBe('https://hub.example');
      expect(pin.ca_pem).toContain('BEGIN CERTIFICATE');
      expect(pin.fingerprint).toBe('ab'.repeat(32));
      expect(pin.created_at).toBe(1);

      const columns = sqlite.query('PRAGMA table_info(node_identity)').all() as Array<{
        name: string;
        dflt_value: string | null;
      }>;
      expect(columns.map((column) => column.name)).not.toContain('hub_url');
      const uplink = columns.find((column) => column.name === 'uplink_kind');
      expect(uplink?.dflt_value).toBe("'none'");

      const identity = sqlite.query('SELECT * FROM node_identity WHERE id = 1').get() as {
        node_id: string;
        private_key: string;
        x25519_private_key: string;
        certificate_json: string;
        user_id: string | null;
        uplink_kind: string;
        name: string | null;
      };
      expect(identity.node_id).toBe(selfNodeId);
      expect(identity.private_key).toBe('enc-ed');
      expect(identity.x25519_private_key).toBe('enc-x');
      expect(identity.certificate_json).toBe('{"keep":true}');
      expect(identity.user_id).toBe('user-1');
      expect(identity.uplink_kind).toBe('none');
      expect(identity.name).toBe('studio');

      const hubPeer = sqlite.query("SELECT node_id FROM peer_cache WHERE node_id = 'hub'").get();
      expect(hubPeer).toBeNull();
      const keptPeer = sqlite
        .query('SELECT name FROM peer_cache WHERE node_id = ?')
        .get(peerNodeId) as { name: string };
      expect(keptPeer.name).toBe('studio');
    } finally {
      sqlite.close();
    }
  });
});
