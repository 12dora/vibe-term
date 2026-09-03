import { describe, expect, test } from 'bun:test';

import { RetentionKernel } from './kernel';
import { PaneReplayStore } from './replay-store';
import { clearSkippedPaneOutput, markSkippedPaneOutput } from './skipped-output';
import type { ConsumerState, PaneDataSegment, PaneSubscriptionRequest } from './types';

const EPOCH_A = new Uint8Array(16).fill(0x11);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('pane replay store', () => {
  test('builds seq-ordered segments from the cursor and reports a gap when the cursor is past latest', () => {
    const kernel = new RetentionKernel({ scheduleTimers: false });
    const replay = new PaneReplayStore(kernel);
    const state = replay.createPane('%1', EPOCH_A, true);
    state.mode = 'active';
    kernel.panes.set('%1', state);
    replay.append(state, encoder.encode('ab'), 0);
    replay.append(state, encoder.encode('cd'), 0);

    const hit = replay.buildReplayPlan({
      paneId: '%1',
      paneEpoch: EPOCH_A,
      cursor: { paneEpoch: EPOCH_A, terminalSeq: 2n },
    });
    expect(hit.needsScreen).toBe(false);
    expect(hit.segments.map((segment) => decoder.decode(segment.data))).toEqual(['cd']);
    expect(hit.segments[0]?.seqStart).toBe(2n);
    expect(hit.segments[0]?.seqEnd).toBe(4n);

    const miss = replay.buildReplayPlan({
      paneId: '%1',
      paneEpoch: EPOCH_A,
      cursor: { paneEpoch: EPOCH_A, terminalSeq: 9n },
    });
    expect(miss.needsScreen).toBe(true);
    expect(miss.gap?.reason).toBe('pane_gap');
    expect(miss.gap?.availableSeq).toBe(4n);
  });

  test('readHistory covers exact start, mid-chunk, past end, and evicted range', () => {
    const kernel = new RetentionKernel({ scheduleTimers: false });
    const replay = new PaneReplayStore(kernel);
    const state = replay.createPane('%1', EPOCH_A, true);
    state.mode = 'active';
    kernel.panes.set('%1', state);
    replay.append(state, encoder.encode('ab'), 0);
    replay.append(state, encoder.encode('cd'), 0);

    const exactStart = replay.readHistory('%1', { paneEpoch: EPOCH_A, terminalSeq: 0n }, 64);
    expect(exactStart?.gap).toBeNull();
    expect(decoder.decode(exactStart?.data ?? new Uint8Array())).toBe('');
    expect(exactStart?.seqStart).toBe(0n);
    expect(exactStart?.seqEnd).toBe(0n);
    expect(exactStart?.nextCursor).toBeNull();

    const midChunk = replay.readHistory('%1', { paneEpoch: EPOCH_A, terminalSeq: 3n }, 64);
    expect(decoder.decode(midChunk?.data ?? new Uint8Array())).toBe('abc');
    expect(midChunk?.seqStart).toBe(0n);
    expect(midChunk?.seqEnd).toBe(3n);
    expect(midChunk?.nextCursor).toBeNull();

    const pastEnd = replay.readHistory('%1', { paneEpoch: EPOCH_A, terminalSeq: 9n }, 64);
    expect(pastEnd?.gap?.reason).toBe('pane_gap');
    expect(pastEnd?.seqStart).toBe(4n);
    expect(pastEnd?.seqEnd).toBe(4n);
    expect(pastEnd?.nextCursor).toBeNull();

    const dropped = state.replay.shift();
    if (dropped) state.replayBytes -= dropped.data.byteLength;
    const evicted = replay.readHistory('%1', { paneEpoch: EPOCH_A, terminalSeq: 1n }, 64);
    expect(evicted?.gap?.reason).toBe('cache_evicted');
    expect(evicted?.seqStart).toBe(4n);
    expect(evicted?.seqEnd).toBe(4n);
  });

  test('fanout isolates a throwing consumer without per-consumer callback wrappers', () => {
    const kernel = new RetentionKernel({ scheduleTimers: false });
    const replay = new PaneReplayStore(kernel);
    const state = replay.createPane('%1', EPOCH_A, true);
    state.mode = 'active';
    kernel.panes.set('%1', state);
    const request: PaneSubscriptionRequest = { paneId: '%1', paneEpoch: EPOCH_A, cursor: null };
    const deliveries: number[] = [];
    const consumer = (id: number, onData: (segment: PaneDataSegment) => void): ConsumerState => ({
      id,
      callbacks: { onData },
      generation: 1n,
      fingerprint: null,
      active: new Map([['%1', request]]),
      hot: new Map(),
      closed: false,
    });
    kernel.consumers.set(
      1,
      consumer(1, () => {
        throw new Error('consumer failed');
      })
    );
    kernel.consumers.set(
      2,
      consumer(2, () => {
        deliveries.push(2);
      })
    );
    const segment = replay.append(state, encoder.encode('data'), 0);
    if (!segment) throw new Error('expected retained segment');
    const originalError = console.error;
    console.error = () => {};
    try {
      replay.fanout(state, segment);
    } finally {
      console.error = originalError;
    }
    expect(deliveries).toEqual([2]);
  });

  test('unmaterialized cold output forces a stale cursor to request a screen', () => {
    const kernel = new RetentionKernel({ scheduleTimers: false });
    const replay = new PaneReplayStore(kernel);
    const state = replay.createPane('%1', EPOCH_A, true);
    kernel.panes.set('%1', state);
    markSkippedPaneOutput('device-a', '%1', EPOCH_A);
    try {
      const plan = replay.buildReplayPlan({
        paneId: '%1',
        paneEpoch: EPOCH_A,
        cursor: { paneEpoch: EPOCH_A, terminalSeq: 0n },
      });
      expect(plan.needsScreen).toBe(true);
      expect(plan.gap?.reason).toBe('cache_evicted');
    } finally {
      clearSkippedPaneOutput('device-a', '%1');
    }
  });
});
