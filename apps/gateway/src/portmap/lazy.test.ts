import { afterEach, describe, expect, test } from 'bun:test';
import { setLiveServicesEnabled } from '../live-start-gates';
import {
  ensurePortMapManagerStarted,
  loadPortMapManager,
  peekPortMapManager,
  resetPortMapLoaderForTests,
  stopPortMapsIfLoaded,
} from './lazy';

afterEach(() => {
  setLiveServicesEnabled(false);
  resetPortMapLoaderForTests();
});

describe('portmap/lazy', () => {
  test('outside live mode the manager module stays unloaded', async () => {
    await ensurePortMapManagerStarted();
    stopPortMapsIfLoaded();
    expect(peekPortMapManager()).toBeUndefined();
  });

  test('live mode loads and starts the singleton manager', async () => {
    const mod = await loadPortMapManager();
    const manager = mod.portMapManager();
    const original = manager.start.bind(manager);
    let starts = 0;
    manager.start = () => {
      starts++;
    };
    try {
      setLiveServicesEnabled(true);
      await ensurePortMapManagerStarted();
      expect(peekPortMapManager()).toBe(mod);
      expect(starts).toBe(1);
    } finally {
      manager.start = original;
    }
  });
});
