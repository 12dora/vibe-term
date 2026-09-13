import { Database } from 'bun:sqlite';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import { config } from '../config';
import { getMemoryProfile } from '../memory-profile';
import * as schema from './schema';

let sqliteClient: Database | null = null;
let db: BunSQLiteDatabase<typeof schema> | null = null;

export function sqliteCacheSizeKib(profile = getMemoryProfile()): number {
  return profile === 'small' ? -2000 : -4000;
}

export function applyPragmas(database: Database, profile = getMemoryProfile()): void {
  database.run('PRAGMA foreign_keys = ON');
  database.run('PRAGMA journal_mode = WAL');
  database.run('PRAGMA busy_timeout = 5000');
  database.run('PRAGMA synchronous = NORMAL');
  database.run(`PRAGMA cache_size = ${sqliteCacheSizeKib(profile)}`);
  database.run('PRAGMA mmap_size = 0');
  database.run('PRAGMA wal_autocheckpoint = 500');
}

function ensureSqliteClient(): Database {
  if (!sqliteClient) {
    sqliteClient = new Database(config.databaseUrl);
    applyPragmas(sqliteClient);
  }

  return sqliteClient;
}

export function getSqliteClient(): Database {
  return ensureSqliteClient();
}

export function getDb(): BunSQLiteDatabase<typeof schema> {
  if (!db) {
    db = drizzle(ensureSqliteClient(), { schema });
  }

  return db;
}
