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

  test('cold ingest does not copy payload or fan out, while retained panes keep segments', () => {
    const retention = new PaneRetention({ scheduleTimers: false });
    retention.reconcilePanes([
      { paneId: '%1', paneEpoch: EPOCH_A },
      { paneId: '%2', paneEpoch: EPOCH_B },
    ]);
    const received: string[] = [];
    const lease = retention.attachConsumer({
      onData: (segment) => received.push(`${segment.paneId}:${decoder.decode(segment.data)}`),
    });
    lease.applySubscriptions(1n, [request('%2', EPOCH_B)], []);

    const coldPayload = encoder.encode('discarded');
    const coldResult = retention.ingest('%1', EPOCH_A, coldPayload);
    coldPayload.fill(0x23);
    expect(coldResult).toBeNull();
    expect(received).toEqual([]);
    expect(retention.getLatestCursor('%1')?.terminalSeq).toBe(9n);

    const livePayload = encoder.encode('abc');
    const live = retention.ingest('%2', EPOCH_B, livePayload);
    livePayload.fill(0);
    expect(decoder.decode(live?.data ?? new Uint8Array())).toBe('abc');
    expect(received).toEqual(['%2:abc']);
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

  test('replays accepted panes in active-then-hot insertion order with seq-ordered segments', () => {
    const retention = new PaneRetention({ scheduleTimers: false });
    retention.reconcilePanes([
      { paneId: '%1', paneEpoch: EPOCH_A },
      { paneId: '%2', paneEpoch: EPOCH_B },
      { paneId: '%3', paneEpoch: EPOCH_A },
    ]);
    const lease = retention.attachConsumer({ onData: () => {} });
    lease.applySubscriptions(
      1n,
      [request('%1', EPOCH_A), request('%3', EPOCH_A)],
      [request('%2', EPOCH_B), request('%1', EPOCH_A)]
    );
    retention.ingest('%1', EPOCH_A, encoder.encode('ab'));
    retention.ingest('%1', EPOCH_A, encoder.encode('cd'));
    retention.ingest('%2', EPOCH_B, encoder.encode('two'));
    retention.ingest('%3', EPOCH_A, encoder.encode('three'));

    const result = lease.applySubscriptions(
      2n,
      [request('%1', EPOCH_A, 0n), request('%3', EPOCH_A, 0n)],
      [request('%2', EPOCH_B, 0n)]
    );
    expect(result.hotPanes.map((pane) => pane.paneId)).toEqual(['%2']);
    expect(result.replay.map((plan) => plan.paneId)).toEqual(['%1', '%3', '%2']);
    expect(result.replay[0]?.segments.map((segment) => decoder.decode(segment.data))).toEqual([
      'ab',
      'cd',
    ]);
    expect(result.replay[0]?.segments.map((segment) => [segment.seqStart, segment.seqEnd])).toEqual(
      [
        [0n, 2n],
        [2n, 4n],
      ]
    );
    expect(decoder.decode(result.replay[1]?.segments[0]?.data ?? new Uint8Array())).toBe('three');
    expect(decoder.decode(result.replay[2]?.segments[0]?.data ?? new Uint8Array())).toBe('two');
  });

  test('evicts the least-recently-touched implicit hot pane when over maxHotPanes', () => {
    let now = 0;
    const retention = new PaneRetention({
      maxHotPanes: 2,
      now: () => now,
      scheduleTimers: false,
      routeGraceMs: 1,
      replayTtlMs: 120_000,
    });
    retention.reconcilePanes([
      { paneId: '%1', paneEpoch: EPOCH_A },
      { paneId: '%2', paneEpoch: EPOCH_B },
      { paneId: '%3', paneEpoch: EPOCH_A },
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
    retention.ingest('%2', EPOCH_B, encoder.encode('two'));
    second.close();
    now = 3;
    retention.sweep();

    now = 4;
    const third = retention.attachConsumer({ onData: () => {} });
    third.applySubscriptions(1n, [request('%3', EPOCH_A)], []);
    retention.ingest('%3', EPOCH_A, encoder.encode('three'));
    third.close();
    now = 5;
    retention.sweep();

    const stats = retention.snapshotStats();
    expect(stats.hotPanes).toBe(2);
    expect(stats.coldPanes).toBe(1);
    expect(stats.evictionsByReason.hot_limit).toBe(1);
    expect(retention.readReplay('%1', { paneEpoch: EPOCH_A, terminalSeq: 0n })?.gap?.reason).toBe(
      'cache_evicted'
    );
    expect(retention.readReplay('%2', { paneEpoch: EPOCH_B, terminalSeq: 0n })?.needsScreen).toBe(
      false
    );
    expect(retention.readReplay('%3', { paneEpoch: EPOCH_A, terminalSeq: 0n })?.needsScreen).toBe(
      false
    );
  });

  test('drops checkpoints before trimming live replay when over the retention byte limit', () => {
    const retention = new PaneRetention({
      scheduleTimers: false,
      maxRetentionBytes: 8,
      maxCheckpointBytesPerPane: 16,
      maxReplayBytesPerPane: 16,
    });
    retention.reconcilePanes([{ paneId: '%1', paneEpoch: EPOCH_A }]);
    const lease = retention.attachConsumer({ onData: () => {} });
    lease.applySubscriptions(1n, [request('%1', EPOCH_A)], []);
    retention.ingest('%1', EPOCH_A, encoder.encode('1234'));
    expect(
      retention.storeScreenCheckpoint({
        paneId: '%1',
        paneEpoch: EPOCH_A,
        baseSeq: 4n,
        rows: 1,
        cols: 4,
        modes: 0,
        data: encoder.encode('12345678'),
        historyCursor: null,
        capturedAt: 0,
      })
    ).toBe(false);
    expect(retention.getScreenCheckpoint('%1')).toBeNull();
    expect(retention.snapshotStats()).toMatchObject({
      replayBytes: 4,
      checkpointBytes: 0,
      evictionsByReason: expect.objectContaining({ retention_limit_checkpoint: 1 }),
    });
    expect(retention.readReplay('%1', { paneEpoch: EPOCH_A, terminalSeq: 0n })?.needsScreen).toBe(
      false
    );
  });

  test('scheduled grace timer promotes to hot and dispose cancels it', async () => {
    let now = 0;
    const retention = new PaneRetention({
      now: () => now,
      scheduleTimers: true,
      routeGraceMs: 20,
      hotTtlMs: 60_000,
      replayTtlMs: 120_000,
    });
    retention.reconcilePanes([{ paneId: '%1', paneEpoch: EPOCH_A }]);
    const lease = retention.attachConsumer({ onData: () => {} });
    lease.applySubscriptions(1n, [request('%1', EPOCH_A)], []);
    retention.ingest('%1', EPOCH_A, encoder.encode('hello'));
    lease.close();
    expect(retention.snapshotStats().gracePanes).toBe(1);

    now = 20;
    await Bun.sleep(40);
    expect(retention.snapshotStats().hotPanes).toBe(1);
    expect(retention.readReplay('%1', { paneEpoch: EPOCH_A, terminalSeq: 0n })?.needsScreen).toBe(
      false
    );

    retention.dispose();
    now = 80_000;
    await Bun.sleep(40);
    expect(retention.snapshotStats()).toMatchObject({
      knownPanes: 0,
      hotPanes: 0,
      retainedBytes: 0,
    });
  });
});
