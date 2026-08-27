import { describe, expect, test } from 'bun:test';

import { RetentionKernel } from './kernel';
import { PaneReplayStore } from './replay-store';

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
});
