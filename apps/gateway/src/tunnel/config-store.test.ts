import { describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { TunnelConfigStore } from './config-store';

describe('tunnel_config migration', () => {
  test('applies tunnel_config and round-trips a row', () => {
    const { sqlite, db, close } = createMigratedAuthDb();
    try {
      const tables = sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tunnel_config'")
        .all();
      expect(tables.length).toBe(1);
      const store = new TunnelConfigStore(db);
      expect(store.get().mode).toBe('off');
      const saved = store.save({
        mode: 'named',
        hostname: 'tmex.example.com',
        tunnelName: 'tmex-tmex',
        tunnelId: '550e8400-e29b-41d4-a716-446655440000',
        autoStart: true,
      });
      expect(saved.mode).toBe('named');
      expect(store.get()).toMatchObject({
        mode: 'named',
        hostname: 'tmex.example.com',
        tunnelName: 'tmex-tmex',
        autoStart: true,
      });
    } finally {
      close();
    }
  });
});
