import { describe, expect, test } from 'bun:test';

import { GatewayActivityMetrics } from './gateway-activity-metrics';

describe('GatewayActivityMetrics', () => {
  test('reports inbound kinds and non-output fanout without identifiers', () => {
    const metrics = new GatewayActivityMetrics(1_000, 10_000);
    metrics.recordInbound(0x0003, 12);
    metrics.recordInbound(0x0201, 20);
    metrics.recordInbound(0x0201, 30);
    metrics.recordSnapshot(100, 3);
    metrics.recordTerminalHistory(200, 2);
    metrics.recordTmuxEvent('bell', 1);

    expect(metrics.takeIfDue(10_999)).toBeNull();
    expect(metrics.takeIfDue(11_000)).toEqual({
      intervalMs: 1_000,
      inboundMessages: 3,
      inboundBytes: 62,
      inboundKinds: [
        [0x0003, 1],
        [0x0201, 2],
      ],
      snapshots: 1,
      snapshotBytes: 100,
      snapshotDeliveries: 3,
      terminalHistories: 1,
      terminalHistoryBytes: 200,
      terminalHistoryDeliveryAttempts: 2,
      tmuxEvents: 1,
      tmuxEventDeliveryAttempts: 1,
      tmuxEventTypes: [['bell', 1]],
    });
  });

  test('resets maps and scalar counters after reporting', () => {
    const metrics = new GatewayActivityMetrics(1_000, 5_000);
    metrics.recordInbound(1, 7);
    expect(metrics.takeIfDue(6_000)?.inboundKinds).toEqual([[1, 1]]);
    expect(metrics.takeIfDue(7_000)).toEqual({
      intervalMs: 1_000,
      inboundMessages: 0,
      inboundBytes: 0,
      inboundKinds: [],
      snapshots: 0,
      snapshotBytes: 0,
      snapshotDeliveries: 0,
      terminalHistories: 0,
      terminalHistoryBytes: 0,
      terminalHistoryDeliveryAttempts: 0,
      tmuxEvents: 0,
      tmuxEventDeliveryAttempts: 0,
      tmuxEventTypes: [],
    });
  });
});
