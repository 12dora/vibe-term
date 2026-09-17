import { describe, expect, spyOn, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';

import { TmuxCommandFailedError } from '../tmux-client/tmux-command-error';
import { DeviceFeedBroadcaster, type DeviceFeedHost } from './device-feed-broadcaster';
import { GatewayActivityMetrics } from './gateway-activity-metrics';
import type { GatewaySession } from './gateway-session';
import { ShareSessionIndex } from './share-session-index';
import {
  TERMINAL_OUTPUT_METRICS_CHECK_EVERY,
  TerminalOutputMetrics,
} from './terminal-output-metrics';
import type { DeviceConnectionEntry } from './types';

function makeHost(metrics: TerminalOutputMetrics): DeviceFeedHost & { reports: number } {
  const host = {
    connections: new Map(),
    shareIndex: new ShareSessionIndex(),
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

describe('device error 去重', () => {
  function makeErrorHost(): DeviceFeedHost & { kinds: number[] } {
    const host = {
      ...makeHost(new TerminalOutputMetrics(30_000, 0)),
      kinds: [] as number[],
      sendEnvelope(_session: GatewaySession, kind: number) {
        host.kinds.push(kind);
      },
    };
    return host;
  }

  test('已上报过的一次性 tmux 命令失败不再广播第二条 device error', () => {
    const host = makeErrorHost();
    host.connections.set('dev', {
      clients: new Set<GatewaySession>([{} as GatewaySession]),
    } as DeviceConnectionEntry);
    const feed = new DeviceFeedBroadcaster(host);

    feed.broadcastError('dev', new TmuxCommandFailedError('boom'));
    expect(host.kinds).toEqual([]);

    feed.broadcastError('dev', new Error('boom'));
    expect(host.kinds).toEqual([wsBorsh.KIND_DEVICE_EVENT]);
  });
});
