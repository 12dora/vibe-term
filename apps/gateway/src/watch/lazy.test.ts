import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from '../db/client';
import { setLiveServicesEnabled } from '../live-start-gates';
import {
  getWatchSamples,
  loadWatchService,
  peekWatchService,
  refreshWatchRule,
  removeWatchRule,
  resetWatchServiceLoaderForTests,
} from './lazy';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

afterEach(() => {
  setLiveServicesEnabled(false);
});

describe('watch/lazy', () => {
  test('route helpers do not load the service while it is unused', async () => {
    resetWatchServiceLoaderForTests();
    expect(getWatchSamples('missing')).toEqual([]);
    await removeWatchRule('missing');
    await refreshWatchRule('missing');
    setLiveServicesEnabled(true);
    await refreshWatchRule('missing');
    expect(peekWatchService()).toBeUndefined();
  });

  test('loadWatchService memoizes the singleton', async () => {
    const first = await loadWatchService();
    const second = await loadWatchService();
    expect(first).toBe(second);
    expect(typeof first.watchService.start).toBe('function');
  });
});
