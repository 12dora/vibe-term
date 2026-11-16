import { afterEach, describe, expect, test } from 'bun:test';
import { setLiveServicesEnabled } from '../live-start-gates';
import {
  configureTunnelManager,
  ensureTunnelManager,
  loadTunnelManager,
  peekTunnelManager,
  peekTunnelPublicUrl,
  resetTunnelManagerLoaderForTests,
} from './lazy';

afterEach(() => {
  setLiveServicesEnabled(false);
});

describe('tunnel/lazy', () => {
  test('host setup runs on first load and again immediately once loaded', async () => {
    resetTunnelManagerLoaderForTests();
    expect(peekTunnelPublicUrl()).toBeNull();
    const seen: unknown[] = [];
    configureTunnelManager((mod) => seen.push(mod.tunnelManager));
    expect(seen).toEqual([]);
    const loaded = await loadTunnelManager();
    expect(seen).toEqual([loaded.tunnelManager]);
    configureTunnelManager((mod) => seen.push(mod));
    expect(seen).toEqual([loaded.tunnelManager, loaded]);
  });

  test('ensureTunnelManager returns the singleton outside live mode', async () => {
    const manager = await ensureTunnelManager();
    expect(manager).toBe(peekTunnelManager()?.tunnelManager as typeof manager);
  });

  test('live mode starts the manager once across concurrent first requests', async () => {
    const { tunnelManager } = await loadTunnelManager();
    const original = tunnelManager.start.bind(tunnelManager);
    let starts = 0;
    tunnelManager.start = async () => {
      starts++;
    };
    try {
      setLiveServicesEnabled(true);
      await Promise.all([ensureTunnelManager(), ensureTunnelManager()]);
      await ensureTunnelManager();
      expect(starts).toBe(1);
    } finally {
      tunnelManager.start = original;
      resetTunnelManagerLoaderForTests();
    }
  });

  test('loadTunnelManager memoizes the singleton', async () => {
    const first = await loadTunnelManager();
    const second = await loadTunnelManager();
    expect(first).toBe(second);
    expect(typeof first.tunnelManager.start).toBe('function');
  });
});
