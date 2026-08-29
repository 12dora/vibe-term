import { describe, expect, test } from 'bun:test';

import { RetentionKernel } from './kernel';
import { PaneReplayStore } from './replay-store';
import type { PaneState, PaneTerminalCursor } from './types';

const EPOCH_A = new Uint8Array(16).fill(0x11);
const EPOCH_B = new Uint8Array(16).fill(0x22);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function activePane(maxReplayBytesPerPane = 1_000_000): {
  kernel: RetentionKernel;
  replay: PaneReplayStore;
  state: PaneState;
  setNow: (value: number) => void;
} {
  let now = 1;
  const kernel = new RetentionKernel({
    scheduleTimers: false,
    now: () => now,
    maxReplayBytesPerPane,
  });
  const replay = new PaneReplayStore(kernel);
  const state = replay.createPane('%1', EPOCH_A, true);
  state.mode = 'active';
  kernel.panes.set('%1', state);
  return {
    kernel,
    replay,
    state,
    setNow(value: number) {
      now = value;
    },
  };
}

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
});

describe('readHistory cursor bounds', () => {
  test('returns null for missing or unknown panes', () => {
    const { replay, state } = activePane();
    expect(replay.readHistory('%missing', null, 16)).toBeNull();
    state.known = false;
    expect(replay.readHistory('%1', null, 16)).toBeNull();
  });

  test.each([
    {
      name: 'epoch mismatch is pane_gap-independent and reports the requested seq',
      cursor: { paneEpoch: EPOCH_B, terminalSeq: 2n } satisfies PaneTerminalCursor,
      byteLimit: 16,
      gap: 'epoch_changed' as const,
      expectedSeq: 2n,
    },
    {
      name: 'beforeSeq > latestSeq is pane_gap (not >=)',
      cursor: { paneEpoch: EPOCH_A, terminalSeq: 5n } satisfies PaneTerminalCursor,
      byteLimit: 16,
      gap: 'pane_gap' as const,
      expectedSeq: 5n,
    },
    {
      name: 'beforeSeq < oldestSeq is cache_evicted (not <=)',
      cursor: { paneEpoch: EPOCH_A, terminalSeq: 1n } satisfies PaneTerminalCursor,
      byteLimit: 16,
      gap: 'cache_evicted' as const,
      expectedSeq: 1n,
      dropFirstChunk: true,
    },
  ])('$name', ({ cursor, byteLimit, gap, expectedSeq, dropFirstChunk }) => {
    const { replay, state } = activePane();
    replay.append(state, encoder.encode('ab'), 0);
    replay.append(state, encoder.encode('cd'), 0);
    if (dropFirstChunk) {
      const removed = state.replay.shift();
      if (removed) state.replayBytes -= removed.data.byteLength;
    }
    const touched = state.lastTouchedAt;
    const page = replay.readHistory('%1', cursor, byteLimit);
    expect(page?.gap?.reason).toBe(gap);
    expect(page?.seqStart).toBe(state.latestSeq);
    expect(page?.seqEnd).toBe(state.latestSeq);
    expect(page?.data.byteLength).toBe(0);
    expect(page?.nextCursor).toBeNull();
    expect(page?.gap?.expectedSeq).toBe(expectedSeq);
    expect(page?.gap?.availableSeq).toBe(state.latestSeq);
    expect(state.lastTouchedAt).toBe(touched);
  });

  test.each([
    {
      name: 'beforeSeq === latestSeq is valid and empty when limit is 0',
      cursor: { paneEpoch: EPOCH_A, terminalSeq: 4n },
      byteLimit: 0,
      text: '',
      seqStart: 4n,
      nextSeq: 4n,
    },
    {
      name: 'null cursor reads from latestSeq',
      cursor: null,
      byteLimit: 100,
      text: 'abcd',
      seqStart: 0n,
      nextSeq: null,
    },
    {
      name: 'beforeSeq === oldestSeq is valid and empty (nothing before oldest)',
      cursor: { paneEpoch: EPOCH_A, terminalSeq: 0n },
      byteLimit: 100,
      text: '',
      seqStart: 0n,
      nextSeq: null,
    },
    {
      name: 'beforeSeq === latestSeq with budget takes bytes strictly before the cursor',
      cursor: { paneEpoch: EPOCH_A, terminalSeq: 4n },
      byteLimit: 100,
      text: 'abcd',
      seqStart: 0n,
      nextSeq: null,
    },
    {
      name: 'partial take from the latest chunk leaves nextCursor when seqStart > oldest',
      cursor: { paneEpoch: EPOCH_A, terminalSeq: 4n },
      byteLimit: 2,
      text: 'cd',
      seqStart: 2n,
      nextSeq: 2n,
    },
    {
      name: 'negative byteLimit clamps to 0',
      cursor: { paneEpoch: EPOCH_A, terminalSeq: 4n },
      byteLimit: -8,
      text: '',
      seqStart: 4n,
      nextSeq: 4n,
    },
  ])('$name', ({ cursor, byteLimit, text, seqStart, nextSeq }) => {
    const { replay, state, setNow } = activePane();
    replay.append(state, encoder.encode('ab'), 0);
    replay.append(state, encoder.encode('cd'), 0);
    setNow(99);
    const page = replay.readHistory('%1', cursor, byteLimit);
    expect(page?.gap).toBeNull();
    expect(decoder.decode(page?.data ?? new Uint8Array())).toBe(text);
    expect(page?.seqStart).toBe(seqStart);
    expect(page?.seqEnd).toBe(cursor?.terminalSeq ?? 4n);
    expect(page?.nextCursor?.terminalSeq ?? null).toBe(nextSeq);
    expect(state.lastTouchedAt).toBe(99);
  });

  test('clamps byteLimit to maxReplayBytesPerPane and splits a straddling chunk at beforeSeq', () => {
    const { replay, state } = activePane(3);
    replay.append(state, encoder.encode('abcdef'), 0);
    const page = replay.readHistory('%1', { paneEpoch: EPOCH_A, terminalSeq: 4n }, 100);
    expect(decoder.decode(page?.data ?? new Uint8Array())).toBe('bcd');
    expect(page?.seqStart).toBe(1n);
    expect(page?.seqEnd).toBe(4n);
    expect(page?.nextCursor?.terminalSeq).toBe(1n);
  });

  test('skips chunks whose seqStart is >= beforeSeq', () => {
    const { replay, state } = activePane();
    replay.append(state, encoder.encode('ab'), 0);
    replay.append(state, encoder.encode('cd'), 0);
    const page = replay.readHistory('%1', { paneEpoch: EPOCH_A, terminalSeq: 2n }, 100);
    expect(decoder.decode(page?.data ?? new Uint8Array())).toBe('ab');
    expect(page?.seqStart).toBe(0n);
    expect(page?.seqEnd).toBe(2n);
    expect(page?.nextCursor).toBeNull();
  });

  test('beforeSeq === oldestSeq after a dropped prefix is valid, not cache_evicted', () => {
    const { replay, state } = activePane();
    replay.append(state, encoder.encode('ab'), 0);
    replay.append(state, encoder.encode('cd'), 0);
    const removed = state.replay.shift();
    if (removed) state.replayBytes -= removed.data.byteLength;
    const page = replay.readHistory('%1', { paneEpoch: EPOCH_A, terminalSeq: 2n }, 100);
    expect(page?.gap).toBeNull();
    expect(page?.data.byteLength).toBe(0);
    expect(page?.seqStart).toBe(2n);
    expect(page?.seqEnd).toBe(2n);
  });
});
