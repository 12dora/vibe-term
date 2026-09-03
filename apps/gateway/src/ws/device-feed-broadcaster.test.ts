import { describe, expect, spyOn, test } from 'bun:test';

import { DeviceFeedBroadcaster, type DeviceFeedHost } from './device-feed-broadcaster';
import { GatewayActivityMetrics } from './gateway-activity-metrics';
import {
  TERMINAL_OUTPUT_METRICS_CHECK_EVERY,
  TerminalOutputMetrics,
} from './terminal-output-metrics';

function makeHost(metrics: TerminalOutputMetrics): DeviceFeedHost & { reports: number } {
  const host = {
    connections: new Map(),
    terminalOutputMetrics: metrics,
    gatewayActivityMetrics: new GatewayActivityMetrics(),
    terminalOutputEventsUntilMetricsCheck: TERMINAL_OUTPUT_METRICS_CHECK_EVERY,
    reports: 0,
    sendEnvelope() {},
    reportTerminalOutputMetricsIfDue() {
      host.reports += 1;
    },
    onStateSnapshotInstalled() {},
  };
  return host;
}

describe('terminal output metrics window', () => {
  test('keeps the 1024-count fast path inside a 30s window', () => {
    const started = 1_000;
    const metrics = new TerminalOutputMetrics(30_000, started);
    const host = makeHost(metrics);
    const feed = new DeviceFeedBroadcaster(host);
    const dateNow = spyOn(Date, 'now');
    dateNow.mockImplementation(() => started + 5_000);
    try {
      for (let i = 0; i < TERMINAL_OUTPUT_METRICS_CHECK_EVERY - 1; i++) {
        feed.noteTerminalOutput('dev', '%1', new Uint8Array([1]));
      }
      expect(host.reports).toBe(0);
      feed.noteTerminalOutput('dev', '%1', new Uint8Array([1]));
      expect(host.reports).toBe(1);
      expect(host.terminalOutputEventsUntilMetricsCheck).toBe(TERMINAL_OUTPUT_METRICS_CHECK_EVERY);
    } finally {
      dateNow.mockRestore();
    }
  });

  test('closes the window on the first event after 30s with a fake clock', () => {
    const started = 1_000;
    const metrics = new TerminalOutputMetrics(30_000, started);
    const host = makeHost(metrics);
    const feed = new DeviceFeedBroadcaster(host);
    const dateNow = spyOn(Date, 'now');
    dateNow.mockImplementation(() => started + 30_000);
    try {
      feed.noteTerminalOutput('dev', '%1', new Uint8Array([1]));
      expect(host.reports).toBe(1);
      expect(host.terminalOutputEventsUntilMetricsCheck).toBe(TERMINAL_OUTPUT_METRICS_CHECK_EVERY);
    } finally {
      dateNow.mockRestore();
    }
  });
});
