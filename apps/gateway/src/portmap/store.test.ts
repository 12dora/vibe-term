import { afterEach, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { PortMapExportStore, PortMapStore } from './store';
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
    expect(store.get('map-1')).toEqual(row('map-1'));
    store.update('map-1', { name: 'renamed', paused: true, updatedAt: 200 });
    const updated = store.get('map-1');
    expect(updated?.name).toBe('renamed');
    expect(updated?.paused).toBe(true);
    expect(updated?.updatedAt).toBe(200);
    store.remove('map-1');
    expect(store.get('map-1')).toBeNull();
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
    });
    store.remove('map-1');
    expect(store.list()).toEqual([]);
  });
});
