import { describe, expect, spyOn, test } from 'bun:test';

import { GatewayActivityMetrics } from './gateway-activity-metrics';
import { LegacyFeedBroadcaster, type LegacyFeedHost } from './legacy-feed-broadcaster';
import type { TerminalOutputBatcher } from './terminal-output-batcher';
import {
  TERMINAL_OUTPUT_METRICS_CHECK_EVERY,
  TerminalOutputMetrics,
  emptyTerminalOutputQueueStats,
} from './terminal-output-metrics';

function makeHost(metrics: TerminalOutputMetrics): LegacyFeedHost & { reports: number } {
  const host = {
    connections: new Map(),
    terminalOutputBatcher: {
      push() {},
      snapshotStats: () => emptyTerminalOutputQueueStats().batch,
    } as unknown as TerminalOutputBatcher,
    terminalOutputMetrics: metrics,
    gatewayActivityMetrics: new GatewayActivityMetrics(),
    terminalOutputEventsUntilMetricsCheck: TERMINAL_OUTPUT_METRICS_CHECK_EVERY,
    reports: 0,
    sendEnvelope() {},
    sendChunked() {
      return false;
    },
    sendTermOutput() {
      return null;
    },
    encodeSnapshotWithOverlays() {
      return new Uint8Array();
    },
    reportTerminalOutputMetricsIfDue() {
      host.reports += 1;
    },
    onStateSnapshotInstalled() {},
  };
  return host;
}

describe('legacy terminal output metrics window', () => {
  test('keeps the 1024-count fast path inside a 30s window', () => {
    const started = 1_000;
    const metrics = new TerminalOutputMetrics(30_000, started);
    const host = makeHost(metrics);
    const feed = new LegacyFeedBroadcaster(host);
    const dateNow = spyOn(Date, 'now');
    dateNow.mockImplementation(() => started + 5_000);
    try {
      for (let i = 0; i < TERMINAL_OUTPUT_METRICS_CHECK_EVERY - 1; i++) {
        feed.broadcastTerminalOutput('dev', '%1', new Uint8Array([1]));
      }
      expect(host.reports).toBe(0);
      feed.broadcastTerminalOutput('dev', '%1', new Uint8Array([1]));
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
    const feed = new LegacyFeedBroadcaster(host);
    const dateNow = spyOn(Date, 'now');
    dateNow.mockImplementation(() => started + 30_000);
    try {
      feed.broadcastTerminalOutput('dev', '%1', new Uint8Array([1]));
      expect(host.reports).toBe(1);
      expect(host.terminalOutputEventsUntilMetricsCheck).toBe(TERMINAL_OUTPUT_METRICS_CHECK_EVERY);
    } finally {
      dateNow.mockRestore();
    }
  });
});
