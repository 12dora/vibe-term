import { describe, expect, test } from 'bun:test';

import {
  type PaneDataSegment,
  PaneRetention,
  PaneSubscriptionGenerationConflictError,
  type PaneSubscriptionRequest,
} from './pane-retention';

const EPOCH_A = new Uint8Array(16).fill(0x11);
const EPOCH_B = new Uint8Array(16).fill(0x22);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function request(
  paneId: string,
  paneEpoch: Uint8Array,
  terminalSeq: bigint | null = null
): PaneSubscriptionRequest {
  return {
    paneId,
    paneEpoch,
    cursor: terminalSeq === null ? null : { paneEpoch, terminalSeq },
  };
}

describe('pane retention', () => {
  test('fans one sequenced source to many consumers and enforces the active union cap', () => {
    let now = 0;
    const retention = new PaneRetention({
      maxActivePanes: 1,
      now: () => now,
      scheduleTimers: false,
    });
    retention.reconcilePanes([
      { paneId: '%1', paneEpoch: EPOCH_A },
      { paneId: '%2', paneEpoch: EPOCH_B },
    ]);
    const first: PaneDataSegment[] = [];
    const second: PaneDataSegment[] = [];
    const firstLease = retention.attachConsumer({ onData: (segment) => first.push(segment) });
    const secondLease = retention.attachConsumer({ onData: (segment) => second.push(segment) });

    expect(
      firstLease.applySubscriptions(1n, [request('%1', EPOCH_A)], []).activePanes
    ).toHaveLength(1);
    expect(
      secondLease.applySubscriptions(1n, [request('%1', EPOCH_A)], []).activePanes
    ).toHaveLength(1);
    const rejected = secondLease.applySubscriptions(2n, [request('%2', EPOCH_B)], []);
    expect(rejected.activePanes).toEqual([]);
    expect(rejected.rejected[0]?.reason).toBe('resource_exhausted');

    secondLease.applySubscriptions(3n, [request('%1', EPOCH_A)], []);
    retention.ingest('%1', EPOCH_A, encoder.encode('abc'));
    expect(first.map((segment) => decoder.decode(segment.data))).toEqual(['abc']);
    expect(second.map((segment) => decoder.decode(segment.data))).toEqual(['abc']);
    expect(first[0]?.seqStart).toBe(0n);
    expect(first[0]?.seqEnd).toBe(3n);
    expect(retention.snapshotStats().activePanes).toBe(1);
    now += 1;
  });

  test('counts shared panes once when filling the active union', () => {
    const retention = new PaneRetention({ maxActivePanes: 2, scheduleTimers: false });
    retention.reconcilePanes([
      { paneId: '%1', paneEpoch: EPOCH_A },
      { paneId: '%2', paneEpoch: EPOCH_B },
    ]);
    const first = retention.attachConsumer({ onData: () => {} });
    const second = retention.attachConsumer({ onData: () => {} });
    first.applySubscriptions(1n, [request('%1', EPOCH_A)], []);
    const result = second.applySubscriptions(
      1n,
      [request('%1', EPOCH_A), request('%2', EPOCH_B)],
      []
    );
    expect(result.activePanes.map((pane) => pane.paneId)).toEqual(['%1', '%2']);
    expect(result.rejected).toEqual([]);
  });

  test('cold panes advance cursors without retaining bytes and require a screen rebase', () => {
    const retention = new PaneRetention({ scheduleTimers: false });
    retention.reconcilePanes([{ paneId: '%1', paneEpoch: EPOCH_A }]);
    retention.ingest('%1', EPOCH_A, encoder.encode('discarded'));
    expect(retention.getLatestCursor('%1')?.terminalSeq).toBe(9n);
    expect(retention.snapshotStats().retainedBytes).toBe(0);

    const lease = retention.attachConsumer({ onData: () => {} });
    const result = lease.applySubscriptions(1n, [request('%1', EPOCH_A, 0n)], []);
    expect(result.replay[0]?.gap?.reason).toBe('cache_evicted');
    expect(result.replay[0]?.needsScreen).toBe(true);
  });

  test('keeps exact replay through grace and hot, then evicts it at TTL', () => {
    let now = 0;
    const retention = new PaneRetention({
      now: () => now,
      scheduleTimers: false,
      routeGraceMs: 2_000,
      hotTtlMs: 60_000,
      replayTtlMs: 120_000,
    });
    retention.reconcilePanes([{ paneId: '%1', paneEpoch: EPOCH_A }]);
    const lease = retention.attachConsumer({ onData: () => {} });
    lease.applySubscriptions(1n, [request('%1', EPOCH_A)], []);
    retention.ingest('%1', EPOCH_A, encoder.encode('hello'));
    lease.close();
    expect(retention.snapshotStats().gracePanes).toBe(1);

    now = 2_000;
    retention.sweep();
    expect(retention.snapshotStats().hotPanes).toBe(1);
    const reopened = retention.attachConsumer({ onData: () => {} });
    const hit = reopened.applySubscriptions(1n, [request('%1', EPOCH_A, 0n)], []);
    expect(hit.replay[0]?.needsScreen).toBe(false);
    expect(decoder.decode(hit.replay[0]?.segments[0]?.data)).toBe('hello');
    reopened.close();

    now = 4_000;
    retention.sweep();
    now = 64_000;
    retention.sweep();
    expect(retention.snapshotStats().coldPanes).toBe(1);
    expect(retention.snapshotStats().retainedBytes).toBe(0);
  });

  test('uses LRU for implicit hot panes and reports exact retained bytes', () => {
    let now = 0;
    const retention = new PaneRetention({
      maxHotPanes: 1,
      now: () => now,
      scheduleTimers: false,
      routeGraceMs: 1,
      replayTtlMs: 120_000,
    });
    retention.reconcilePanes([
      { paneId: '%1', paneEpoch: EPOCH_A },
      { paneId: '%2', paneEpoch: EPOCH_B },
    ]);
    const first = retention.attachConsumer({ onData: () => {} });
    first.applySubscriptions(1n, [request('%1', EPOCH_A)], []);
    retention.ingest('%1', EPOCH_A, encoder.encode('one'));
    first.close();
    now = 1;
    retention.sweep();

    now = 2;
    const second = retention.attachConsumer({ onData: () => {} });
    second.applySubscriptions(1n, [request('%2', EPOCH_B)], []);
    retention.ingest('%2', EPOCH_B, encoder.encode('second'));
    second.close();
    now = 3;
    retention.sweep();

    const stats = retention.snapshotStats();
    expect(stats.hotPanes).toBe(1);
    expect(stats.coldPanes).toBe(1);
    expect(stats.retainedBytes).toBe(6);
    expect(stats.evictions).toBe(1);
    expect(stats.evictionsByReason.hot_limit).toBe(1);
    expect(retention.snapshotLimits()).toMatchObject({
      maxHotPanes: 1,
      replayTtlMs: 120_000,
    });
  });

  test('keeps generation replay idempotent and rejects conflicting reuse', () => {
    const retention = new PaneRetention({ scheduleTimers: false });
    retention.reconcilePanes([{ paneId: '%1', paneEpoch: EPOCH_A }]);
    const lease = retention.attachConsumer({ onData: () => {} });
    lease.applySubscriptions(5n, [request('%1', EPOCH_A)], []);
    expect(lease.applySubscriptions(5n, [request('%1', EPOCH_A)], []).generation).toBe(5n);
    expect(lease.applySubscriptions(4n, [], []).generation).toBe(5n);
    expect(() => lease.applySubscriptions(5n, [], [])).toThrow(
      PaneSubscriptionGenerationConflictError
    );
  });

  test('rotating a pane epoch invalidates subscriptions and emits an explicit gap', () => {
    const gaps: string[] = [];
    const retention = new PaneRetention({ scheduleTimers: false });
    retention.reconcilePanes([{ paneId: '%1', paneEpoch: EPOCH_A }]);
    const lease = retention.attachConsumer({
      onData: () => {},
      onGap: (gap) => gaps.push(gap.reason),
    });
    lease.applySubscriptions(1n, [request('%1', EPOCH_A)], []);
    retention.ingest('%1', EPOCH_A, encoder.encode('old'));
    retention.reconcilePanes([{ paneId: '%1', paneEpoch: EPOCH_B }]);
    expect(gaps).toEqual(['epoch_changed']);
    expect(retention.getLatestCursor('%1')?.terminalSeq).toBe(0n);
    expect(retention.snapshotStats().coldPanes).toBe(1);
  });
});
