import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { GatewayActivityMetrics } from './gateway-activity-metrics';
import {
  type GatewayMetricsHost,
  GatewayPingMetrics,
  isQuietTerminalOutputSnapshot,
  logGatewayActivityMetricsIfDue,
  logPingMetricsIfDue,
  logTerminalOutputMetricsIfDue,
  recordPingProbe,
  resetPingMetricsForTest,
  setPingMetricsForTest,
} from './gateway-metrics-log';
import type { TerminalOutputBatcher } from './terminal-output-batcher';
import { TerminalOutputMetrics, emptyTerminalOutputQueueStats } from './terminal-output-metrics';

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

  test('suppresses a due all-zero ping window but still resets counters', () => {
    const started = Date.now();
    setPingMetricsForTest(new GatewayPingMetrics(1_000, started));
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((message: unknown) => {
      if (typeof message === 'string') logs.push(message);
    });
    try {
      logPingMetricsIfDue(started + 1_000);
      expect(logs.some((entry) => entry.includes('[ws-metrics] ping '))).toBe(false);
      recordPingProbe({ serverHandleMs: 4, path: 'bypassed', bufferedBytes: 1 });
      logPingMetricsIfDue(started + 2_000);
    } finally {
      logSpy.mockRestore();
    }
    const line = logs.find((entry) => entry.includes('[ws-metrics] ping '));
    expect(line).toBeDefined();
    expect(line).toContain('probes=1');
    expect(line).toContain('bypassed=1');
  });
});

describe('ws-metrics zero-snapshot suppression', () => {
  function emptyHost(overrides: Partial<GatewayMetricsHost> = {}): GatewayMetricsHost {
    return {
      connectedClients: new Set(),
      connections: new Map(),
      canonicalSessions: new Map(),
      terminalOutputBatcher: {
        snapshotStats: () => emptyTerminalOutputQueueStats().batch,
      } as TerminalOutputBatcher,
      terminalOutputMetrics: new TerminalOutputMetrics(1, 0),
      gatewayActivityMetrics: new GatewayActivityMetrics(1, 0),
      ...overrides,
    };
  }

  function captureLogs(run: () => void): string[] {
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((message: unknown) => {
      if (typeof message === 'string') logs.push(message);
    });
    try {
      run();
    } finally {
      logSpy.mockRestore();
    }
    return logs;
  }

  test('omits terminal_output and gateway_activity when the window is quiet, then emits after traffic', async () => {
    const terminalOutputMetrics = new TerminalOutputMetrics(1, 0);
    const gatewayActivityMetrics = new GatewayActivityMetrics(1, 0);
    const host = emptyHost({ terminalOutputMetrics, gatewayActivityMetrics });

    const quiet = captureLogs(() => logTerminalOutputMetricsIfDue(host));
    expect(quiet.some((line) => line.includes('[ws-metrics] terminal_output'))).toBe(false);
    expect(quiet.some((line) => line.includes('[ws-metrics] gateway_activity'))).toBe(false);

    terminalOutputMetrics.recordSource(8, { legacy: true, canonical: false });
    gatewayActivityMetrics.recordInbound(0x0003, 12);
    await Bun.sleep(2);
    const busy = captureLogs(() => logTerminalOutputMetricsIfDue(host));
    const output = busy.find((line) => line.includes('[ws-metrics] terminal_output'));
    const activity = busy.find((line) => line.includes('[ws-metrics] gateway_activity'));
    expect(output).toBeDefined();
    expect(output).toContain('source_events=1');
    expect(output).toContain('source_bytes=8');
    expect(activity).toBeDefined();
    expect(activity).toContain('inbound_messages=1');
    expect(activity).toContain('inbound_bytes=12');
  });

  test('resets the activity window when a quiet snapshot is suppressed', async () => {
    const gatewayActivityMetrics = new GatewayActivityMetrics(1, 0);
    const host = emptyHost({
      terminalOutputMetrics: new TerminalOutputMetrics(1, 0),
      gatewayActivityMetrics,
    });
    captureLogs(() => logGatewayActivityMetricsIfDue(host));
    gatewayActivityMetrics.recordTmuxEvent('bell', 1);
    await Bun.sleep(2);
    const logs = captureLogs(() => logGatewayActivityMetricsIfDue(host));
    const line = logs.find((entry) => entry.includes('[ws-metrics] gateway_activity'));
    expect(line).toBeDefined();
    expect(line).toContain('tmux_events=1');
    expect(line).not.toContain('inbound_messages=1');
  });
});

describe('isQuietTerminalOutputSnapshot', () => {
  function quietSnapshot() {
    return {
      intervalMs: 30_000,
      sourceEvents: 0,
      sourceBytes: 0,
      droppedEvents: 0,
      droppedBytes: 0,
      legacyObservedEvents: 0,
      legacyObservedBytes: 0,
      canonicalObservedEvents: 0,
      canonicalObservedBytes: 0,
      batches: 0,
      batchBytes: 0,
      recipientDeliveries: 0,
      recipientBytes: 0,
      canonicalRecipientDeliveries: 0,
      canonicalRecipientBytes: 0,
      canonicalDeliveryDrops: 0,
      canonicalDeliveryDropBytes: 0,
      queues: emptyTerminalOutputQueueStats(),
    };
  }

  test('all-zero counters and empty queues are quiet; limits do not count', () => {
    const snapshot = quietSnapshot();
    snapshot.queues.batch.pendingBytesLimit = 8;
    snapshot.queues.websocket.queuedBytesLimit = 8;
    expect(isQuietTerminalOutputSnapshot(snapshot)).toBe(true);
  });

  test('any counter or pending queue field breaks quiet', () => {
    expect(isQuietTerminalOutputSnapshot({ ...quietSnapshot(), sourceEvents: 1 })).toBe(false);
    expect(
      isQuietTerminalOutputSnapshot({ ...quietSnapshot(), canonicalDeliveryDropBytes: 4 })
    ).toBe(false);
    const queued = quietSnapshot();
    queued.queues.websocket.queuedBytes = 1;
    expect(isQuietTerminalOutputSnapshot(queued)).toBe(false);
    const gaps = quietSnapshot();
    gaps.queues.canonical.pendingPaneGaps = 1;
    expect(isQuietTerminalOutputSnapshot(gaps)).toBe(false);
  });
});
