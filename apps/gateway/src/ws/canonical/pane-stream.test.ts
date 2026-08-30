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

function createStream(
  sendEvent: (event: wsBorsh.CanonicalEvent) => CanonicalSendResult,
  maxFrameBytes = wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES
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
  });
  return { stream, pending, sizer };
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
