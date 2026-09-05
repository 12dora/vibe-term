import type { wsBorsh } from '@tmex/shared';

import type { CanonicalEvent, CanonicalPaneTarget } from './types';

type CanonicalGapScope = Extract<CanonicalEvent, { SourceGap: unknown }>['SourceGap']['scope'];

const UTF8 = new TextEncoder();
const U8 = 1;
const U16 = 2;
const U32 = 4;
const U64 = 8;
const ENUM_TAG = 1;
const OPTION_TAG = 1;
const VEC_LEN = 4;
const PROTOCOL_VERSION_BYTES = 2;
const BYTES16 = 16;

function utf8ByteLength(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if ((value.charCodeAt(index) ?? 0) > 0x7f) return UTF8.encode(value).byteLength;
  }
  return value.length;
}

function borshString(value: string): number {
  return U32 + utf8ByteLength(value);
}

function borshFixedBytes(value: Uint8Array, length: number): number | null {
  return value.byteLength === length ? length : null;
}

function borshVarBytes(value: Uint8Array): number {
  return U32 + value.byteLength;
}

function sum(...parts: Array<number | null>): number | null {
  let total = 0;
  for (const part of parts) {
    if (part == null) return null;
    total += part;
  }
  return total;
}

function optionBytes<T>(value: T | null, inner: (item: T) => number | null): number | null {
  if (value == null) return OPTION_TAG;
  return sum(OPTION_TAG, inner(value));
}

function vecBytes<T>(items: readonly T[], inner: (item: T) => number | null): number | null {
  let total = VEC_LEN;
  for (const item of items) {
    const size = inner(item);
    if (size == null) return null;
    total += size;
  }
  return total;
}

function paneTargetBytes(pane: CanonicalPaneTarget): number | null {
  return sum(
    borshString(pane.deviceId),
    borshFixedBytes(pane.serverEpoch, BYTES16),
    borshString(pane.paneId)
  );
}

function historyCursorBytes(cursor: wsBorsh.CanonicalHistoryCursor): number | null {
  return sum(
    borshFixedBytes(cursor.paneEpoch, BYTES16),
    borshFixedBytes(cursor.historyEpoch, BYTES16),
    U32
  );
}

function entityKeyBytes(key: wsBorsh.SourceEntityKey): number | null {
  return sum(
    borshString(key.deviceId),
    borshFixedBytes(key.serverEpoch, BYTES16),
    U8,
    borshString(key.nativeId)
  );
}

function metadataValueBytes(value: wsBorsh.SourceMetadataValue): number | null {
  if ('Unset' in value) return ENUM_TAG;
  if ('String' in value) return ENUM_TAG + borshString(value.String);
  if ('Bool' in value) return ENUM_TAG + U8;
  if ('U16' in value) return ENUM_TAG + U16;
  if ('U32' in value) return ENUM_TAG + U32;
  if ('Bytes16' in value) return sum(ENUM_TAG, borshFixedBytes(value.Bytes16, BYTES16));
  return null;
}

function metadataFieldBytes(field: wsBorsh.SourceMetadataField): number | null {
  return sum(U8, metadataValueBytes(field.value));
}

export function sourceMetadataRecordBytes(record: wsBorsh.SourceMetadataRecord): number | null {
  return sum(
    entityKeyBytes(record.key),
    optionBytes(record.parent, entityKeyBytes),
    vecBytes(record.fields, metadataFieldBytes)
  );
}

function paneDataBytes(value: {
  pane: CanonicalPaneTarget;
  paneEpoch: Uint8Array;
  seqStart: bigint;
  seqEnd: bigint;
  data: Uint8Array;
}): number | null {
  if (
    value.seqEnd < value.seqStart ||
    value.seqEnd - value.seqStart !== BigInt(value.data.byteLength)
  ) {
    return null;
  }
  return sum(
    paneTargetBytes(value.pane),
    borshFixedBytes(value.paneEpoch, BYTES16),
    U64,
    U64,
    borshVarBytes(value.data)
  );
}

function contentChunkBytes(value: {
  requestId: Uint8Array;
  offset: number;
  data: Uint8Array;
}): number | null {
  return sum(borshFixedBytes(value.requestId, BYTES16), U32, borshVarBytes(value.data));
}

function paneEventBytes(event: CanonicalEvent): number | null | undefined {
  if ('PaneData' in event) return paneDataBytes(event.PaneData);
  if ('ScreenChunk' in event) return contentChunkBytes(event.ScreenChunk);
  if ('HistoryChunk' in event) return contentChunkBytes(event.HistoryChunk);
  if ('ScreenBegin' in event) {
    const value = event.ScreenBegin;
    return sum(
      borshFixedBytes(value.requestId, BYTES16),
      paneTargetBytes(value.pane),
      borshFixedBytes(value.paneEpoch, BYTES16),
      U64,
      U16,
      U16,
      U8,
      U32
    );
  }
  if ('ScreenCommit' in event) {
    return sum(
      borshFixedBytes(event.ScreenCommit.requestId, BYTES16),
      U32,
      optionBytes(event.ScreenCommit.historyCursor, historyCursorBytes)
    );
  }
  if ('HistoryBegin' in event) {
    const value = event.HistoryBegin;
    return sum(
      borshFixedBytes(value.requestId, BYTES16),
      paneTargetBytes(value.pane),
      borshFixedBytes(value.paneEpoch, BYTES16),
      borshFixedBytes(value.historyEpoch, BYTES16),
      U32,
      U32,
      U8,
      U32
    );
  }
  if ('HistoryCommit' in event) {
    return sum(
      borshFixedBytes(event.HistoryCommit.requestId, BYTES16),
      U32,
      optionBytes(event.HistoryCommit.nextCursor, historyCursorBytes)
    );
  }
  return undefined;
}

function metadataEventBytes(event: CanonicalEvent): number | null | undefined {
  if ('FeedReady' in event) {
    return sum(borshFixedBytes(event.FeedReady.gatewayEpoch, BYTES16), U32, U16, U16, U32, U32);
  }
  if ('SourceMetadataSnapshot' in event) {
    const value = event.SourceMetadataSnapshot;
    return sum(
      borshFixedBytes(value.metadataEpoch, BYTES16),
      U64,
      borshFixedBytes(value.snapshotId, BYTES16),
      U16,
      U16,
      vecBytes(value.records, sourceMetadataRecordBytes)
    );
  }
  if ('SourceMetadataPatch' in event) {
    const value = event.SourceMetadataPatch;
    return sum(
      borshFixedBytes(value.metadataEpoch, BYTES16),
      U64,
      U64,
      vecBytes(value.upserts, sourceMetadataRecordBytes),
      vecBytes(value.removals, entityKeyBytes)
    );
  }
  if ('SubscriptionApplied' in event) {
    const value = event.SubscriptionApplied;
    return sum(
      U64,
      vecBytes(value.activePanes, paneTargetBytes),
      vecBytes(value.hotPanes, paneTargetBytes),
      vecBytes(value.rejected, (item) => sum(paneTargetBytes(item.pane), U8))
    );
  }
  return undefined;
}

function gapScopeBytes(scope: CanonicalGapScope): number | null {
  if ('Stream' in scope) return ENUM_TAG;
  if ('Metadata' in scope) {
    return sum(
      ENUM_TAG,
      borshFixedBytes(scope.Metadata.expectedEpoch, BYTES16),
      borshFixedBytes(scope.Metadata.availableEpoch, BYTES16),
      U64,
      U64
    );
  }
  if ('Pane' in scope) {
    return sum(
      ENUM_TAG,
      paneTargetBytes(scope.Pane.pane),
      borshFixedBytes(scope.Pane.expectedPaneEpoch, BYTES16),
      borshFixedBytes(scope.Pane.availablePaneEpoch, BYTES16),
      U64,
      U64
    );
  }
  return null;
}

function controlEventBytes(event: CanonicalEvent): number | null {
  if ('SourceGap' in event) return sum(U8, gapScopeBytes(event.SourceGap.scope));
  if ('Error' in event) {
    return sum(
      optionBytes(event.Error.requestId, (id) => borshFixedBytes(id, BYTES16)),
      U16,
      borshString(event.Error.message),
      U8
    );
  }
  return null;
}

function eventBodyBytes(event: CanonicalEvent): number | null {
  const pane = paneEventBytes(event);
  if (pane !== undefined) return pane;
  const metadata = metadataEventBytes(event);
  if (metadata !== undefined) return metadata;
  return controlEventBytes(event);
}

export function canonicalEventPayloadBytes(event: CanonicalEvent): number | null {
  const body = eventBodyBytes(event);
  if (body == null) return null;
  return PROTOCOL_VERSION_BYTES + ENUM_TAG + body;
}
