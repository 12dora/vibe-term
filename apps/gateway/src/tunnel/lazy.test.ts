import { afterEach, describe, expect, test } from 'bun:test';
import { markLiveServicesStopping, setLiveServicesEnabled } from '../live-start-gates';
import {
  configureTunnelManager,
  ensureTunnelManager,
  loadTunnelManager,
  peekTunnelManager,
  peekTunnelPublicUrl,
  resetTunnelManagerLoaderForTests,
  stopTunnelManagerIfLoaded,
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

  test('in-process restart and shutdown during the first start', async () => {
    const { tunnelManager } = await loadTunnelManager();
    const original = { start: tunnelManager.start, stop: tunnelManager.stop };
    const calls: string[] = [];
    let releaseStart: () => void = () => {};
    tunnelManager.start = () => {
      calls.push('start');
      return new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
    };
    tunnelManager.stop = async () => {
      calls.push('stop');
    };
    try {
      setLiveServicesEnabled(true);
      const first = ensureTunnelManager();
      await Promise.resolve();
      await Promise.resolve();
      markLiveServicesStopping();
      const stopping = stopTunnelManagerIfLoaded();
      releaseStart();
      await stopping;
      await first;
      // stop 等 start 落定之后才跑
      expect(calls).toEqual(['start', 'stop']);

      setLiveServicesEnabled(true);
      tunnelManager.start = async () => {
        calls.push('restart');
      };
      await ensureTunnelManager();
      expect(calls).toEqual(['start', 'stop', 'restart']);

      resetTunnelManagerLoaderForTests();
      const loading = ensureTunnelManager();
      markLiveServicesStopping();
      await stopTunnelManagerIfLoaded();
      await loading;
      expect(calls).toEqual(['start', 'stop', 'restart', 'stop']);
    } finally {
      tunnelManager.start = original.start;
      tunnelManager.stop = original.stop;
      setLiveServicesEnabled(false);
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
