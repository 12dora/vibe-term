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
});
