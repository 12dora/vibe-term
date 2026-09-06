import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');

type ColumnInfo = { name: string; notnull: number; type: string; dflt_value: string | null };

describe('0049 relay limits', () => {
  test('adds max_tenants / total_bandwidth_bytes_per_sec / fair_share on relay_config', () => {
    const sqlite = new Database(':memory:');
    sqlite.run('PRAGMA foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder });
    try {
      const columns = sqlite.query('PRAGMA table_info(relay_config)').all() as ColumnInfo[];
      const byName = new Map(columns.map((row) => [row.name, row]));

      for (const name of ['max_tenants', 'total_bandwidth_bytes_per_sec']) {
        const column = byName.get(name);
        expect(column).toBeTruthy();
        expect(column?.notnull).toBe(0);
        expect(column?.type.toLowerCase()).toBe('integer');
      }
      const fairShare = byName.get('fair_share');
      expect(fairShare).toBeTruthy();
      expect(fairShare?.notnull).toBe(1);
      expect(fairShare?.type.toLowerCase()).toBe('integer');
      expect(Number(fairShare?.dflt_value)).toBe(1);

      sqlite
        .query(
          `INSERT INTO relay_config (id, password_epoch, min_token_epoch, default_quota_json, updated_at)
           VALUES (1, 0, 0, '{}', 1)`
        )
        .run();
      const seeded = sqlite
        .query(
          'SELECT max_tenants, total_bandwidth_bytes_per_sec, fair_share FROM relay_config WHERE id = 1'
        )
        .get() as {
        max_tenants: number | null;
        total_bandwidth_bytes_per_sec: number | null;
        fair_share: number;
      };
      expect(seeded.max_tenants).toBeNull();
      expect(seeded.total_bandwidth_bytes_per_sec).toBeNull();
      expect(seeded.fair_share).toBe(1);

      sqlite
        .query(
          'UPDATE relay_config SET max_tenants = ?, total_bandwidth_bytes_per_sec = ?, fair_share = ? WHERE id = 1'
        )
        .run(8, 1024, 0);
      const stored = sqlite
        .query(
          'SELECT max_tenants, total_bandwidth_bytes_per_sec, fair_share FROM relay_config WHERE id = 1'
        )
        .get() as {
        max_tenants: number;
        total_bandwidth_bytes_per_sec: number;
        fair_share: number;
      };
      expect(stored.max_tenants).toBe(8);
      expect(stored.total_bandwidth_bytes_per_sec).toBe(1024);
      expect(stored.fair_share).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
