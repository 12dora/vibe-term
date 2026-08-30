import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

import { canonicalEventPayloadBytes } from './encoded-size';
import { CanonicalFrameSizer } from './frame-sizer';
import type { CanonicalEvent, CanonicalPaneTarget } from './types';

const PANE = {
  deviceId: 'device-a',
  serverEpoch: new Uint8Array(16).fill(0x11),
  paneId: '%1',
};
const PANE_EPOCH = new Uint8Array(16).fill(0x22);
const REQUEST_ID = new Uint8Array(16).fill(0x33);
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789%.-设备窗café🟢';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(rand: () => number, maxLen: number): string {
  const length = 1 + Math.floor(rand() * maxLen);
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += ALPHABET[Math.floor(rand() * ALPHABET.length)] ?? 'a';
  }
  return value;
}

function randomBytes(rand: () => number, length: number): Uint8Array {
  const value = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) value[index] = Math.floor(rand() * 256);
  return value;
}

function paneDataEvent(
  pane: CanonicalPaneTarget,
  paneEpoch: Uint8Array,
  data: Uint8Array
): CanonicalEvent {
  return {
    PaneData: {
      pane,
      paneEpoch,
      seqStart: 0n,
      seqEnd: BigInt(data.byteLength),
      data,
    },
  };
}

function expectPayloadMatchesEncode(event: CanonicalEvent): void {
  expect(canonicalEventPayloadBytes(event)).toBe(
    wsBorsh.encodeCanonicalEventPayload(event).byteLength
  );
}

function expectMaxDataIsTight(
  sizer: CanonicalFrameSizer,
  maxData: number,
  build: (data: Uint8Array) => CanonicalEvent
): void {
  const fitting = build(new Uint8Array(maxData));
  const encoded = wsBorsh.encodeCanonicalEventPayload(fitting);
  expect(encoded.byteLength + 16).toBeLessThanOrEqual(sizer.maxFrameBytes);
  expect(encoded.byteLength).toBeLessThanOrEqual(wsBorsh.CANONICAL_STATE_MAX_PAYLOAD_BYTES);
  expect(sizer.eventFits(fitting)).toBe(true);
  if (maxData === 0) return;
  const overflowing = build(new Uint8Array(maxData + 1));
  expect(sizer.eventFits(overflowing)).toBe(false);
}

describe('canonical frame sizer', () => {
  test('finds the largest payload that still fits the negotiated frame', () => {
    const sizer = new CanonicalFrameSizer(512);
    const maxPane = sizer.maxPaneDataBytes(PANE, PANE_EPOCH);
    expect(maxPane).toBeGreaterThan(0);
    expect(sizer.eventFits(paneDataEvent(PANE, PANE_EPOCH, new Uint8Array(maxPane)))).toBe(true);
    expect(sizer.eventFits(paneDataEvent(PANE, PANE_EPOCH, new Uint8Array(maxPane + 1)))).toBe(
      false
    );

    const maxChunk = sizer.maxContentChunkBytes('screen', REQUEST_ID);
    expect(maxChunk).toBeGreaterThan(0);
    expect(maxChunk).toBeLessThan(512);
    expect(
      wsBorsh.encodeCanonicalEventPayload({
        ScreenChunk: { requestId: REQUEST_ID, offset: 0, data: new Uint8Array(maxChunk) },
      }).byteLength + 16
    ).toBeLessThanOrEqual(512);
  });

  test('exact payload size matches Borsh encoding for random pane frames', () => {
    const rand = mulberry32(20260827);
    for (let trial = 0; trial < 64; trial += 1) {
      const pane: CanonicalPaneTarget = {
        deviceId: randomString(rand, 24),
        serverEpoch: randomBytes(rand, 16),
        paneId: randomString(rand, 12),
      };
      const paneEpoch = randomBytes(rand, 16);
      const data = new Uint8Array(Math.floor(rand() * 4096));
      const event = paneDataEvent(pane, paneEpoch, data);
      expectPayloadMatchesEncode(event);

      const cap = 256 + Math.floor(rand() * 8 * 1024);
      const sizer = new CanonicalFrameSizer(cap);
      const maxData = sizer.maxPaneDataBytes(pane, paneEpoch);
      expectMaxDataIsTight(sizer, maxData, (bytes) => paneDataEvent(pane, paneEpoch, bytes));
    }
  });

  test('exact payload size matches Borsh encoding for content chunks and other events', () => {
    const rand = mulberry32(27082026);
    for (let trial = 0; trial < 32; trial += 1) {
      const requestId = randomBytes(rand, 16);
      const data = new Uint8Array(Math.floor(rand() * 2048));
      expectPayloadMatchesEncode({
        ScreenChunk: { requestId, offset: Math.floor(rand() * 10_000), data },
      });
      expectPayloadMatchesEncode({
        HistoryChunk: { requestId, offset: Math.floor(rand() * 10_000), data },
      });
      const cap = 200 + Math.floor(rand() * 4096);
      const sizer = new CanonicalFrameSizer(cap);
      const maxScreen = sizer.maxContentChunkBytes('screen', requestId);
      const maxHistory = sizer.maxContentChunkBytes('history', requestId);
      expect(maxScreen).toBe(maxHistory);
      expectMaxDataIsTight(sizer, maxScreen, (bytes) => ({
        ScreenChunk: { requestId, offset: 0, data: bytes },
      }));
    }

    expectPayloadMatchesEncode({
      FeedReady: {
        gatewayEpoch: REQUEST_ID,
        maxFrameBytes: 32_768,
        maxActivePanes: 8,
        maxHotPanes: 4,
        maxScreenBytes: 512 * 1024,
        maxHistoryPageBytes: 256 * 1024,
      },
    });
    expectPayloadMatchesEncode({
      Error: { requestId: null, code: 7, message: 'failed 设备', retryable: true },
    });
    expectPayloadMatchesEncode({
      Error: { requestId: REQUEST_ID, code: 7, message: 'x'.repeat(64), retryable: false },
    });
    expectPayloadMatchesEncode({
      SourceGap: { reason: 1, scope: { Stream: {} } },
    });
    expectPayloadMatchesEncode({
      SourceGap: {
        reason: 2,
        scope: {
          Pane: {
            pane: PANE,
            expectedPaneEpoch: PANE_EPOCH,
            availablePaneEpoch: PANE_EPOCH,
            expectedSeq: 4n,
            availableSeq: 12n,
          },
        },
      },
    });
    expectPayloadMatchesEncode({
      SourceGap: {
        reason: 1,
        scope: {
          Metadata: {
            expectedEpoch: REQUEST_ID,
            availableEpoch: PANE_EPOCH,
            expectedRevision: 3n,
            availableRevision: 9n,
          },
        },
      },
    });
    expectPayloadMatchesEncode({
      ScreenCommit: { requestId: REQUEST_ID, totalBytes: 12, historyCursor: null },
    });
    expectPayloadMatchesEncode({
      ScreenCommit: {
        requestId: REQUEST_ID,
        totalBytes: 12,
        historyCursor: {
          paneEpoch: PANE_EPOCH,
          historyEpoch: REQUEST_ID,
          beforeLine: 44,
        },
      },
    });
    expectPayloadMatchesEncode({
      ScreenBegin: {
        requestId: REQUEST_ID,
        pane: PANE,
        paneEpoch: PANE_EPOCH,
        baseSeq: 12n,
        rows: 24,
        cols: 80,
        modes: 1,
        totalBytes: 4096,
      },
    });
    expectPayloadMatchesEncode({
      HistoryBegin: {
        requestId: REQUEST_ID,
        pane: PANE,
        paneEpoch: PANE_EPOCH,
        historyEpoch: REQUEST_ID,
        lineStart: 0,
        lineEnd: 10,
        truncated: true,
        totalBytes: 128,
      },
    });
    expectPayloadMatchesEncode({
      HistoryCommit: { requestId: REQUEST_ID, totalBytes: 128, nextCursor: null },
    });
    expectPayloadMatchesEncode({
      SubscriptionApplied: {
        generation: 3n,
        activePanes: [PANE],
        hotPanes: [],
        rejected: [{ pane: { ...PANE, paneId: '%9' }, reason: 1 }],
      },
    });
    expectPayloadMatchesEncode({
      SourceMetadataPatch: {
        metadataEpoch: PANE_EPOCH,
        fromRevision: 1n,
        throughRevision: 2n,
        upserts: [],
        removals: [
          {
            deviceId: 'device-a',
            serverEpoch: PANE.serverEpoch,
            entityKind: 4,
            nativeId: '%gone',
          },
        ],
      },
    });
    expectPayloadMatchesEncode({
      SourceMetadataSnapshot: {
        metadataEpoch: PANE_EPOCH,
        revision: 1n,
        snapshotId: REQUEST_ID,
        chunkIndex: 0,
        totalChunks: 1,
        records: [
          {
            key: {
              deviceId: 'device-a',
              serverEpoch: PANE.serverEpoch,
              entityKind: 4,
              nativeId: '%1',
            },
            parent: {
              deviceId: 'device-a',
              serverEpoch: PANE.serverEpoch,
              entityKind: 3,
              nativeId: '@1',
            },
            fields: [
              { field: 1, value: { String: 'title 窗' } },
              { field: 4, value: { Bool: true } },
              { field: 6, value: { U16: 80 } },
              { field: 7, value: { U32: 24 } },
              { field: 13, value: { Bytes16: PANE_EPOCH } },
              { field: 2, value: { Unset: {} } },
            ],
          },
        ],
      },
    });
  });

  test('rejects unsizable pane events and caches stable max data bytes', () => {
    const sizer = new CanonicalFrameSizer(1024);
    expect(
      canonicalEventPayloadBytes(paneDataEvent(PANE, new Uint8Array(8), new Uint8Array(4)))
    ).toBe(null);
    expect(sizer.eventFits(paneDataEvent(PANE, new Uint8Array(8), new Uint8Array(4)))).toBe(false);
    expect(
      canonicalEventPayloadBytes({
        PaneData: {
          pane: PANE,
          paneEpoch: PANE_EPOCH,
          seqStart: 0n,
          seqEnd: 5n,
          data: new Uint8Array(3),
        },
      })
    ).toBe(null);

    const first = sizer.maxPaneDataBytes(PANE, PANE_EPOCH);
    const second = sizer.maxPaneDataBytes(PANE, PANE_EPOCH);
    expect(second).toBe(first);
    const other = sizer.maxPaneDataBytes({ ...PANE, paneId: '%20' }, PANE_EPOCH);
    expect(other).toBe(first - 1);
  });

  test('cycling unique pane identities does not grow the size cache unboundedly', () => {
    const sizer = new CanonicalFrameSizer(1024);
    for (let index = 0; index < 10_000; index += 1) {
      sizer.maxPaneDataBytes(
        {
          deviceId: `device-${index}`,
          serverEpoch: PANE.serverEpoch,
          paneId: `%${index}`,
        },
        PANE_EPOCH
      );
    }
    const cache = sizer as unknown as { maxDataByKey: Map<string, number> };
    expect(cache.maxDataByKey.size).toBeLessThan(32);

    const ascii = sizer.maxPaneDataBytes({ ...PANE, deviceId: 'ab' }, PANE_EPOCH);
    const cjk = sizer.maxPaneDataBytes({ ...PANE, deviceId: '设备' }, PANE_EPOCH);
    expect(cjk).toBeLessThan(ascii);
    expect(sizer.maxPaneDataBytes({ ...PANE, deviceId: '窗口' }, PANE_EPOCH)).toBe(cjk);
  });

  test('max data bytes respect the canonical payload cap even when the sizer cap is larger', () => {
    const sizer = new CanonicalFrameSizer(1024 * 1024);
    const maxPane = sizer.maxPaneDataBytes(PANE, PANE_EPOCH);
    expectMaxDataIsTight(sizer, maxPane, (bytes) => paneDataEvent(PANE, PANE_EPOCH, bytes));
    const maxChunk = sizer.maxContentChunkBytes('history', REQUEST_ID);
    expectMaxDataIsTight(sizer, maxChunk, (bytes) => ({
      HistoryChunk: { requestId: REQUEST_ID, offset: 0, data: bytes },
    }));
  });
});
