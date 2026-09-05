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

  test('waits for the delay, logs every attempt and keeps retrying while degraded', async () => {
    const warnings: string[] = [];
    const restarts: TunnelEdgeResolution[] = [];
    const resolutions: (TunnelEdgeResolution | null)[] = [
      { ...staticEdge, mode: 'system', edgeAddrs: [], lastError: 'DoH edge resolution failed: x' },
      null,
      staticEdge,
    ];
    let resolved = 0;
    let clock = 0;
    let current: TunnelEdgeResolution | null = null;
    const recovery = new TunnelEdgeRecovery({
      now: () => clock,
      delayMs: 90_000,
      resolveEdge: async () => resolutions[resolved++] ?? null,
      currentEdge: () => current,
      canRestart: () => true,
      restart: async (edge) => {
        restarts.push(edge);
        current = edge;
      },
      warn: (message) => warnings.push(message),
    });

    for (const at of [0, 30_000, 60_000]) {
      clock = at;
      await recovery.maybeRecover(degraded);
    }
    expect(warnings).toEqual([]);
    expect(restarts.length).toBe(0);

    clock = 90_000;
    await recovery.maybeRecover(degraded);
    clock = 120_000;
    await recovery.maybeRecover(degraded);
    clock = 150_000;
    await recovery.maybeRecover(degraded);
    clock = 180_000;
    await recovery.maybeRecover(degraded);

    expect(restarts).toEqual([staticEdge]);
    expect(warnings.length).toBe(3);
    expect(warnings[0]).toContain('attempt=1 result=system degraded=90s');
    expect(warnings[0]).toContain('error=DoH edge resolution failed: x');
    expect(warnings[1]).toContain('attempt=2 result=system degraded=120s');
    expect(warnings[1]).not.toContain('error=');
    expect(warnings[2]).toContain('attempt=3 result=static degraded=150s');
    expect(warnings[2]).toContain('edge=198.41.192.7:7844');
  });

  test('a throwing resolver is logged and does not stop later attempts', async () => {
    const warnings: string[] = [];
    let calls = 0;
    const restarts: TunnelEdgeResolution[] = [];
    const recovery = new TunnelEdgeRecovery({
      now: () => 1_000,
      delayMs: 0,
      resolveEdge: async () => {
        calls += 1;
        if (calls === 1) throw new Error('DoH exploded');
        return staticEdge;
      },
      currentEdge: () => null,
      canRestart: () => true,
      restart: async (edge) => {
        restarts.push(edge);
      },
      warn: (message) => warnings.push(message),
    });
    await recovery.maybeRecover(degraded);
    expect(warnings[0]).toContain('attempt=1 result=error');
    expect(warnings[0]).toContain('DoH exploded');
    await recovery.maybeRecover(degraded);
    expect(restarts).toEqual([staticEdge]);
    expect(warnings[1]).toContain('attempt=2 result=static');
  });
});
