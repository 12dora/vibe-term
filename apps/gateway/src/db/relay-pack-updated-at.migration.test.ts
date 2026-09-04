import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');

describe('0046 relay pack updated_at', () => {
  test('adds nullable sealed_pack_updated_at on relay_tenants', () => {
    const sqlite = new Database(':memory:');
    sqlite.run('PRAGMA foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder });
    try {
      const columns = sqlite.query('PRAGMA table_info(relay_tenants)').all() as Array<{
        name: string;
        notnull: number;
        type: string;
      }>;
      const column = columns.find((row) => row.name === 'sealed_pack_updated_at');
      expect(column).toBeTruthy();
      expect(column?.notnull).toBe(0);
      expect(column?.type.toLowerCase()).toBe('integer');

      sqlite
        .query(
          `INSERT INTO relay_tenants (
            id, root_public_key, root_epoch, token_hash, token_epoch,
            kicked, created_at, bytes_in, bytes_out, key_log_head_seq
          ) VALUES ('t1', X'00', 0, 'h', 0, 0, 1, 0, 0, 0)`
        )
        .run();
      const empty = sqlite
        .query('SELECT sealed_pack_updated_at FROM relay_tenants WHERE id = ?')
        .get('t1') as { sealed_pack_updated_at: number | null };
      expect(empty.sealed_pack_updated_at).toBeNull();

      sqlite
        .query('UPDATE relay_tenants SET sealed_pack_updated_at = ? WHERE id = ?')
        .run(42, 't1');
      const stored = sqlite
        .query('SELECT sealed_pack_updated_at FROM relay_tenants WHERE id = ?')
        .get('t1') as { sealed_pack_updated_at: number };
      expect(stored.sealed_pack_updated_at).toBe(42);
    } finally {
      sqlite.close();
    }
  });
});
