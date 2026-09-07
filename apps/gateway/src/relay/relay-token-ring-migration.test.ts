import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '../db/schema';
import { RelayTenantStore } from './relay-tenant-store';
import { relayTokenHashAccepted } from './relay-token-grace';
import { RELAY_PREV_TOKEN_GRACE_MS } from './types';

const folder = resolve(import.meta.dir, '../../drizzle');
const migration = '0055_relay_token_ring.sql';

function apply(sqlite: Database, name: string) {
  for (const sql of readFileSync(resolve(folder, name), 'utf8').split('--> statement-breakpoint')) {
    if (sql.trim()) sqlite.run(sql);
  }
}

describe('0055 relay token ring migration', () => {
  test('迁移保留单槽原始时间，读取兼容空新列，空环或损坏环不复活旧令牌', () => {
    const sqlite = new Database(':memory:');
    try {
      for (const name of readdirSync(folder)
        .filter((name) => name.endsWith('.sql') && name < migration)
        .sort()) {
        apply(sqlite, name);
      }
      sqlite.run(`INSERT INTO relay_tenants
        (id, root_public_key, root_epoch, token_hash, token_epoch, created_at, prev_token_hash, prev_token_issued_at)
        VALUES ('tenant', zeroblob(32), 0, 'current', 0, 1, 'previous', 10)`);
      apply(sqlite, migration);
      const store = new RelayTenantStore(drizzle(sqlite, { schema }));
      const tenant = store.get('tenant');
      expect(tenant?.previousTokens).toEqual([{ hash: 'previous', issued_at: 10 }]);
      if (!tenant) throw new Error('missing tenant');
      expect(relayTokenHashAccepted(tenant, 'previous', RELAY_PREV_TOKEN_GRACE_MS + 11)).toBe(
        false
      );
      sqlite.run('UPDATE relay_tenants SET previous_tokens_json = NULL');
      expect(store.get('tenant')?.previousTokens).toEqual([{ hash: 'previous', issued_at: 10 }]);
      for (const value of ['[]', '{broken', '{}']) {
        sqlite.run('UPDATE relay_tenants SET previous_tokens_json = ?', [value]);
        expect(store.get('tenant')?.previousTokens).toEqual([]);
      }
      store.clearPreviousToken('tenant');
      expect(store.get('tenant')?.prevTokenHash).toBeNull();
      expect(store.get('tenant')?.previousTokens).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
