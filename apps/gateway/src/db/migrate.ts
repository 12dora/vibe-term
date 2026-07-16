import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb } from './client';

function resolveMigrationsFolder(): string {
  const fromEnv = process.env.TMEX_MIGRATIONS_DIR;
  if (fromEnv) return fromEnv;

  const byCwd = resolve(process.cwd(), 'drizzle');
  if (existsSync(byCwd)) return byCwd;

  return resolve(import.meta.dir, '../../drizzle');
}

export function runMigrations(migrationsFolder = resolveMigrationsFolder()): void {
  migrate(getDb(), { migrationsFolder });
}

if (import.meta.main) {
  const migrationsFolder = resolveMigrationsFolder();
  runMigrations(migrationsFolder);
  console.log(`[db] migrations applied from ${migrationsFolder}`);
}
