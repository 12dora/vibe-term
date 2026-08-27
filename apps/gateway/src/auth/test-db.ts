import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from '../db/schema';
import type { AuthDb } from './types';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');

export function createMigratedAuthDb(): {
  sqlite: Database;
  db: AuthDb;
  close: () => void;
} {
  const sqlite = new Database(':memory:');
  sqlite.run('PRAGMA foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return {
    sqlite,
    db,
    close: () => sqlite.close(),
  };
}
