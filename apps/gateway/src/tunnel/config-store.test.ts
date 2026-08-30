import { describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { TunnelAccessStore } from './access-store';
import { TunnelConfigStore } from './config-store';

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
      const store = new TunnelConfigStore(db);
      expect(store.get().mode).toBe('off');
      const saved = store.save({
        mode: 'named',
        hostname: 'tmex.example.com',
        tunnelName: 'tmex-tmex',
        tunnelId: '550e8400-e29b-41d4-a716-446655440000',
        autoStart: true,
        externallyManaged: true,
        exposureAcknowledgedAt: '2026-08-30T00:00:00.000Z',
      });
      expect(saved.mode).toBe('named');
      expect(store.get()).toMatchObject({
        mode: 'named',
        hostname: 'tmex.example.com',
        tunnelName: 'tmex-tmex',
        autoStart: true,
        externallyManaged: true,
        exposureAcknowledgedAt: '2026-08-30T00:00:00.000Z',
      });
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
});
