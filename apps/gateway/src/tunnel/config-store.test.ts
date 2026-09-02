import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { createMigratedAuthDb } from '../auth/test-db';
import * as schema from '../db/schema';
import { TunnelAccessStore } from './access-store';
import { TunnelConfigStore } from './config-store';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');
const ACCESS_MODE_MIGRATION = '0035_tunnel_access_mode.sql';

function statementsOf(name: string): string[] {
  return readFileSync(resolve(migrationsFolder, name), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function applyMigration(db: Database, name: string): void {
  for (const statement of statementsOf(name)) db.run(statement);
}

describe('tunnel_config migration', () => {
  test('applies tunnel_config / tunnel_access and round-trips a row', async () => {
    const { sqlite, db, close } = createMigratedAuthDb();
    try {
      const tables = sqlite
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tunnel_config', 'tunnel_access')"
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name).sort()).toEqual(['tunnel_access', 'tunnel_config']);
      const cols = sqlite.query('PRAGMA table_info(tunnel_config)').all() as Array<{
        name: string;
      }>;
      expect(cols.map((c) => c.name)).toContain('exposure_acknowledged_at');
      expect(cols.map((c) => c.name)).toContain('externally_managed');
      expect(cols.map((c) => c.name)).toContain('access_mode');
      const accessCols = sqlite.query('PRAGMA table_info(tunnel_access)').all() as Array<{
        name: string;
      }>;
      expect(accessCols.map((c) => c.name)).toContain('bypass_app_id');
      const store = new TunnelConfigStore(db);
      expect(store.get().mode).toBe('off');
      expect(store.get().accessMode).toBeNull();
      const saved = store.save({
        mode: 'named',
        hostname: 'tmex.example.com',
        tunnelName: 'tmex-tmex',
        tunnelId: '550e8400-e29b-41d4-a716-446655440000',
        autoStart: true,
        externallyManaged: true,
        exposureAcknowledgedAt: '2026-08-30T00:00:00.000Z',
        accessMode: 'login',
      });
      expect(saved.mode).toBe('named');
      expect(saved.accessMode).toBe('login');
      expect(store.get()).toMatchObject({
        mode: 'named',
        hostname: 'tmex.example.com',
        tunnelName: 'tmex-tmex',
        autoStart: true,
        externallyManaged: true,
        exposureAcknowledgedAt: '2026-08-30T00:00:00.000Z',
        accessMode: 'login',
      });
      store.save({ accessMode: 'none' });
      expect(store.get().accessMode).toBe('none');
      store.save({ accessMode: 'cloudflare' });
      expect(store.get().accessMode).toBe('cloudflare');
      store.save({ accessMode: null });
      expect(store.get().accessMode).toBeNull();
      const access = new TunnelAccessStore(db);
      await access.save({
        apiToken: 'cf-token-secret',
        accountId: 'acc-1',
        teamDomain: 'team.cloudflareaccess.com',
        rules: [{ kind: 'email_domain', value: 'example.com' }],
        enforceJwt: true,
      });
      const row = access.get();
      expect(row.apiTokenEnc).toBeTruthy();
      expect(row.apiTokenEnc).not.toContain('cf-token-secret');
      expect(row.accountId).toBe('acc-1');
      expect(await access.getApiToken()).toBe('cf-token-secret');
    } finally {
      close();
    }
  });

  test('0035 adds nullable access_mode on existing tunnel_config rows', () => {
    const sqlite = new Database(':memory:');
    sqlite.run('PRAGMA foreign_keys = ON');
    const names = readdirSync(migrationsFolder)
      .filter((name) => name.endsWith('.sql') && name < ACCESS_MODE_MIGRATION)
      .sort();
    expect(names[names.length - 1]).toBe('0034_hub_role_transitions.sql');
    for (const name of names) applyMigration(sqlite, name);
    sqlite.run(
      `INSERT INTO tunnel_config (id, mode, hostname, tunnel_name, tunnel_id, auto_start, externally_managed, exposure_acknowledged_at, updated_at)
       VALUES ('default', 'named', 'tmex.example.com', 'tmex', 'tid', 0, 0, null, '2026-09-01T00:00:00.000Z')`
    );
    applyMigration(sqlite, ACCESS_MODE_MIGRATION);
    const cols = sqlite.query('PRAGMA table_info(tunnel_config)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const accessMode = cols.find((c) => c.name === 'access_mode');
    expect(accessMode).toBeDefined();
    expect(accessMode?.notnull).toBe(0);
    const raw = sqlite
      .query('SELECT access_mode FROM tunnel_config WHERE id = ?')
      .get('default') as { access_mode: string | null };
    expect(raw.access_mode).toBeNull();
    const db = drizzle(sqlite, { schema });
    const store = new TunnelConfigStore(db);
    expect(store.get().accessMode).toBeNull();
    store.save({ accessMode: 'cloudflare' });
    expect(store.get().accessMode).toBe('cloudflare');
    expect(() =>
      sqlite.run("UPDATE tunnel_config SET access_mode = 'bogus' WHERE id = 'default'")
    ).toThrow();
    sqlite.close();
  });
});
