import { Database } from 'bun:sqlite';
import { chmodSync, lstatSync } from 'node:fs';
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

export function chmodDbTrioSync(dbPath: string): void {
  if (!dbPath || dbPath === ':memory:' || dbPath.includes(':memory:')) return;
  for (const suffix of ['', '-wal', '-shm'] as const) {
    const path = `${dbPath}${suffix}`;
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      chmodSync(path, 0o600);
    } catch {
      // WAL/SHM may not exist yet
    }
  }
}

function ensureSqliteClient(): Database {
  if (!sqliteClient) {
    sqliteClient = new Database(config.databaseUrl);
    applyPragmas(sqliteClient);
    chmodDbTrioSync(config.databaseUrl);
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
