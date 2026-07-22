import { describe, expect, test } from 'bun:test';
import { GATEWAY_CAPABILITIES, GATEWAY_CAPABILITY_CANONICAL_STATE_V1, wsBorsh } from '@tmex/shared';
import { decodeCanonicalCommand, encodeCanonicalEvent } from './codec-borsh';

const ZERO_16 = new Uint8Array(16);
const EPOCH_16 = Uint8Array.from({ length: 16 }, (_, index) => index);
const PANE = { deviceId: 'dev-1', serverEpoch: EPOCH_16, paneId: '%7' };

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('canonical state wire', () => {
  test('uses append-only top-level kinds and advertises the implemented capability', () => {
    expect(wsBorsh.KIND_CANONICAL_COMMAND).toBe(0x0901);
    expect(wsBorsh.KIND_CANONICAL_EVENT).toBe(0x0902);
    expect(wsBorsh.isValidKind(wsBorsh.KIND_CANONICAL_COMMAND)).toBe(true);
    expect(wsBorsh.isValidKind(wsBorsh.KIND_CANONICAL_EVENT)).toBe(true);
    expect(wsBorsh.kindToString(wsBorsh.KIND_CANONICAL_COMMAND)).toBe('CANONICAL_COMMAND');
    expect(GATEWAY_CAPABILITIES).toContain(GATEWAY_CAPABILITY_CANONICAL_STATE_V1);
  });

  test('pins command discriminants 0 through 4', () => {
    const commands: wsBorsh.CanonicalCommand[] = [
      {
        SetPaneSubscriptions: {
          generation: 1n,
          activePanes: [{ pane: PANE, cursor: null }],
          hotPanes: [],
        },
      },
      {
        TerminalInput: {
          requestId: ZERO_16,
          pane: PANE,
          paneEpoch: ZERO_16,
          inputId: ZERO_16,
          data: new Uint8Array([1]),
        },
      },
      { ResizePane: { requestId: ZERO_16, pane: PANE, rows: 24, cols: 80 } },
      { RequestScreen: { requestId: ZERO_16, pane: PANE, byteLimit: 4096 } },
      {
        RequestHistory: {
          requestId: ZERO_16,
          pane: PANE,
          beforeCursor: { paneEpoch: ZERO_16, terminalSeq: 99n },
          byteLimit: 4096,
        },
      },
    ];

    for (const [index, command] of commands.entries()) {
      const payload = wsBorsh.encodeCanonicalCommandPayload(command);
      expect(payload[0]).toBe(wsBorsh.CANONICAL_STATE_PROTOCOL_VERSION);
      expect(payload[1]).toBe(0);
      expect(payload[2]).toBe(index);
      expect(decodeCanonicalCommand(payload).command).toEqual(command);
    }
  });

  test('pins event discriminants 0 through 12', () => {
    const requestId = new Uint8Array(16).fill(3);
    const metadataRecord = {
      key: {
        deviceId: 'dev-1',
        serverEpoch: EPOCH_16,
        entityKind: wsBorsh.SOURCE_ENTITY_PANE,
        nativeId: '%7',
      },
      parent: null,
      fields: [{ field: wsBorsh.SOURCE_FIELD_TITLE, value: { String: 'shell' } }],
    };
    const events: wsBorsh.CanonicalEvent[] = [
      {
        FeedReady: {
          gatewayEpoch: ZERO_16,
          maxFrameBytes: wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
          maxActivePanes: 32,
          maxHotPanes: 8,
          maxScreenBytes: 262_144,
          maxHistoryPageBytes: 262_144,
        },
      },
      {
        SourceMetadataSnapshot: {
          metadataEpoch: ZERO_16,
          revision: 1n,
          snapshotId: requestId,
          chunkIndex: 0,
          totalChunks: 1,
          records: [metadataRecord],
        },
      },
      {
        SourceMetadataPatch: {
          metadataEpoch: ZERO_16,
          fromRevision: 1n,
          throughRevision: 2n,
          upserts: [metadataRecord],
          removals: [],
        },
      },
      {
        PaneData: {
          pane: PANE,
          paneEpoch: ZERO_16,
          seqStart: 0n,
          seqEnd: 1n,
          data: new Uint8Array([1]),
        },
      },
      {
        SubscriptionApplied: {
          generation: 1n,
          activePanes: [PANE],
          hotPanes: [],
          rejected: [],
        },
      },
      {
        ScreenBegin: {
          requestId,
          pane: PANE,
          paneEpoch: ZERO_16,
          baseSeq: 1n,
          rows: 24,
          cols: 80,
          modes: 0,
          totalBytes: 1,
        },
      },
      { ScreenChunk: { requestId, offset: 0, data: new Uint8Array([1]) } },
      { ScreenCommit: { requestId, totalBytes: 1 } },
      {
        HistoryBegin: {
          requestId,
          pane: PANE,
          paneEpoch: ZERO_16,
          seqStart: 0n,
          seqEnd: 1n,
          totalBytes: 1,
        },
      },
      { HistoryChunk: { requestId, offset: 0, data: new Uint8Array([1]) } },
      { HistoryCommit: { requestId, totalBytes: 1, nextCursor: null } },
      {
        SourceGap: {
          reason: wsBorsh.SOURCE_GAP_REASON_PANE_GAP,
          scope: {
            Pane: {
              pane: PANE,
              expectedPaneEpoch: ZERO_16,
              availablePaneEpoch: ZERO_16,
              expectedSeq: 1n,
              availableSeq: 2n,
            },
          },
        },
      },
      { Error: { requestId: null, code: 1, message: 'failed', retryable: true } },
    ];

    for (const [index, event] of events.entries()) {
      const payload = wsBorsh.encodeCanonicalEventPayload(event);
      expect(payload[2]).toBe(index);
      expect(wsBorsh.decodeCanonicalEventPayload(payload).event).toEqual(event);
    }
  });

  test('pins metadata value discriminants', () => {
    const values: wsBorsh.SourceMetadataValue[] = [
      { Unset: {} },
      { String: 'value' },
      { Bool: true },
      { U16: 16 },
      { U32: 32 },
      { Bytes16: ZERO_16 },
    ];
    for (const [index, value] of values.entries()) {
      expect(wsBorsh.encodePayload(wsBorsh.schema.SourceMetadataValueSchema, value)[0]).toBe(index);
    }
  });

  test('keeps complete canonical frames at or below 32 KiB', () => {
    const empty = wsBorsh.encodeCanonicalEventPayload({
      PaneData: {
        pane: PANE,
        paneEpoch: ZERO_16,
        seqStart: 0n,
        seqEnd: 0n,
        data: new Uint8Array(),
      },
    });
    const maxDataBytes = wsBorsh.CANONICAL_STATE_MAX_PAYLOAD_BYTES - empty.byteLength;
    const event = {
      PaneData: {
        pane: PANE,
        paneEpoch: ZERO_16,
        seqStart: 0n,
        seqEnd: BigInt(maxDataBytes),
        data: new Uint8Array(maxDataBytes),
      },
    } satisfies wsBorsh.CanonicalEvent;

    expect(encodeCanonicalEvent(event, 1).byteLength).toBe(wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES);
    expect(() =>
      encodeCanonicalEvent(event, 1, wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES - 1)
    ).toThrow(wsBorsh.WsBorshError);
    event.PaneData.data = new Uint8Array(maxDataBytes + 1);
    event.PaneData.seqEnd = BigInt(maxDataBytes + 1);
    expect(() => encodeCanonicalEvent(event, 2)).toThrow(wsBorsh.WsBorshError);
  });

  test('rejects unknown variants, version mismatches, and invalid pane ranges', () => {
    expect(() => wsBorsh.decodeCanonicalCommandPayload(new Uint8Array([1, 0, 99]))).toThrow(
      wsBorsh.WsBorshError
    );
    const command = wsBorsh.encodeCanonicalCommandPayload({
      SetPaneSubscriptions: { generation: 1n, activePanes: [], hotPanes: [] },
    });
    command[0] = 2;
    expect(() => wsBorsh.decodeCanonicalCommandPayload(command)).toThrow(wsBorsh.WsBorshError);
    expect(() =>
      wsBorsh.encodeCanonicalEventPayload({
        PaneData: {
          pane: PANE,
          paneEpoch: ZERO_16,
          seqStart: 10n,
          seqEnd: 12n,
          data: new Uint8Array([1]),
        },
      })
    ).toThrow(wsBorsh.WsBorshError);

    const error = wsBorsh.encodeCanonicalEventPayload({
      Error: { requestId: null, code: 1, message: '', retryable: false },
    });
    expect(() =>
      wsBorsh.decodeCanonicalEventPayload(Uint8Array.from([...error, 0]))
    ).toThrow(wsBorsh.WsBorshError);
    error[error.byteLength - 1] = 2;
    expect(() => wsBorsh.decodeCanonicalEventPayload(error)).toThrow(wsBorsh.WsBorshError);
  });

  test('matches the Rust mirror golden vectors', () => {
    const command = wsBorsh.encodeCanonicalCommandPayload({
      SetPaneSubscriptions: {
        generation: 7n,
        activePanes: [{ pane: PANE, cursor: null }],
        hotPanes: [],
      },
    });
    const event = encodeCanonicalEvent(
      {
        PaneData: {
          pane: PANE,
          paneEpoch: new Uint8Array(16).fill(0xaa),
          seqStart: 10n,
          seqEnd: 13n,
          data: new Uint8Array([65, 66, 67]),
        },
      },
      9
    );

    expect(hex(command)).toBe(
      '010000070000000000000001000000050000006465762d31000102030405060708090a0b0c0d0e0f0200000025370000000000'
    );
    expect(hex(event)).toBe(
      '54580100020900000900000049000000010003050000006465762d31000102030405060708090a0b0c0d0e0f020000002537aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0a000000000000000d0000000000000003000000414243'
    );
  });
});
