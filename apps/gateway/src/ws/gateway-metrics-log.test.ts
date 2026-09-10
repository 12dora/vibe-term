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
      byKind: [
        {
          kind: 'unknown',
          probes: 3,
          serverHandleMsP50: 3,
          serverHandleMsMax: 5,
          bypassed: 2,
          queued: 1,
          bufferedMaxBytes: 70_000,
        },
      ],
    });
    expect(metrics.takeIfDue(10)).toBeNull();
  });

  test('splits probes by carrier kind', () => {
    const metrics = new GatewayPingMetrics(1, 0);
    metrics.record({
      serverHandleMs: 2,
      path: 'bypassed',
      bufferedBytes: 10,
      kind: 'physical_browser_ws',
    });
    metrics.record({
      serverHandleMs: 8,
      path: 'queued',
      bufferedBytes: 4_096,
      kind: 'mesh_link_stream',
    });
    metrics.record({
      serverHandleMs: 4,
      path: 'bypassed',
      bufferedBytes: 20,
      kind: 'mesh_link_stream',
    });

    const snapshot = metrics.takeIfDue(10);
    expect(snapshot?.probes).toBe(3);
    expect(snapshot?.bypassed).toBe(2);
    expect(snapshot?.queued).toBe(1);
    expect(snapshot?.bufferedMaxBytes).toBe(4_096);
    expect(snapshot?.byKind).toEqual([
      {
        kind: 'mesh_link_stream',
        probes: 2,
        serverHandleMsP50: 6,
        serverHandleMsMax: 8,
        bypassed: 1,
        queued: 1,
        bufferedMaxBytes: 4_096,
      },
      {
        kind: 'physical_browser_ws',
        probes: 1,
        serverHandleMsP50: 2,
        serverHandleMsMax: 2,
        bypassed: 1,
        queued: 0,
        bufferedMaxBytes: 10,
      },
    ]);
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
      byKind: [],
    });
  });
});

function pingAggregateLine(logs: string[]): string | undefined {
  return logs.find((entry) => entry.includes('[ws-metrics] ping probes='));
}

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

    const line = pingAggregateLine(logs);
    expect(line).toBeDefined();
    expect(line).toContain('probes=2');
    expect(line).toContain('server_handle_ms_p50=5');
    expect(line).toContain('server_handle_ms_max=8');
    expect(line).toContain('bypassed=1');
    expect(line).toContain('queued=1');
    expect(line).toContain('buffered_max_bytes=4096');
    expect(line).toContain('event_loop_lag_ms=');
    expect(line).not.toContain('kind=');
  });

  test('emits one per-kind line after the aggregate for kinds that had probes', () => {
    const started = Date.now();
    setPingMetricsForTest(new GatewayPingMetrics(60_000, started));
    recordPingProbe({
      serverHandleMs: 2,
      path: 'bypassed',
      bufferedBytes: 128,
      kind: 'physical_browser_ws',
    });
    recordPingProbe({
      serverHandleMs: 8,
      path: 'queued',
      bufferedBytes: 4096,
      kind: 'mesh_link_stream',
    });

    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((message: unknown) => {
      if (typeof message === 'string') logs.push(message);
    });
    try {
      logPingMetricsIfDue(started + 60_000);
    } finally {
      logSpy.mockRestore();
    }

    const pingLogs = logs.filter((entry) => entry.includes('[ws-metrics] ping '));
    expect(pingLogs).toHaveLength(3);
    const aggregate = pingLogs[0];
    expect(aggregate).toContain('probes=2');
    expect(aggregate).toContain('event_loop_lag_ms=');
    expect(aggregate).not.toContain(' kind=');

    const mesh = pingLogs.find((entry) => entry.includes('kind=mesh_link_stream'));
    const phys = pingLogs.find((entry) => entry.includes('kind=physical_browser_ws'));
    expect(mesh).toBeDefined();
    expect(phys).toBeDefined();
    expect(mesh).toContain('probes=1');
    expect(mesh).toContain('queued=1');
    expect(mesh).toContain('buffered_max_bytes=4096');
    expect(mesh).not.toContain('event_loop_lag_ms=');
    expect(phys).toContain('probes=1');
    expect(phys).toContain('bypassed=1');
    expect(phys).not.toContain('event_loop_lag_ms=');
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
    const line = pingAggregateLine(logs);
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

    terminalOutputMetrics.recordSource(8, { canonical: true });
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
      canonicalObservedEvents: 0,
      canonicalObservedBytes: 0,
      canonicalRecipientDeliveries: 0,
      canonicalRecipientBytes: 0,
      canonicalDeliveryDrops: 0,
      canonicalDeliveryDropBytes: 0,
      queues: emptyTerminalOutputQueueStats(),
    };
  }

  test('all-zero counters and empty queues are quiet; limits do not count', () => {
    const snapshot = quietSnapshot();
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
