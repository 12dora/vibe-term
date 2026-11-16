import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from '../db/client';
import * as watchDb from '../db/watch';
import { markLiveServicesStopping, setLiveServicesEnabled } from '../live-start-gates';
import {
  getWatchSamples,
  loadWatchService,
  peekWatchService,
  refreshWatchRule,
  removeWatchRule,
  resetWatchServiceLoaderForTests,
  startWatchService,
  stopWatchServiceIfLoaded,
} from './lazy';

const restores: Array<() => void> = [];

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

afterEach(async () => {
  while (restores.length > 0) restores.pop()?.();
  await stopWatchServiceIfLoaded();
  setLiveServicesEnabled(false);
});

function stubEnabledRule(): void {
  const spy = spyOn(watchDb, 'getWatchRuleById').mockReturnValue({
    id: 'rule-1',
    enabled: true,
  } as watchDb.WatchRuleRecord);
  restores.push(() => spy.mockRestore());
}

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

  test('loaded while live was disabled: enabled rule starts it once live', async () => {
    resetWatchServiceLoaderForTests();
    const { watchService } = await loadWatchService();
    stubEnabledRule();
    await refreshWatchRule('rule-1');
    expect(watchService.isStarted()).toBe(false);

    setLiveServicesEnabled(true);
    await refreshWatchRule('rule-1');
    expect(watchService.isStarted()).toBe(true);
  });

  test('in-process restart: next enabled rule starts the stopped service', async () => {
    setLiveServicesEnabled(true);
    await startWatchService();
    const { watchService } = await loadWatchService();
    expect(watchService.isStarted()).toBe(true);

    markLiveServicesStopping();
    await stopWatchServiceIfLoaded();
    expect(watchService.isStarted()).toBe(false);

    setLiveServicesEnabled(true);
    stubEnabledRule();
    await refreshWatchRule('rule-1');
    expect(watchService.isStarted()).toBe(true);
  });

  test('shutdown during the first load: nothing starts', async () => {
    resetWatchServiceLoaderForTests();
    setLiveServicesEnabled(true);
    const starting = startWatchService();
    markLiveServicesStopping();
    await stopWatchServiceIfLoaded();
    await starting;
    const { watchService } = await loadWatchService();
    expect(watchService.isStarted()).toBe(false);
  });
});
