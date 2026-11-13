import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');
const ISSUED_VIA_MIGRATION = '0063_issued_via.sql';

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

describe('0063_issued_via migration', () => {
  test('existing rows on a 0062 db become issued via self with no creator token', () => {
    const sqlite = migratedUpTo(ISSUED_VIA_MIGRATION);
    try {
      sqlite.run(
        "insert into users (id, username, root_public_key, root_epoch, kdf_params_json, key_log_head_seq, key_log_head_hash, created_at, updated_at) values ('u1', 'alice', x'01', 0, '{}', 0, x'02', 1, 1)"
      );
      sqlite.run(
        "insert into access_tokens (id, user_id, name, scopes, secret_hash, created_at) values ('t1', 'u1', 'ci', '[\"exec\"]', 'h1', 1)"
      );
      sqlite.run(
        "insert into shares (id, name, device_id, window_id, window_name, password_hash, origin, url, created_at) values ('s1', 'n', 'd', '@1', 'w', 'h', 'https://example.com', 'https://example.com/s', 1)"
      );
      sqlite.run(
        "insert into agent_pane_grants (id, token_hash, from_node_id, device_id, pane_id, created_at, last_used_at, expires_at) values ('g1', 'h', 'a', 'd', '%1', 1, 1, 2)"
      );
      sqlite.run(
        "insert into port_maps (id, name, listen_port, target_node_id, target_port, created_at, updated_at) values ('m1', 'n', 15432, 'a', 5432, 1, 1)"
      );
      sqlite.run(
        "insert into port_map_exports (map_id, from_node_id, port, created_at) values ('m1', 'a', 5432, 1)"
      );

      for (const statement of statementsOf(ISSUED_VIA_MIGRATION)) sqlite.run(statement);

      for (const table of ['access_tokens', 'shares', 'agent_pane_grants']) {
        expect(sqlite.query(`select issued_via from ${table}`).get()).toEqual({
          issued_via: 'self',
        });
      }
      for (const table of ['port_maps', 'port_map_exports']) {
        expect(sqlite.query(`select issued_via, created_by_token_id from ${table}`).get()).toEqual({
          issued_via: 'self',
          created_by_token_id: null,
        });
      }
    } finally {
      sqlite.close();
    }
  });
});
