import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

import { CanonicalFrameSizer } from './frame-sizer';
import { CanonicalTransactionSender } from './transaction-sender';
import type { AttachedDevice, CanonicalEvent } from './types';

const REQUEST_ID = new Uint8Array(16).fill(0x33);
const SERVER_EPOCH = new Uint8Array(16).fill(0x11);

describe('canonical transaction sender', () => {
  test('chunks screen payloads and stops on send backpressure', () => {
    const events: wsBorsh.CanonicalEvent[] = [];
    let remaining = 3;
    const sender = new CanonicalTransactionSender({
      sizer: new CanonicalFrameSizer(256),
      sendEvent: (event) => {
        if (remaining <= 0) return false;
        remaining -= 1;
        events.push(event);
        return true;
      },
      isClosed: () => false,
      getServerEpoch: () => SERVER_EPOCH,
    });
    const data = new Uint8Array(400).fill(0x61);
    const sent = sender.sendScreenTransaction(
      'device-a',
      REQUEST_ID,
      {
        paneId: '%1',
        paneEpoch: new Uint8Array(16).fill(0x22),
        baseSeq: 0n,
        rows: 24,
        cols: 80,
        modes: 0,
        data,
        historyCursor: null,
        capturedAt: 0,
      },
      {
        splitAtBase: () => null,
        sendLive: () => true,
      }
    );
    expect(sent).toBe(false);
    expect(events[0] && 'ScreenBegin' in events[0]).toBe(true);
    expect(events.some((event) => 'ScreenChunk' in event)).toBe(true);
    expect(events.some((event) => 'ScreenCommit' in event)).toBe(false);
  });

  test('fails a screen transaction when commit applies backpressure after live was held', () => {
    let releasedLive = false;
    const sender = new CanonicalTransactionSender({
      sizer: new CanonicalFrameSizer(256),
      sendEvent: (event) => ('ScreenCommit' in event ? 'backpressured' : true),
      isClosed: () => false,
      getServerEpoch: () => SERVER_EPOCH,
    });

    expect(
      sender.sendScreenTransaction(
        'device-a',
        REQUEST_ID,
        {
          paneId: '%1',
          paneEpoch: new Uint8Array(16).fill(0x22),
          baseSeq: 0n,
          rows: 24,
          cols: 80,
          modes: 0,
          data: new Uint8Array(),
          historyCursor: null,
          capturedAt: 0,
        },
        {
          splitAtBase: () => ({
            paneId: '%1',
            paneEpoch: new Uint8Array(16).fill(0x22),
            seqStart: 0n,
            seqEnd: 1n,
            data: new Uint8Array([1]),
          }),
          sendLive: () => {
            releasedLive = true;
            return true;
          },
        }
      )
    ).toBe(false);
    expect(releasedLive).toBe(false);
  });

  test('sendFitted skips the frame-size check but still refuses a closed session', () => {
    const events: wsBorsh.CanonicalEvent[] = [];
    let closed = false;
    const sender = new CanonicalTransactionSender({
      sizer: new CanonicalFrameSizer(64),
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      isClosed: () => closed,
      getServerEpoch: () => SERVER_EPOCH,
    });
    const oversized: wsBorsh.CanonicalEvent = {
      Error: { requestId: REQUEST_ID, code: 1, message: 'x'.repeat(200), retryable: false },
    };
    expect(sender.send(oversized)).toBe(false);
    expect(sender.sendFitted(oversized)).toBe(true);
    closed = true;
    expect(sender.sendFitted(oversized)).toBe(false);
    expect(events).toHaveLength(1);
  });

  test('truncates error messages to 512 bytes on the wire field', () => {
    const events: wsBorsh.CanonicalEvent[] = [];
    const sender = new CanonicalTransactionSender({
      sizer: new CanonicalFrameSizer(wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES),
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      isClosed: () => false,
      getServerEpoch: () => SERVER_EPOCH,
    });
    sender.sendError(REQUEST_ID, wsBorsh.ERROR_INTERNAL_ERROR, 'x'.repeat(600), true);
    const error = events[0];
    if (!error || !('Error' in error)) throw new Error('missing Error');
    expect(error.Error.message).toHaveLength(512);
    expect(error.Error.retryable).toBe(true);
  });

  test('content chunks share the source buffer and serialized frames survive source mutation', () => {
    const frames: Uint8Array[] = [];
    const events: wsBorsh.CanonicalEvent[] = [];
    const sender = new CanonicalTransactionSender({
      sizer: new CanonicalFrameSizer(256),
      sendEvent: (event) => {
        events.push(event);
        frames.push(wsBorsh.encodeCanonicalEventPayload(event).slice());
        return true;
      },
      isClosed: () => false,
      getServerEpoch: () => SERVER_EPOCH,
    });
    const data = new Uint8Array(400);
    for (let index = 0; index < data.byteLength; index += 1) data[index] = (index + 3) & 0xff;
    expect(sender.sendContentChunks('screen', REQUEST_ID, data)).toBe(true);
    expect(events.length).toBeGreaterThan(1);

    const reconstructed = new Uint8Array(data.byteLength);
    let offset = 0;
    for (const event of events) {
      if (!('ScreenChunk' in event)) throw new Error('expected ScreenChunk');
      expect(event.ScreenChunk.data.buffer).toBe(data.buffer);
      reconstructed.set(event.ScreenChunk.data, offset);
      offset += event.ScreenChunk.data.byteLength;
    }
    expect(reconstructed).toEqual(data);

    data.fill(0);
    const recovered = new Uint8Array(400);
    let recoveredOffset = 0;
    for (const frame of frames) {
      const event = wsBorsh.decodeCanonicalEventPayload(frame).event;
      if (!('ScreenChunk' in event)) throw new Error('expected ScreenChunk');
      recovered.set(event.ScreenChunk.data, recoveredOffset);
      recoveredOffset += event.ScreenChunk.data.byteLength;
    }
    const original = new Uint8Array(400);
    for (let index = 0; index < original.byteLength; index += 1)
      original[index] = (index + 3) & 0xff;
    expect(recovered).toEqual(original);
  });

  test('metadata chunk boundaries match the candidate-copy algorithm on varied sizes', () => {
    const sender = createMetadataSender();
    const snapshotId = new Uint8Array(16).fill(0x77);
    const sizes = [1, 8, 40, 200, 12, 90, 3, 400, 16, 64, 7, 250, 30, 1, 180];
    const snapshot = {
      metadataEpoch: new Uint8Array(16).fill(0x44),
      revision: 3n,
      records: sizes.map((size, index) => metadataRecord(`%${index}`, 'x'.repeat(size))),
    };
    const incremental = sender.partitionMetadataRecords(snapshot, snapshotId);
    const oracle = partitionByCandidateCopy(sender, snapshot, snapshotId);
    expect(chunkFingerprints(incremental)).toEqual(chunkFingerprints(oracle));
    expect(incremental).not.toBeNull();
    if (!incremental) return;
    for (const records of incremental) {
      expect(
        sender.sizer.eventFits({
          SourceMetadataSnapshot: {
            metadataEpoch: snapshot.metadataEpoch,
            revision: snapshot.revision,
            snapshotId,
            chunkIndex: 0,
            totalChunks: incremental.length,
            records,
          },
        })
      ).toBe(true);
    }
  });

  test('metadata partition cache is reused until revision changes', () => {
    const events: wsBorsh.CanonicalEvent[] = [];
    let snapshot = {
      metadataEpoch: new Uint8Array(16).fill(0x44),
      revision: 1n,
      records: [metadataRecord('%1', 'alpha')],
    };
    const device = createAttachedDevice(() => snapshot);
    const sender = new CanonicalTransactionSender({
      sizer: new CanonicalFrameSizer(wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES),
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      isClosed: () => false,
      getServerEpoch: () => SERVER_EPOCH,
    });

    expect(sender.sendMetadataSnapshot(device)).toBe(true);
    snapshot = {
      metadataEpoch: snapshot.metadataEpoch,
      revision: 1n,
      records: [metadataRecord('%2', 'stale-if-cached')],
    };
    expect(sender.sendMetadataSnapshot(device)).toBe(true);
    const firstTwo = snapshotNativeIds(events);
    expect(firstTwo).toEqual([['%1'], ['%1']]);

    snapshot = {
      metadataEpoch: snapshot.metadataEpoch,
      revision: 2n,
      records: [metadataRecord('%3', 'next')],
    };
    expect(sender.sendMetadataSnapshot(device)).toBe(true);
    expect(snapshotNativeIds(events)).toEqual([['%1'], ['%1'], ['%3']]);
  });
});

function metadataRecord(nativeId: string, title: string): wsBorsh.SourceMetadataRecord {
  return {
    key: {
      deviceId: 'device-a',
      serverEpoch: SERVER_EPOCH,
      entityKind: wsBorsh.SOURCE_ENTITY_PANE,
      nativeId,
    },
    parent: null,
    fields: [{ field: wsBorsh.SOURCE_FIELD_TITLE, value: { String: title } }],
  };
}

function createMetadataSender(): CanonicalTransactionSender {
  return new CanonicalTransactionSender({
    sizer: new CanonicalFrameSizer(2048),
    sendEvent: () => true,
    isClosed: () => false,
    getServerEpoch: () => SERVER_EPOCH,
  });
}

function createAttachedDevice(
  getSnapshot: () => ReturnType<AttachedDevice['runtime']['getMetadataSnapshot']>
): AttachedDevice {
  return {
    deviceId: 'device-a',
    runtime: {
      getMetadataSnapshot: getSnapshot,
    } as AttachedDevice['runtime'],
    lease: { close() {} } as AttachedDevice['lease'],
    detachListener() {},
    metadataNeedsRebase: false,
  };
}

function chunkFingerprints(chunks: wsBorsh.SourceMetadataRecord[][] | null): string[][] | null {
  return chunks?.map((chunk) => chunk.map((record) => record.key.nativeId)) ?? null;
}

function snapshotNativeIds(events: CanonicalEvent[]): string[][] {
  const ids: string[][] = [];
  for (const event of events) {
    if (!('SourceMetadataSnapshot' in event)) continue;
    ids.push(event.SourceMetadataSnapshot.records.map((record) => record.key.nativeId));
  }
  return ids;
}

function partitionByCandidateCopy(
  sender: CanonicalTransactionSender,
  snapshot: ReturnType<AttachedDevice['runtime']['getMetadataSnapshot']>,
  snapshotId: Uint8Array
): wsBorsh.SourceMetadataRecord[][] | null {
  if (snapshot.records.length === 0) return [[]];
  const chunks: wsBorsh.SourceMetadataRecord[][] = [];
  let current: wsBorsh.SourceMetadataRecord[] = [];
  for (const record of snapshot.records) {
    const candidate = [...current, record];
    const event: CanonicalEvent = {
      SourceMetadataSnapshot: {
        metadataEpoch: snapshot.metadataEpoch,
        revision: snapshot.revision,
        snapshotId,
        chunkIndex: 0xffff,
        totalChunks: 0xffff,
        records: candidate,
      },
    };
    if (sender.sizer.eventFits(event)) {
      current = candidate;
      continue;
    }
    if (current.length === 0) return null;
    chunks.push(current);
    current = [record];
    const single: CanonicalEvent = {
      SourceMetadataSnapshot: {
        metadataEpoch: snapshot.metadataEpoch,
        revision: snapshot.revision,
        snapshotId,
        chunkIndex: 0xffff,
        totalChunks: 0xffff,
        records: current,
      },
    };
    if (!sender.sizer.eventFits(single)) return null;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
