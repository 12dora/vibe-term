import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from '../db/client';
import { tunnelConfig } from '../db/schema';
import { TunnelConfigStore } from '../tunnel/config-store';
import { peekTunnelManager, resetTunnelManagerLoaderForTests } from '../tunnel/lazy';
import { defaultShareOriginSources } from './share-origins';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

beforeEach(() => {
  resetTunnelManagerLoaderForTests();
  getOrmDb().delete(tunnelConfig).run();
});

describe('share origins tunnel source', () => {
  test('reads the persisted hostname without loading the tunnel manager', () => {
    new TunnelConfigStore(getOrmDb()).save({ mode: 'named', hostname: 'tun.example.com' });
    expect(defaultShareOriginSources.tunnelUrl()).toBe('https://tun.example.com');
    expect(peekTunnelManager()).toBeUndefined();
  });

  test('tunnel mode off yields no origin', () => {
    new TunnelConfigStore(getOrmDb()).save({ mode: 'off', hostname: 'tun.example.com' });
    expect(defaultShareOriginSources.tunnelUrl()).toBeNull();
    expect(defaultShareOriginSources.tunnelUrl()).toBeNull();
  });
});
