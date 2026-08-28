import { describe, expect, test } from 'bun:test';

import { PaneRetention } from '../pane-retention';
import { RetentionKernel } from './kernel';
import { RetentionPolicyScheduler } from './policy-scheduler';
import { PaneReplayStore } from './replay-store';
import type { PaneRetentionMode, PaneScreenCheckpoint, PaneState } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function epoch(fill: number): Uint8Array {
  return new Uint8Array(16).fill(fill);
}

function concatReplay(state: PaneState): string {
  const total = state.replay.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of state.replay) {
    data.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }
  return decoder.decode(data);
}

function checkpointFor(state: PaneState, data: string, capturedAt: number): PaneScreenCheckpoint {
  return {
    paneId: state.paneId,
    paneEpoch: state.paneEpoch,
    baseSeq: state.latestSeq,
    rows: 1,
    cols: data.length,
    modes: 0,
    data: encoder.encode(data),
    historyCursor: null,
    capturedAt,
  };
}

function createHarness(options: ConstructorParameters<typeof RetentionKernel>[0] = {}) {
  let now = 0;
  const kernel = new RetentionKernel({
    scheduleTimers: false,
    now: () => now,
    ...options,
  });
  const replay = new PaneReplayStore(kernel);
  const policy = new RetentionPolicyScheduler(kernel);
  return {
    kernel,
    replay,
    policy,
    now: () => now,
    setNow: (value: number) => {
      now = value;
    },
    pane: (paneId: string, fill: number, known = true): PaneState => {
      const state = replay.createPane(paneId, epoch(fill), known);
      kernel.panes.set(paneId, state);
      return state;
    },
    setMode: (state: PaneState, mode: PaneRetentionMode, explicitHot = false): void => {
      state.mode = mode;
      state.explicitHot = explicitHot;
      if (mode !== 'grace') state.graceUntil = null;
      if (mode !== 'hot' || explicitHot) state.hotUntil = null;
      kernel.syncHotIndex(state);
    },
    append: (state: PaneState, text: string): void => {
      replay.append(state, encoder.encode(text), now);
    },
    flush: (): void => {
      policy.enforceBounds(now);
    },
    ingest: (state: PaneState, text: string): void => {
      replay.append(state, encoder.encode(text), now);
      policy.trimPaneReplay(state, now);
      policy.enforceBounds(now);
    },
  };
}

describe('retention eviction order characterization', () => {
  test('hot_limit keeps the most recently touched implicit hots and evicts LRU', () => {
    const h = createHarness({ maxHotPanes: 2, replayTtlMs: 120_000 });
    const a = h.pane('%a', 1);
    const b = h.pane('%b', 2);
    const c = h.pane('%c', 3);
    h.setMode(a, 'hot');
    h.setMode(b, 'hot');
    h.setMode(c, 'hot');
    a.lastTouchedAt = 10;
    b.lastTouchedAt = 30;
    c.lastTouchedAt = 20;
    h.append(a, 'aaa');
    h.append(b, 'bbb');
    h.append(c, 'ccc');
    h.flush();

    expect(a.mode).toBe('cold');
    expect(b.mode).toBe('hot');
    expect(c.mode).toBe('hot');
    expect(concatReplay(a)).toBe('');
    expect(concatReplay(b)).toBe('bbb');
    expect(concatReplay(c)).toBe('ccc');
    expect(h.kernel.evictionsByReason.hot_limit).toBe(1);
  });

  test('hot_limit ties on lastTouchedAt keep earlier-inserted panes', () => {
    const h = createHarness({ maxHotPanes: 2, replayTtlMs: 120_000 });
    const a = h.pane('%a', 1);
    const b = h.pane('%b', 2);
    const c = h.pane('%c', 3);
    for (const state of [a, b, c]) {
      h.setMode(state, 'hot');
      state.lastTouchedAt = 5;
    }
    h.append(a, 'a');
    h.append(b, 'b');
    h.append(c, 'c');
    h.flush();

    expect(a.mode).toBe('hot');
    expect(b.mode).toBe('hot');
    expect(c.mode).toBe('cold');
    expect(concatReplay(c)).toBe('');
    expect(h.kernel.evictionsByReason.hot_limit).toBe(1);
  });

  test('hot_limit never evicts explicit hot panes even if they are LRU', () => {
    const h = createHarness({ maxHotPanes: 1, replayTtlMs: 120_000 });
    const explicit = h.pane('%explicit', 1);
    const implicit = h.pane('%implicit', 2);
    h.setMode(explicit, 'hot', true);
    h.setMode(implicit, 'hot');
    explicit.lastTouchedAt = 1;
    implicit.lastTouchedAt = 9;
    h.append(explicit, 'keep');
    h.append(implicit, 'drop');
    h.flush();

    expect(explicit.mode).toBe('hot');
    expect(explicit.explicitHot).toBe(true);
    expect(concatReplay(explicit)).toBe('keep');
    expect(implicit.mode).toBe('cold');
    expect(concatReplay(implicit)).toBe('');
    expect(h.kernel.evictionsByReason.hot_limit).toBe(1);
  });

  test('retention_limit makeColds implicit hots LRU-first before touching others', () => {
    const h = createHarness({
      maxHotPanes: 8,
      maxRetentionBytes: 8,
      maxReplayBytesPerPane: 64,
      replayTtlMs: 120_000,
    });
    const olderHot = h.pane('%older', 1);
    const newerHot = h.pane('%newer', 2);
    const active = h.pane('%active', 3);
    h.setMode(olderHot, 'hot');
    h.setMode(newerHot, 'hot');
    h.setMode(active, 'active');
    olderHot.lastTouchedAt = 1;
    newerHot.lastTouchedAt = 2;
    active.lastTouchedAt = 0;
    h.append(olderHot, 'aaa');
    h.append(newerHot, 'bbb');
    h.append(active, 'ccc');
    h.flush();

    expect(olderHot.mode).toBe('cold');
    expect(concatReplay(olderHot)).toBe('');
    expect(newerHot.mode).toBe('hot');
    expect(concatReplay(newerHot)).toBe('bbb');
    expect(active.mode).toBe('active');
    expect(concatReplay(active)).toBe('ccc');
    expect(h.kernel.evictionsByReason.retention_limit_replay).toBe(1);
  });

  test('retention_limit drops checkpoints before trimming remaining live replay', () => {
    const h = createHarness({
      maxHotPanes: 8,
      maxRetentionBytes: 6,
      maxReplayBytesPerPane: 64,
      maxCheckpointBytesPerPane: 64,
      replayTtlMs: 120_000,
    });
    const hot = h.pane('%hot', 1);
    const active = h.pane('%active', 2);
    h.setMode(hot, 'hot');
    h.setMode(active, 'active');
    hot.lastTouchedAt = 1;
    active.lastTouchedAt = 2;
    h.append(hot, 'wwww');
    h.append(active, 'xxxx');
    expect(h.replay.storeScreenCheckpoint(checkpointFor(active, 'YYYY', 0))).toBe(true);
    h.flush();

    expect(hot.mode).toBe('cold');
    expect(concatReplay(hot)).toBe('');
    expect(active.checkpoint).toBeNull();
    expect(concatReplay(active)).toBe('xxxx');
    expect(h.kernel.evictionsByReason.retention_limit_replay).toBe(1);
    expect(h.kernel.evictionsByReason.retention_limit_checkpoint).toBe(1);
  });

  test('retention_limit drops checkpoints by protection rank then LRU', () => {
    const h = createHarness({
      maxHotPanes: 8,
      maxRetentionBytes: 8,
      maxReplayBytesPerPane: 64,
      maxCheckpointBytesPerPane: 64,
      replayTtlMs: 120_000,
    });
    const grace = h.pane('%grace', 1);
    const explicit = h.pane('%explicit', 2);
    const active = h.pane('%active', 3);
    h.setMode(grace, 'grace');
    h.setMode(explicit, 'hot', true);
    h.setMode(active, 'active');
    grace.lastTouchedAt = 5;
    explicit.lastTouchedAt = 5;
    active.lastTouchedAt = 5;
    h.append(grace, 'g');
    h.append(explicit, 'e');
    h.append(active, 'a');
    expect(h.replay.storeScreenCheckpoint(checkpointFor(grace, 'GGGG', 0))).toBe(true);
    expect(h.replay.storeScreenCheckpoint(checkpointFor(explicit, 'EEEE', 0))).toBe(true);
    expect(h.replay.storeScreenCheckpoint(checkpointFor(active, 'AAAA', 0))).toBe(true);
    h.flush();

    expect(grace.checkpoint).toBeNull();
    expect(explicit.checkpoint).toBeNull();
    expect(active.checkpoint).not.toBeNull();
    expect(concatReplay(grace)).toBe('g');
    expect(concatReplay(explicit)).toBe('e');
    expect(concatReplay(active)).toBe('a');
    expect(h.kernel.evictionsByReason.retention_limit_checkpoint).toBe(2);
  });

  test('retention_limit trims the globally oldest replay chunk and reselects after each eviction', () => {
    const h = createHarness({
      maxHotPanes: 8,
      maxRetentionBytes: 6,
      maxReplayBytesPerPane: 64,
      replayTtlMs: 120_000,
    });
    const a = h.pane('%a', 1);
    const b = h.pane('%b', 2);
    const c = h.pane('%c', 3);
    for (const state of [a, b, c]) h.setMode(state, 'active');
    a.lastTouchedAt = 9;
    b.lastTouchedAt = 8;
    c.lastTouchedAt = 7;

    h.setNow(1);
    h.append(a, 'aa');
    h.setNow(2);
    h.append(b, 'bb');
    h.setNow(3);
    h.append(c, 'cc');
    h.setNow(4);
    h.append(a, 'AA');
    h.flush();

    expect(concatReplay(a)).toBe('AA');
    expect(concatReplay(b)).toBe('bb');
    expect(concatReplay(c)).toBe('cc');
    expect(h.kernel.evictionsByReason.retention_limit_replay).toBe(1);
  });

  test('retention_limit chunk ties at the same receivedAt follow rank then LRU then insert order', () => {
    const h = createHarness({
      maxHotPanes: 8,
      maxRetentionBytes: 2,
      maxReplayBytesPerPane: 64,
      replayTtlMs: 120_000,
    });
    const graceEarly = h.pane('%grace-early', 1);
    const graceLate = h.pane('%grace-late', 2);
    const explicit = h.pane('%explicit', 3);
    h.setMode(graceEarly, 'grace');
    h.setMode(graceLate, 'grace');
    h.setMode(explicit, 'hot', true);
    graceEarly.lastTouchedAt = 1;
    graceLate.lastTouchedAt = 2;
    explicit.lastTouchedAt = 0;

    h.append(graceEarly, 'aa');
    h.append(graceLate, 'bb');
    h.append(explicit, 'cc');
    h.flush();

    expect(concatReplay(graceEarly)).toBe('');
    expect(concatReplay(graceLate)).toBe('');
    expect(concatReplay(explicit)).toBe('cc');
    expect(h.kernel.evictionsByReason.retention_limit_replay).toBe(2);
  });

  test('per-pane replay byte limit evicts that pane oldest-first without touching peers', () => {
    const h = createHarness({
      maxReplayBytesPerPane: 4,
      maxRetentionBytes: 64,
      replayTtlMs: 120_000,
    });
    const a = h.pane('%a', 1);
    const b = h.pane('%b', 2);
    h.setMode(a, 'active');
    h.setMode(b, 'active');
    h.ingest(a, 'wwww');
    h.ingest(b, 'xxxx');
    h.ingest(a, 'YY');

    expect(concatReplay(a)).toBe('YY');
    expect(concatReplay(b)).toBe('xxxx');
    expect(h.kernel.evictionsByReason.replay_byte_limit).toBe(1);
  });

  test('per-pane replay TTL evicts expired chunks of the current pane in ingest order', () => {
    const h = createHarness({
      maxReplayBytesPerPane: 64,
      maxRetentionBytes: 64,
      replayTtlMs: 10,
    });
    const a = h.pane('%a', 1);
    const b = h.pane('%b', 2);
    h.setMode(a, 'active');
    h.setMode(b, 'active');
    h.setNow(0);
    h.ingest(a, 'old');
    h.ingest(b, 'keep');
    h.setNow(11);
    h.ingest(a, 'new');

    expect(concatReplay(a)).toBe('new');
    expect(concatReplay(b)).toBe('keep');
    expect(h.kernel.evictionsByReason.replay_ttl).toBe(1);
  });
});

describe('pane retention ingest/subscribe eviction sequences', () => {
  test('subscribe-close-sweep evicts implicit hots in LRU lastTouched order', () => {
    let now = 0;
    const epochA = epoch(0x11);
    const epochB = epoch(0x22);
    const epochC = epoch(0x33);
    const retention = new PaneRetention({
      maxHotPanes: 2,
      now: () => now,
      scheduleTimers: false,
      routeGraceMs: 1,
      replayTtlMs: 120_000,
    });
    retention.reconcilePanes([
      { paneId: '%1', paneEpoch: epochA },
      { paneId: '%2', paneEpoch: epochB },
      { paneId: '%3', paneEpoch: epochC },
    ]);

    const first = retention.attachConsumer({ onData: () => {} });
    first.applySubscriptions(1n, [{ paneId: '%1', paneEpoch: epochA, cursor: null }], []);
    retention.ingest('%1', epochA, encoder.encode('one'));
    first.close();
    now = 1;
    retention.sweep();

    now = 2;
    const second = retention.attachConsumer({ onData: () => {} });
    second.applySubscriptions(1n, [{ paneId: '%2', paneEpoch: epochB, cursor: null }], []);
    retention.ingest('%2', epochB, encoder.encode('two'));
    second.close();
    now = 3;
    retention.sweep();

    now = 4;
    const third = retention.attachConsumer({ onData: () => {} });
    third.applySubscriptions(1n, [{ paneId: '%3', paneEpoch: epochC, cursor: null }], []);
    retention.ingest('%3', epochC, encoder.encode('three'));
    third.close();
    now = 5;
    retention.sweep();

    expect(retention.isPaneRetained('%1')).toBe(false);
    expect(retention.isPaneRetained('%2')).toBe(true);
    expect(retention.isPaneRetained('%3')).toBe(true);
    expect(retention.snapshotStats().evictionsByReason.hot_limit).toBe(1);
    expect(retention.readReplay('%1', { paneEpoch: epochA, terminalSeq: 0n })?.gap?.reason).toBe(
      'cache_evicted'
    );
  });

  test('ingest sequence over the global byte cap makeColds implicit hot before active replay', () => {
    let now = 0;
    const epochA = epoch(0x11);
    const epochB = epoch(0x22);
    const retention = new PaneRetention({
      maxHotPanes: 8,
      maxActivePanes: 8,
      maxRetentionBytes: 8,
      maxReplayBytesPerPane: 64,
      now: () => now,
      scheduleTimers: false,
      routeGraceMs: 1,
      replayTtlMs: 120_000,
    });
    retention.reconcilePanes([
      { paneId: '%hot', paneEpoch: epochA },
      { paneId: '%active', paneEpoch: epochB },
    ]);
    const lease = retention.attachConsumer({ onData: () => {} });
    lease.applySubscriptions(1n, [{ paneId: '%hot', paneEpoch: epochA, cursor: null }], []);
    retention.ingest('%hot', epochA, encoder.encode('HOTT'));
    lease.close();
    now = 1;
    retention.sweep();

    now = 2;
    const activeLease = retention.attachConsumer({ onData: () => {} });
    activeLease.applySubscriptions(
      1n,
      [{ paneId: '%active', paneEpoch: epochB, cursor: null }],
      []
    );
    retention.ingest('%active', epochB, encoder.encode('ACTVDATA'));

    expect(retention.isPaneRetained('%hot')).toBe(false);
    expect(retention.isPaneRetained('%active')).toBe(true);
    expect(
      decoder.decode(retention.readHistory('%active', null, 64)?.data ?? new Uint8Array())
    ).toBe('ACTVDATA');
    expect(retention.snapshotStats().evictionsByReason.retention_limit_replay).toBe(1);
  });
});
