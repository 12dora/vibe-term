import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');

describe('0058 relay enroll password', () => {
  test('adds nullable enroll_password_enc on mesh_relays', () => {
    const sqlite = new Database(':memory:');
    sqlite.run('PRAGMA foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder });
    try {
      const columns = sqlite.query('PRAGMA table_info(mesh_relays)').all() as Array<{
        name: string;
        notnull: number;
        type: string;
      }>;
      const column = columns.find((row) => row.name === 'enroll_password_enc');
      expect(column).toBeTruthy();
      expect(column?.notnull).toBe(0);
      expect(column?.type.toLowerCase()).toBe('text');
    } finally {
      sqlite.close();
    }
  });
});
