import { describe, expect, test } from 'bun:test';
import type { TunnelConnectorStatus, TunnelEdgeResolution } from '@tmex/shared';
import { type EdgeRecoveryToken, TunnelEdgeRecovery } from './edge-recovery';

const staticEdge: TunnelEdgeResolution = {
  mode: 'static',
  fakeIpDetected: true,
  edgeAddrs: ['198.41.192.7:7844'],
  checkedAt: '2026-09-05T00:00:00.000Z',
  lastError: null,
};

const degraded: TunnelConnectorStatus = {
  reachable: true,
  metricsAddr: '127.0.0.1:41234',
  readyConnections: 0,
  connectorId: 'c',
  checkedAt: '2026-09-05T00:00:00.000Z',
  lastError: null,
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('TunnelEdgeRecovery', () => {
  test('restarts once with the resolved static edge', async () => {
    const restarts: TunnelEdgeResolution[] = [];
    const recovery = new TunnelEdgeRecovery({
      now: () => 1_000,
      delayMs: 0,
      resolveEdge: async () => staticEdge,
      currentEdge: () => null,
      canRestart: () => true,
      restart: async (edge) => {
        restarts.push(edge);
      },
      warn: () => {},
    });
    await recovery.maybeRecover(degraded);
    await recovery.maybeRecover(degraded);
    expect(restarts).toEqual([staticEdge]);
  });

  test('a stop while the resolution is pending cancels the restart', async () => {
    const pending = deferred<TunnelEdgeResolution | null>();
    let restarts = 0;
    const recovery = new TunnelEdgeRecovery({
      now: () => 1_000,
      delayMs: 0,
      resolveEdge: () => pending.promise,
      currentEdge: () => null,
      canRestart: () => true,
      restart: async () => {
        restarts += 1;
      },
      warn: () => {},
    });
    const run = recovery.maybeRecover(degraded);
    recovery.reset();
    pending.resolve(staticEdge);
    await run;
    expect(restarts).toBe(0);
  });

  test('a stop while the old process is being killed marks the token cancelled', async () => {
    const seen: EdgeRecoveryToken[] = [];
    const stopping = deferred<void>();
    const recovery = new TunnelEdgeRecovery({
      now: () => 1_000,
      delayMs: 0,
      resolveEdge: async () => staticEdge,
      currentEdge: () => null,
      canRestart: () => true,
      restart: async (_edge, token) => {
        seen.push(token);
        expect(token.cancelled).toBe(false);
        await stopping.promise;
      },
      warn: () => {},
    });
    const run = recovery.maybeRecover(degraded);
    await Bun.sleep(1);
    recovery.reset();
    stopping.resolve();
    await run;
    expect(seen.length).toBe(1);
    expect(seen[0]?.cancelled).toBe(true);
  });
});
