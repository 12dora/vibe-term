import { afterEach, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import {
  PortMapExportStore,
  PortMapStore,
  onPortMapRowsRevoked,
  removePortMapsForRevocation,
  removePortMapsOfInactiveTokens,
} from './store';
import type { PortMapRow } from './types';

const NODE = 'd'.repeat(32);

function row(id: string): PortMapRow {
  return {
    id,
    name: 'pg',
    listenHost: '127.0.0.1',
    listenPort: 15_432,
    targetNodeId: NODE,
    targetHost: '127.0.0.1',
    targetPort: 5432,
    paused: false,
    createdAt: 100,
    updatedAt: 100,
  };
}

const closers: Array<() => void> = [];

function migratedDb() {
  const fixture = createMigratedAuthDb();
  closers.push(fixture.close);
  return fixture.db;
}

describe('portmap store', () => {
  afterEach(() => {
    while (closers.length > 0) closers.pop()?.();
  });

  test('migration 0050 creates both tables and round-trips a map row', () => {
    const store = new PortMapStore(migratedDb());
    expect(store.list()).toEqual([]);
    store.insert(row('map-1'));
    expect(store.get('map-1')).toEqual({ ...row('map-1'), issuedVia: 'self' });
    store.update('map-1', { name: 'renamed', paused: true, updatedAt: 200 });
    const updated = store.get('map-1');
    expect(updated?.name).toBe('renamed');
    expect(updated?.paused).toBe(true);
    expect(updated?.updatedAt).toBe(200);
    store.remove('map-1');
    expect(store.get('map-1')).toBeNull();
  });

  test('lease columns round-trip and stay absent for persistent rows', () => {
    const maps = new PortMapStore(migratedDb());
    maps.insert({ ...row('leased'), leaseExpiresAt: 5_000 });
    maps.insert(row('plain'));
    expect(maps.get('leased')?.leaseExpiresAt).toBe(5_000);
    expect('leaseExpiresAt' in (maps.get('plain') ?? {})).toBe(false);
    maps.update('leased', { leaseExpiresAt: 9_000, updatedAt: 300 });
    expect(maps.get('leased')?.leaseExpiresAt).toBe(9_000);

    const exports = new PortMapExportStore(migratedDb());
    const base = { mapId: 'e1', fromNodeId: NODE, host: '127.0.0.1', port: 1, enabled: true };
    exports.insert({ ...base, createdAt: 1, leaseExpiresAt: 7_000 });
    expect(exports.get('e1')?.leaseExpiresAt).toBe(7_000);
    exports.insert({ ...base, createdAt: 2 });
    expect('leaseExpiresAt' in (exports.get('e1') ?? {})).toBe(false);
  });

  test('export rows are keyed by map id and upsert in place', () => {
    const store = new PortMapExportStore(migratedDb());
    store.insert({
      mapId: 'map-1',
      fromNodeId: NODE,
      host: '127.0.0.1',
      port: 5432,
      enabled: true,
      createdAt: 1,
    });
    store.insert({
      mapId: 'map-1',
      fromNodeId: NODE,
      host: '127.0.0.1',
      port: 6543,
      enabled: false,
      createdAt: 2,
    });
    expect(store.list()).toHaveLength(1);
    expect(store.get('map-1')).toEqual({
      mapId: 'map-1',
      fromNodeId: NODE,
      host: '127.0.0.1',
      port: 6543,
      enabled: false,
      createdAt: 2,
      issuedVia: 'self',
    });
    store.remove('map-1');
    expect(store.list()).toEqual([]);
  });

  test('origin columns round-trip; revocation deletes rows by entry node or creator token', () => {
    const db = migratedDb();
    const maps = new PortMapStore(db);
    const exports = new PortMapExportStore(db);
    const entry = 'e'.repeat(32);
    maps.insert({ ...row('via-entry'), issuedVia: entry });
    maps.insert({ ...row('by-token'), createdByTokenId: 'tok-1' });
    maps.insert(row('local'));
    const base = { host: '127.0.0.1', port: 22, enabled: true, createdAt: 1 };
    exports.insert({ ...base, mapId: 'x-via', fromNodeId: NODE, issuedVia: entry });
    exports.insert({ ...base, mapId: 'x-from', fromNodeId: entry });
    exports.insert({ ...base, mapId: 'x-tok', fromNodeId: NODE, createdByTokenId: 'tok-1' });
    exports.insert({ ...base, mapId: 'x-local', fromNodeId: NODE });

    expect(maps.get('via-entry')?.issuedVia).toBe(entry);
    expect(maps.get('by-token')?.createdByTokenId).toBe('tok-1');
    expect('createdByTokenId' in (maps.get('local') ?? {})).toBe(false);

    const notified: string[][] = [];
    const off = onPortMapRowsRevoked((rows) => notified.push(rows.map((item) => item.id)));
    try {
      expect(removePortMapsForRevocation(db, { issuedVia: entry })).toEqual(['via-entry']);
      expect(
        exports
          .list()
          .map((item) => item.mapId)
          .sort()
      ).toEqual(['x-local', 'x-tok']);

      expect(removePortMapsOfInactiveTokens(db, (id) => id === 'tok-1')).toEqual([]);
      expect(removePortMapsOfInactiveTokens(db, () => false)).toEqual(['by-token']);
      expect(maps.list().map((item) => item.id)).toEqual(['local']);
      expect(exports.list().map((item) => item.mapId)).toEqual(['x-local']);
      expect(removePortMapsForRevocation(db, { createdByTokenId: 'tok-1' })).toEqual([]);
      expect(notified).toEqual([['via-entry'], ['by-token']]);
    } finally {
      off();
    }
  });
});
