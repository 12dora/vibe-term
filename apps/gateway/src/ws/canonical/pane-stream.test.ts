import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

import { GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS } from '../terminal-output-batcher';
import { CanonicalFrameSizer } from './frame-sizer';
import { CanonicalPaneStream } from './pane-stream';
import { CanonicalTransactionSender } from './transaction-sender';
import type { CanonicalSendResult } from './types';

const SERVER_EPOCH = new Uint8Array(16).fill(0x11);
const PANE_EPOCH = new Uint8Array(16).fill(0x22);
const encoder = new TextEncoder();

class ManualTimer {
  private nextId = 1;
  readonly tasks = new Map<number, { callback: () => void; delayMs: number }>();

  schedule = (callback: () => void, delayMs: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { callback, delayMs });
    return id;
  };

  cancel = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  runAll(): void {
    const tasks = [...this.tasks.entries()];
    for (const [id, task] of tasks) {
      if (!this.tasks.delete(id)) continue;
      task.callback();
    }
  }
}

function createStream(
  sendEvent: (event: wsBorsh.CanonicalEvent) => CanonicalSendResult,
  maxFrameBytes = wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
  extras: { now?: () => number; timer?: ManualTimer } = {}
) {
  const sizer = new CanonicalFrameSizer(maxFrameBytes);
  const sender = new CanonicalTransactionSender({
    sizer,
    sendEvent,
    isClosed: () => false,
    getServerEpoch: () => SERVER_EPOCH,
  });
  const pending: number[] = [];
  const stream = new CanonicalPaneStream({
    sender,
    getServerEpoch: () => SERVER_EPOCH,
    maxPendingPaneGaps: 8,
    onPendingWork: () => pending.push(1),
    now: extras.now,
    scheduleTimer: extras.timer?.schedule,
    cancelTimer: extras.timer?.cancel,
  });
  return { stream, pending, sizer };
}

function paneSegment(
  text: string,
  seqStart: bigint
): {
  paneId: string;
  paneEpoch: Uint8Array;
  seqStart: bigint;
  seqEnd: bigint;
  data: Uint8Array;
} {
  const data = encoder.encode(text);
  return {
    paneId: '%1',
    paneEpoch: PANE_EPOCH,
    seqStart,
    seqEnd: seqStart + BigInt(data.byteLength),
    data,
  };
}

describe('canonical pane stream', () => {
  test('coalesces contiguous seq and flushes before a pane gap', async () => {
    const events: wsBorsh.CanonicalEvent[] = [];
    const { stream } = createStream((event) => {
      events.push(event);
      return true;
    });
    stream.handlePaneData('device-a', {
      paneId: '%1',
      paneEpoch: PANE_EPOCH,
      seqStart: 0n,
      seqEnd: 2n,
      data: encoder.encode('ab'),
    });
    stream.handlePaneData('device-a', {
      paneId: '%1',
      paneEpoch: PANE_EPOCH,
      seqStart: 2n,
      seqEnd: 4n,
      data: encoder.encode('cd'),
    });
    await Bun.sleep(GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS + 4);
    expect(events).toHaveLength(1);
    const batched = events[0];
    if (!batched || !('PaneData' in batched)) throw new Error('expected PaneData');
    expect(new TextDecoder().decode(batched.PaneData.data)).toBe('abcd');

    stream.handlePaneData('device-a', {
      paneId: '%1',
      paneEpoch: PANE_EPOCH,
      seqStart: 4n,
      seqEnd: 6n,
      data: encoder.encode('xy'),
    });
    stream.handlePaneGap('device-a', {
      paneId: '%1',
      paneEpoch: PANE_EPOCH,
      reason: 'epoch_changed',
      expectedPaneEpoch: PANE_EPOCH,
      expectedSeq: 6n,
      availableSeq: 0n,
    });
    expect(events.map((event) => Object.keys(event)[0])).toEqual([
      'PaneData',
      'PaneData',
      'SourceGap',
    ]);
    const flushed = events[1];
    if (!flushed || !('PaneData' in flushed)) throw new Error('expected flushed PaneData');
    expect(new TextDecoder().decode(flushed.PaneData.data)).toBe('xy');
  });

  test('queues a pane gap when SourceGap send backpressures', () => {
    const { stream, pending } = createStream((event) => !('SourceGap' in event));
    stream.handlePaneGap('device-a', {
      paneId: '%1',
      paneEpoch: PANE_EPOCH,
      reason: 'pane_gap',
      expectedPaneEpoch: PANE_EPOCH,
      expectedSeq: 4n,
      availableSeq: 8n,
    });
    expect(stream.snapshotStats().pendingPaneGaps).toBe(1);
    expect(pending.length).toBeGreaterThan(0);
  });

  test('does not queue a pane gap when SourceGap was accepted under backpressure', () => {
    const { stream, pending } = createStream((event) =>
      'SourceGap' in event ? 'backpressured' : true
    );
    stream.handlePaneGap('device-a', {
      paneId: '%1',
      paneEpoch: PANE_EPOCH,
      reason: 'pane_gap',
      expectedPaneEpoch: PANE_EPOCH,
      expectedSeq: 4n,
      availableSeq: 8n,
    });
    expect(stream.snapshotStats().pendingPaneGaps).toBe(0);
    expect(stream.snapshotStats().paneGapsSent).toBe(1);
    expect(pending.length).toBe(0);
  });

  test('chunks PaneData with subarray views and keeps serialized frames after source mutation', () => {
    const frames: Uint8Array[] = [];
    const events: wsBorsh.CanonicalEvent[] = [];
    const { stream, sizer } = createStream((event) => {
      events.push(event);
      frames.push(wsBorsh.encodeCanonicalEventPayload(event).slice());
      return true;
    }, 256);
    const data = new Uint8Array(400);
    for (let index = 0; index < data.byteLength; index += 1) data[index] = index & 0xff;
    const maxData = sizer.maxPaneDataBytes(
      { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
      PANE_EPOCH
    );
    expect(maxData).toBeGreaterThan(0);
    expect(maxData).toBeLessThan(data.byteLength);

    const sent = stream.sendPaneData('device-a', {
      paneId: '%1',
      paneEpoch: PANE_EPOCH,
      seqStart: 0n,
      seqEnd: BigInt(data.byteLength),
      data,
    });
    expect(sent).toBe(true);
    expect(events.length).toBeGreaterThan(1);

    const reconstructed = new Uint8Array(data.byteLength);
    let offset = 0;
    for (const event of events) {
      if (!('PaneData' in event)) throw new Error('expected PaneData');
      expect(event.PaneData.data.buffer).toBe(data.buffer);
      reconstructed.set(event.PaneData.data, offset);
      offset += event.PaneData.data.byteLength;
    }
    expect(offset).toBe(data.byteLength);
    expect(reconstructed).toEqual(data);

    data.fill(0xff);
    for (const [index, event] of events.entries()) {
      const frame = frames[index];
      if (!frame || !('PaneData' in event)) throw new Error('missing frame');
      expect(wsBorsh.encodeCanonicalEventPayload(event)).not.toEqual(frame);
      expect(frame).toEqual(frames[index]);
    }
    const decoded = frames.map((frame) => wsBorsh.decodeCanonicalEventPayload(frame).event);
    const recovered = new Uint8Array(400);
    let recoveredOffset = 0;
    for (const event of decoded) {
      if (!('PaneData' in event)) throw new Error('expected PaneData');
      recovered.set(event.PaneData.data, recoveredOffset);
      recoveredOffset += event.PaneData.data.byteLength;
    }
    const original = new Uint8Array(400);
    for (let index = 0; index < original.byteLength; index += 1) original[index] = index & 0xff;
    expect(recovered).toEqual(original);
  });
});

describe('canonical pane stream leading-edge', () => {
  const DELAY = GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS;
  const decoder = new TextDecoder();

  function createLeadingHarness() {
    let nowMs = 0;
    const events: wsBorsh.CanonicalEvent[] = [];
    const timer = new ManualTimer();
    const { stream } = createStream(
      (event) => {
        events.push(event);
        return true;
      },
      wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      { now: () => nowMs, timer }
    );
    return {
      stream,
      timer,
      events,
      texts: () =>
        events.map((event) => {
          if (!('PaneData' in event)) throw new Error('expected PaneData');
          return decoder.decode(event.PaneData.data);
        }),
      delays: () => [...timer.tasks.values()].map((task) => task.delayMs),
      setNow: (ms: number) => {
        nowMs = ms;
      },
    };
  }

  test('isolated chunk is scheduled with 0 delay and emitted without waiting DELAY_MS', () => {
    const harness = createLeadingHarness();

    harness.stream.handlePaneData('device-a', paneSegment('ab', 0n));
    expect(harness.events).toHaveLength(0);
    expect(harness.delays()).toEqual([0]);

    harness.timer.runAll();
    expect(harness.texts()).toEqual(['ab']);
    expect(harness.timer.tasks.size).toBe(0);
  });

  test('burst of N chunks in one window does not increase flush count', () => {
    const harness = createLeadingHarness();
    const burst = 12;
    let seq = 0n;
    for (let index = 0; index < burst; index += 1) {
      const text = String.fromCharCode(97 + index);
      harness.stream.handlePaneData('device-a', paneSegment(text, seq));
      seq += BigInt(text.length);
    }

    expect(harness.events).toHaveLength(0);
    expect(harness.timer.tasks.size).toBe(1);
    harness.timer.runAll();

    expect(harness.events.length).toBeLessThanOrEqual(2);
    expect(harness.events).toHaveLength(1);
    expect(harness.texts()).toEqual(['abcdefghijkl']);
  });

  test('two chunks separated by more than delay produce two leading-edge emits', () => {
    const harness = createLeadingHarness();

    harness.stream.handlePaneData('device-a', paneSegment('a', 0n));
    expect(harness.delays()).toEqual([0]);
    harness.timer.runAll();

    harness.setNow(DELAY + 1);
    harness.stream.handlePaneData('device-a', paneSegment('b', 1n));
    expect(harness.delays()).toEqual([0]);
    harness.timer.runAll();

    expect(harness.texts()).toEqual(['a', 'b']);
  });

  test('preserves order across the cooldown boundary', () => {
    const harness = createLeadingHarness();

    harness.stream.handlePaneData('device-a', paneSegment('a', 0n));
    harness.stream.handlePaneData('device-a', paneSegment('b', 1n));
    harness.timer.runAll();
    expect(harness.texts()).toEqual(['ab']);

    harness.setNow(5);
    harness.stream.handlePaneData('device-a', paneSegment('c', 2n));
    harness.stream.handlePaneData('device-a', paneSegment('d', 3n));
    expect(harness.delays()).toEqual([DELAY - 5]);
    harness.timer.runAll();

    expect(harness.texts()).toEqual(['ab', 'cd']);
  });
});
