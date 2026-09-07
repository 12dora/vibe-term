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
  test('迁移保留单槽原始时间，空新列或旧版修改后的空环回退单槽，损坏环不复活令牌', () => {
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
      sqlite.run("UPDATE relay_tenants SET previous_tokens_json = '[]'");
      expect(store.get('tenant')?.previousTokens).toEqual([{ hash: 'previous', issued_at: 10 }]);
      for (const value of ['{broken', '{}']) {
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

describe('relay token ring downgrade compatibility', () => {
  test.each(['kick/recover', 'reissue', 'timestamp'] as const)(
    '新版 → 旧版 %s → 新版以旧单槽为准',
    (operation) => {
      const sqlite = new Database(':memory:');
      try {
        for (const name of readdirSync(folder)
          .filter((name) => name.endsWith('.sql') && name <= migration)
          .sort()) {
          apply(sqlite, name);
        }
        const store = new RelayTenantStore(drizzle(sqlite, { schema }));
        store.create({
          id: 'tenant',
          rootPublicKey: new Uint8Array(32),
          rootEpoch: 0,
          tokenHash: 'T0',
          tokenEpoch: 0,
          now: 1,
        });
        store.reissueToken({
          tenantId: 'tenant',
          tokenHash: 'T1',
          tokenEpoch: 0,
          keepPrevious: true,
          now: 10,
        });
        if (operation === 'kick/recover') {
          sqlite.run(`UPDATE relay_tenants SET token_hash = 'T2', kicked = 0,
            prev_token_hash = NULL, prev_token_issued_at = NULL`);
        } else if (operation === 'reissue') {
          sqlite.run(`UPDATE relay_tenants SET token_hash = 'T2',
            prev_token_hash = 'T1', prev_token_issued_at = 20`);
        } else {
          sqlite.run('UPDATE relay_tenants SET prev_token_issued_at = 5');
        }
        const tenant = store.get('tenant');
        if (!tenant) throw new Error('missing tenant');
        expect(tenant.previousTokens).toEqual(
          operation === 'kick/recover'
            ? []
            : [
                {
                  hash: operation === 'reissue' ? 'T1' : 'T0',
                  issued_at: operation === 'reissue' ? 20 : 5,
                },
              ]
        );
        expect(relayTokenHashAccepted(tenant, 'T0', RELAY_PREV_TOKEN_GRACE_MS + 6)).toBe(false);
        if (operation === 'reissue') expect(relayTokenHashAccepted(tenant, 'T1', 30)).toBe(true);
        store.reissueToken({
          tenantId: 'tenant',
          tokenHash: 'T3',
          tokenEpoch: 0,
          keepPrevious: true,
          now: RELAY_PREV_TOKEN_GRACE_MS + 6,
        });
        const latest = store.get('tenant');
        if (!latest) throw new Error('missing tenant');
        expect(relayTokenHashAccepted(latest, 'T0', RELAY_PREV_TOKEN_GRACE_MS + 6)).toBe(false);
      } finally {
        sqlite.close();
      }
    }
  );
});
