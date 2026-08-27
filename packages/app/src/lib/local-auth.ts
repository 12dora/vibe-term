import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultInstallDir } from '../constants';
import type { ParsedArgs } from '../types';
import { readEnvFile } from './env-file';
import { pathExists } from './fs-utils';
import { createInstallLayout, resolveInstallDir } from './install-layout';
import { asString } from './validate';

export type LocalAuthEnv = Record<string, string>;

export type LocalAuthContext = {
  env: LocalAuthEnv;
  installDir: string;
  envPath: string;
  databaseUrl: string;
  migrationsFolder: string;
  db: import('../../../../apps/gateway/src/auth/types').AuthDb;
  sqlite: { close: () => void };
  close: () => void;
  userStore: import('../../../../apps/gateway/src/auth/user-store').UserStore;
  keyLogStore: import('../../../../apps/gateway/src/auth/key-log-store').KeyLogStore;
  nodeSessionStore: import('../../../../apps/gateway/src/auth/node-session-store').NodeSessionStore;
  identityStore: import('../../../../apps/gateway/src/auth/node-identity-store').NodeIdentityStore;
  userKeys: import('../../../../apps/gateway/src/auth/user-key-service').UserKeyService;
};

export type OpenLocalAuthOptions = {
  databaseUrl?: string;
  migrationsFolder?: string;
  env?: LocalAuthEnv;
  memory?: boolean;
};

function applyCliEnv(env: LocalAuthEnv): void {
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
}

export function resolveCliMigrationsFolder(installDir?: string): string {
  const fromEnv = process.env.TMEX_MIGRATIONS_DIR;
  if (fromEnv) return fromEnv;
  if (installDir) {
    return createInstallLayout(installDir).drizzleDir;
  }
  const byCwd = resolve(process.cwd(), 'drizzle');
  if (existsSync(byCwd)) return byCwd;
  return resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
}

export async function loadInstallEnv(parsed?: ParsedArgs): Promise<{
  installDir: string;
  envPath: string;
  env: LocalAuthEnv;
}> {
  const installDir = resolveInstallDir(
    asString(parsed?.flags['install-dir']) || defaultInstallDir(process.platform)
  );
  const layout = createInstallLayout(installDir);
  if (!(await pathExists(layout.envPath))) {
    throw new Error(`config file not found: ${layout.envPath}. run tmex init first`);
  }
  const env = await readEnvFile(layout.envPath);
  applyCliEnv(env);
  return { installDir, envPath: layout.envPath, env };
}

async function attachStores(
  db: LocalAuthContext['db'],
  sqlite: { close: () => void },
  options: OpenLocalAuthOptions,
  extra: { installDir?: string; envPath?: string } = {}
): Promise<LocalAuthContext> {
  const { UserStore } = await import('../../../../apps/gateway/src/auth/user-store');
  const { KeyLogStore } = await import('../../../../apps/gateway/src/auth/key-log-store');
  const { NodeSessionStore } = await import('../../../../apps/gateway/src/auth/node-session-store');
  const { NodeIdentityStore } = await import(
    '../../../../apps/gateway/src/auth/node-identity-store'
  );
  const { UserKeyService } = await import('../../../../apps/gateway/src/auth/user-key-service');

  const userStore = new UserStore(db);
  const keyLogStore = new KeyLogStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  const identityStore = new NodeIdentityStore(db);
  const userKeys = new UserKeyService({ db, userStore, keyLogStore, nodeSessionStore });
  const close = (): void => {
    sqlite.close();
  };

  return {
    env: options.env ?? {},
    installDir: extra.installDir ?? '',
    envPath: extra.envPath ?? '',
    databaseUrl:
      options.databaseUrl ?? (options.memory ? ':memory:' : (process.env.DATABASE_URL ?? '')),
    migrationsFolder: options.migrationsFolder ?? resolveCliMigrationsFolder(),
    db,
    sqlite,
    close,
    userStore,
    keyLogStore,
    nodeSessionStore,
    identityStore,
    userKeys,
  };
}

export async function openLocalAuth(options: OpenLocalAuthOptions = {}): Promise<LocalAuthContext> {
  if (options.env) {
    applyCliEnv(options.env);
  }

  if (options.memory || options.databaseUrl === ':memory:') {
    const { createMigratedAuthDb } = await import('../../../../apps/gateway/src/auth/test-db');
    const { sqlite, db, close } = createMigratedAuthDb();
    const ctx = await attachStores(db, sqlite, options);
    const originalClose = ctx.close;
    ctx.close = close;
    void originalClose;
    return ctx;
  }

  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }
  process.env.DATABASE_URL = databaseUrl;
  if (options.migrationsFolder) {
    process.env.TMEX_MIGRATIONS_DIR = options.migrationsFolder;
  }

  const { runMigrations } = await import('../../../../apps/gateway/src/db/migrate');
  const { getDb, getSqliteClient } = await import('../../../../apps/gateway/src/db/client');
  runMigrations(options.migrationsFolder ?? resolveCliMigrationsFolder());
  const db = getDb();
  const sqlite = getSqliteClient();
  return await attachStores(db, sqlite, { ...options, databaseUrl }, {});
}

export async function openInstallAuth(parsed?: ParsedArgs): Promise<LocalAuthContext> {
  const loaded = await loadInstallEnv(parsed);
  const databaseUrl = loaded.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL missing from app.env');
  }
  const ctx = await openLocalAuth({
    databaseUrl,
    migrationsFolder: resolveCliMigrationsFolder(loaded.installDir),
    env: loaded.env,
  });
  ctx.installDir = loaded.installDir;
  ctx.envPath = loaded.envPath;
  ctx.env = loaded.env;
  return ctx;
}
