import { describe, expect, test } from 'bun:test';

import { GatewayActivityMetrics, collectCanonicalStateMetrics } from './gateway-activity-metrics';

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
      canonical: collectCanonicalStateMetrics([], []),
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
      canonical: collectCanonicalStateMetrics([], []),
    });
  });

  test('aggregates shared runtime gauges once and keeps queue limits beside current values', () => {
    const canonical = collectCanonicalStateMetrics(
      [
        {
          stats: {
            knownPanes: 4,
            activePanes: 1,
            gracePanes: 1,
            hotPanes: 1,
            coldPanes: 1,
            replayBytes: 30,
            checkpointBytes: 20,
            retainedBytes: 50,
            evictions: 2,
            evictionsByReason: {
              replay_byte_limit: 1,
              replay_ttl: 0,
              hot_limit: 1,
              hot_ttl: 0,
              retention_limit_checkpoint: 0,
              retention_limit_replay: 0,
              epoch_changed: 0,
            },
            replayHits: 3,
            replayMisses: 1,
            rebases: 1,
          },
          limits: {
            maxActivePanes: 32,
            maxHotPanes: 8,
            routeGraceMs: 2_000,
            hotTtlMs: 60_000,
            replayTtlMs: 15_000,
            maxReplayBytesPerPane: 100,
            maxCheckpointBytesPerPane: 50,
            maxRetentionBytes: 1_000,
          },
        },
      ],
      [
        {
          attachedRuntimes: 1,
          screenJobs: 1,
          gatedPanes: 1,
          pendingPaneGaps: 2,
          pendingPaneGapLimit: 256,
          streamGapPending: false,
          inputDedupIds: 1,
          inputDedupLimit: 1_024,
          paneDataDeliveries: 10,
          paneDataBytes: 100,
          paneDataDrops: 2,
          paneDataDropBytes: 20,
          pendingPaneGapOverflows: 1,
          paneGapsSent: 3,
          paneGapsByReason: { pane_gap: 3, epoch_changed: 0, cache_evicted: 0 },
          streamGapsSent: 1,
          screenTransactionsStarted: 4,
          screenTransactionsCompleted: 2,
          screenTransactionsFailed: 1,
          screenTransactionsCancelled: 1,
        },
      ]
    );

    expect(canonical).toMatchObject({
      runtimes: 1,
      sessions: 1,
      runtimeAttachments: 1,
      activePanes: 1,
      activePanesLimit: 32,
      hotPanes: 1,
      hotPanesLimit: 8,
      replayBytes: 30,
      replayBytesLimit: 400,
      checkpointBytes: 20,
      checkpointBytesLimit: 200,
      retainedBytes: 50,
      retainedBytesLimit: 1_000,
      replayHitsTotal: 3,
      replayMissesTotal: 1,
      evictionsByReason: { replay_byte_limit: 1, hot_limit: 1 },
      pendingPaneGaps: 2,
      pendingPaneGapsLimit: 256,
      pendingPaneGapOverflowsTotal: 1,
      paneDataDropsTotal: 2,
      paneDataDropBytesTotal: 20,
    });
    expect(JSON.stringify(canonical)).not.toContain('device');
    expect(JSON.stringify(canonical)).not.toContain('paneId');
  });
});
