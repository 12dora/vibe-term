import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  GatewayPingMetrics,
  logPingMetricsIfDue,
  recordPingProbe,
  resetPingMetricsForTest,
  setPingMetricsForTest,
} from './gateway-metrics-log';

afterEach(() => {
  resetPingMetricsForTest();
});

describe('GatewayPingMetrics', () => {
  test('aggregates probes, p50/max handle time, bypassed vs queued, buffered max', () => {
    const metrics = new GatewayPingMetrics(1, 0);
    metrics.record({ serverHandleMs: 1, path: 'bypassed', bufferedBytes: 10 });
    metrics.record({ serverHandleMs: 5, path: 'queued', bufferedBytes: 70_000 });
    metrics.record({ serverHandleMs: 3, path: 'bypassed', bufferedBytes: 20 });

    const snapshot = metrics.takeIfDue(10);
    expect(snapshot).toEqual({
      intervalMs: 10,
      probes: 3,
      serverHandleMsP50: 3,
      serverHandleMsMax: 5,
      bypassed: 2,
      queued: 1,
      bufferedMaxBytes: 70_000,
    });
    expect(metrics.takeIfDue(10)).toBeNull();
  });

  test('even sample count uses rounded median', () => {
    const metrics = new GatewayPingMetrics(1, 0);
    metrics.record({ serverHandleMs: 2, path: 'bypassed', bufferedBytes: 1 });
    metrics.record({ serverHandleMs: 4, path: 'bypassed', bufferedBytes: 1 });
    expect(metrics.takeIfDue(1)?.serverHandleMsP50).toBe(3);
  });

  test('empty window reports zeros', () => {
    const metrics = new GatewayPingMetrics(1, 0);
    expect(metrics.takeIfDue(5)).toEqual({
      intervalMs: 5,
      probes: 0,
      serverHandleMsP50: 0,
      serverHandleMsMax: 0,
      bypassed: 0,
      queued: 0,
      bufferedMaxBytes: 0,
    });
  });
});

describe('logPingMetricsIfDue', () => {
  test('emits a single [ws-metrics] ping line for a due window', () => {
    const started = Date.now();
    setPingMetricsForTest(new GatewayPingMetrics(60_000, started));
    recordPingProbe({ serverHandleMs: 2, path: 'bypassed', bufferedBytes: 128 });
    recordPingProbe({ serverHandleMs: 8, path: 'queued', bufferedBytes: 4096 });

    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((message: unknown) => {
      if (typeof message === 'string') logs.push(message);
    });
    try {
      logPingMetricsIfDue(started + 60_000);
    } finally {
      logSpy.mockRestore();
    }

    const line = logs.find((entry) => entry.includes('[ws-metrics] ping '));
    expect(line).toBeDefined();
    expect(line).toContain('probes=2');
    expect(line).toContain('server_handle_ms_p50=5');
    expect(line).toContain('server_handle_ms_max=8');
    expect(line).toContain('bypassed=1');
    expect(line).toContain('queued=1');
    expect(line).toContain('buffered_max_bytes=4096');
    expect(line).toContain('event_loop_lag_ms=');
  });
});
