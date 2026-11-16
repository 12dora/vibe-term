import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from '../db/client';
import { markLiveServicesStopping, setLiveServicesEnabled } from '../live-start-gates';
import {
  ensurePortMapManagerStarted,
  isPortMapManagerReady,
  loadPortMapManager,
  peekPortMapManager,
  resetPortMapLoaderForTests,
  startPortMapManager,
  stopPortMapsIfLoaded,
} from './lazy';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

afterEach(async () => {
  setLiveServicesEnabled(false);
  await resetPortMapLoaderForTests();
});

describe('portmap/lazy', () => {
  test('outside live mode: stays unloaded, routes count as ready', async () => {
    await ensurePortMapManagerStarted();
    await stopPortMapsIfLoaded();
    expect(peekPortMapManager()).toBeUndefined();
    expect(isPortMapManagerReady()).toBe(true);
  });

  test('loaded while live was disabled: not ready once live until ensured', async () => {
    const mod = await loadPortMapManager();
    expect(isPortMapManagerReady()).toBe(true);
    setLiveServicesEnabled(true);
    expect(isPortMapManagerReady()).toBe(false);
    await ensurePortMapManagerStarted();
    expect(mod.portMapManager().isStarted()).toBe(true);
    expect(isPortMapManagerReady()).toBe(true);
  });

  test('in-process restart: stopped manager is reported unready and restarted', async () => {
    setLiveServicesEnabled(true);
    await ensurePortMapManagerStarted();
    const manager = (await loadPortMapManager()).portMapManager();
    expect(manager.isStarted()).toBe(true);

    markLiveServicesStopping();
    await stopPortMapsIfLoaded();
    expect(manager.isStarted()).toBe(false);

    setLiveServicesEnabled(true);
    expect(isPortMapManagerReady()).toBe(false);
    await Promise.all([ensurePortMapManagerStarted(), ensurePortMapManagerStarted()]);
    expect(manager.isStarted()).toBe(true);
  });

  test('shutdown during the first load: the manager is not started', async () => {
    setLiveServicesEnabled(true);
    const starting = startPortMapManager();
    markLiveServicesStopping();
    await stopPortMapsIfLoaded();
    await starting;
    expect(peekPortMapManager()?.portMapManager().isStarted()).toBe(false);
  });
});
