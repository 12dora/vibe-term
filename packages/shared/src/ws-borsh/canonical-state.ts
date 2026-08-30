import { b } from '@zorsh/zorsh';
import { assertCanonicalEncoding } from './canonical-scan';
import { assertCanonicalEventSemantics } from './canonical-state-validation';
import {
  ERROR_FRAME_TOO_LARGE,
  ERROR_INVALID_FRAME,
  ERROR_PAYLOAD_DECODE_FAILED,
  ERROR_UNSUPPORTED_PROTOCOL,
  WsBorshError,
} from './errors';

export const CANONICAL_STATE_PROTOCOL_VERSION = 1;
export const CANONICAL_STATE_MAX_FRAME_BYTES = 32 * 1024;
export const WS_ENVELOPE_WIRE_OVERHEAD_BYTES = 16;
export const CANONICAL_STATE_MAX_PAYLOAD_BYTES =
  CANONICAL_STATE_MAX_FRAME_BYTES - WS_ENVELOPE_WIRE_OVERHEAD_BYTES;

export const SOURCE_ENTITY_DEVICE = 0;
export const SOURCE_ENTITY_SERVER = 1;
export const SOURCE_ENTITY_SESSION = 2;
export const SOURCE_ENTITY_WINDOW = 3;
export const SOURCE_ENTITY_PANE = 4;

export const SOURCE_FIELD_NAME = 1;
export const SOURCE_FIELD_TITLE = 2;
export const SOURCE_FIELD_INDEX = 3;
export const SOURCE_FIELD_ACTIVE = 4;
export const SOURCE_FIELD_LAYOUT = 5;
export const SOURCE_FIELD_WIDTH = 6;
export const SOURCE_FIELD_HEIGHT = 7;
export const SOURCE_FIELD_LEFT = 8;
export const SOURCE_FIELD_TOP = 9;
export const SOURCE_FIELD_CURRENT_PATH = 10;
export const SOURCE_FIELD_CURRENT_COMMAND = 11;
export const SOURCE_FIELD_CONNECTED = 12;
export const SOURCE_FIELD_PANE_EPOCH = 13;
export const SOURCE_FIELD_CUSTOM_NAME = 14;

export const SUBSCRIPTION_REJECTED_NOT_FOUND = 1;
export const SUBSCRIPTION_REJECTED_RESOURCE_EXHAUSTED = 2;
export const SUBSCRIPTION_REJECTED_EPOCH_CHANGED = 3;

export const SOURCE_GAP_SCOPE_STREAM = 0;
export const SOURCE_GAP_SCOPE_METADATA = 1;
export const SOURCE_GAP_SCOPE_PANE = 2;

export const SOURCE_GAP_REASON_METADATA_GAP = 1;
export const SOURCE_GAP_REASON_PANE_GAP = 2;
export const SOURCE_GAP_REASON_EPOCH_CHANGED = 3;
export const SOURCE_GAP_REASON_CACHE_EVICTED = 4;
export const SOURCE_GAP_REASON_RESOURCE_EXHAUSTED = 5;

export const SourceEntityKeySchema = b.struct({
  deviceId: b.string(),
  serverEpoch: b.bytes(16),
  entityKind: b.u8(),
  nativeId: b.string(),
});

export const SourceMetadataValueSchema = b.enum({
  Unset: b.unit(),
  String: b.string(),
  Bool: b.bool(),
  U16: b.u16(),
  U32: b.u32(),
  Bytes16: b.bytes(16),
});

export const SourceMetadataFieldSchema = b.struct({
  field: b.u8(),
  value: SourceMetadataValueSchema,
});

export const SourceMetadataRecordSchema = b.struct({
  key: SourceEntityKeySchema,
  parent: b.option(SourceEntityKeySchema),
  fields: b.vec(SourceMetadataFieldSchema),
});

export const CanonicalPaneTargetSchema = b.struct({
  deviceId: b.string(),
  serverEpoch: b.bytes(16),
  paneId: b.string(),
});

export const CanonicalTerminalCursorSchema = b.struct({
  paneEpoch: b.bytes(16),
  terminalSeq: b.u64(),
});

export const CanonicalHistoryCursorSchema = b.struct({
  paneEpoch: b.bytes(16),
  historyEpoch: b.bytes(16),
  beforeLine: b.u32(),
});

export const CanonicalPaneSubscriptionSchema = b.struct({
  pane: CanonicalPaneTargetSchema,
  cursor: b.option(CanonicalTerminalCursorSchema),
});

export const SetPaneSubscriptionsSchema = b.struct({
  generation: b.u64(),
  activePanes: b.vec(CanonicalPaneSubscriptionSchema),
  hotPanes: b.vec(CanonicalPaneSubscriptionSchema),
});

export const CanonicalTerminalInputSchema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  paneEpoch: b.bytes(16),
  inputId: b.bytes(16),
  data: b.bytes(),
});

export const CanonicalResizePaneSchema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  rows: b.u16(),
  cols: b.u16(),
});

export const CanonicalRequestScreenSchema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  byteLimit: b.u32(),
});

export const CanonicalRequestHistorySchema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  beforeCursor: b.option(CanonicalHistoryCursorSchema),
  byteLimit: b.u32(),
});

export const CanonicalCommandSchema = b.enum({
  SetPaneSubscriptions: SetPaneSubscriptionsSchema,
  TerminalInput: CanonicalTerminalInputSchema,
  ResizePane: CanonicalResizePaneSchema,
  RequestScreen: CanonicalRequestScreenSchema,
  RequestHistory: CanonicalRequestHistorySchema,
});

export const CanonicalCommandEnvelopeSchema = b.struct({
  protocolVersion: b.u16(),
  command: CanonicalCommandSchema,
});

export const CanonicalFeedReadySchema = b.struct({
  gatewayEpoch: b.bytes(16),
  maxFrameBytes: b.u32(),
  maxActivePanes: b.u16(),
  maxHotPanes: b.u16(),
  maxScreenBytes: b.u32(),
  maxHistoryPageBytes: b.u32(),
});

export const SourceMetadataSnapshotSchema = b.struct({
  metadataEpoch: b.bytes(16),
  revision: b.u64(),
  snapshotId: b.bytes(16),
  chunkIndex: b.u16(),
  totalChunks: b.u16(),
  records: b.vec(SourceMetadataRecordSchema),
});

export const SourceMetadataPatchSchema = b.struct({
  metadataEpoch: b.bytes(16),
  fromRevision: b.u64(),
  throughRevision: b.u64(),
  upserts: b.vec(SourceMetadataRecordSchema),
  removals: b.vec(SourceEntityKeySchema),
});

export const CanonicalPaneDataSchema = b.struct({
  pane: CanonicalPaneTargetSchema,
  paneEpoch: b.bytes(16),
  seqStart: b.u64(),
  seqEnd: b.u64(),
  data: b.bytes(),
});

export const CanonicalSubscriptionRejectionSchema = b.struct({
  pane: CanonicalPaneTargetSchema,
  reason: b.u8(),
});

export const CanonicalSubscriptionAppliedSchema = b.struct({
  generation: b.u64(),
  activePanes: b.vec(CanonicalPaneTargetSchema),
  hotPanes: b.vec(CanonicalPaneTargetSchema),
  rejected: b.vec(CanonicalSubscriptionRejectionSchema),
});

export const CanonicalScreenBeginSchema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  paneEpoch: b.bytes(16),
  baseSeq: b.u64(),
  rows: b.u16(),
  cols: b.u16(),
  modes: b.u8(),
  totalBytes: b.u32(),
});

export const CanonicalContentChunkSchema = b.struct({
  requestId: b.bytes(16),
  offset: b.u32(),
  data: b.bytes(),
});

export const CanonicalScreenCommitSchema = b.struct({
  requestId: b.bytes(16),
  totalBytes: b.u32(),
  historyCursor: b.option(CanonicalHistoryCursorSchema),
});

export const CanonicalHistoryBeginSchema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  paneEpoch: b.bytes(16),
  historyEpoch: b.bytes(16),
  lineStart: b.u32(),
  lineEnd: b.u32(),
  truncated: b.bool(),
  totalBytes: b.u32(),
});

export const CanonicalHistoryCommitSchema = b.struct({
  requestId: b.bytes(16),
  totalBytes: b.u32(),
  nextCursor: b.option(CanonicalHistoryCursorSchema),
});

export const CanonicalGapScopeSchema = b.enum({
  Stream: b.unit(),
  Metadata: b.struct({
    expectedEpoch: b.bytes(16),
    availableEpoch: b.bytes(16),
    expectedRevision: b.u64(),
    availableRevision: b.u64(),
  }),
  Pane: b.struct({
    pane: CanonicalPaneTargetSchema,
    expectedPaneEpoch: b.bytes(16),
    availablePaneEpoch: b.bytes(16),
    expectedSeq: b.u64(),
    availableSeq: b.u64(),
  }),
});

export const CanonicalSourceGapSchema = b.struct({
  reason: b.u8(),
  scope: CanonicalGapScopeSchema,
});

export const CanonicalErrorSchema = b.struct({
  requestId: b.option(b.bytes(16)),
  code: b.u16(),
  message: b.string(),
  retryable: b.bool(),
});

export const CanonicalEventSchema = b.enum({
  FeedReady: CanonicalFeedReadySchema,
  SourceMetadataSnapshot: SourceMetadataSnapshotSchema,
  SourceMetadataPatch: SourceMetadataPatchSchema,
  PaneData: CanonicalPaneDataSchema,
  SubscriptionApplied: CanonicalSubscriptionAppliedSchema,
  ScreenBegin: CanonicalScreenBeginSchema,
  ScreenChunk: CanonicalContentChunkSchema,
  ScreenCommit: CanonicalScreenCommitSchema,
  HistoryBegin: CanonicalHistoryBeginSchema,
  HistoryChunk: CanonicalContentChunkSchema,
  HistoryCommit: CanonicalHistoryCommitSchema,
  SourceGap: CanonicalSourceGapSchema,
  Error: CanonicalErrorSchema,
});

export const CanonicalEventEnvelopeSchema = b.struct({
  protocolVersion: b.u16(),
  event: CanonicalEventSchema,
});

export type SourceEntityKey = b.infer<typeof SourceEntityKeySchema>;
export type SourceMetadataValue = b.infer<typeof SourceMetadataValueSchema>;
export type SourceMetadataField = b.infer<typeof SourceMetadataFieldSchema>;
export type SourceMetadataRecord = b.infer<typeof SourceMetadataRecordSchema>;
export type CanonicalPaneTarget = b.infer<typeof CanonicalPaneTargetSchema>;
export type CanonicalTerminalCursor = b.infer<typeof CanonicalTerminalCursorSchema>;
export type CanonicalHistoryCursor = b.infer<typeof CanonicalHistoryCursorSchema>;
export type CanonicalPaneSubscription = b.infer<typeof CanonicalPaneSubscriptionSchema>;
export type CanonicalCommand = b.infer<typeof CanonicalCommandSchema>;
export type CanonicalCommandEnvelope = b.infer<typeof CanonicalCommandEnvelopeSchema>;
export type CanonicalEvent = b.infer<typeof CanonicalEventSchema>;
export type CanonicalEventEnvelope = b.infer<typeof CanonicalEventEnvelopeSchema>;

export function assertCanonicalPayloadBounded(payload: Uint8Array): void {
  if (payload.byteLength > CANONICAL_STATE_MAX_PAYLOAD_BYTES) {
    throw new WsBorshError(
      ERROR_FRAME_TOO_LARGE,
      false,
      `canonical payload exceeds ${CANONICAL_STATE_MAX_PAYLOAD_BYTES} bytes`
    );
  }
}

export function encodeCanonicalCommandPayload(command: CanonicalCommand): Uint8Array {
  const payload = CanonicalCommandEnvelopeSchema.serialize({
    protocolVersion: CANONICAL_STATE_PROTOCOL_VERSION,
    command,
  });
  assertCanonicalPayloadBounded(payload);
  return payload;
}

export function decodeCanonicalCommandPayload(payload: Uint8Array): CanonicalCommandEnvelope {
  assertCanonicalPayloadBounded(payload);
  let decoded: CanonicalCommandEnvelope;
  try {
    decoded = CanonicalCommandEnvelopeSchema.deserialize(payload);
  } catch (error) {
    throw new WsBorshError(
      ERROR_PAYLOAD_DECODE_FAILED,
      false,
      error instanceof Error ? error.message : 'invalid canonical command'
    );
  }
  if (decoded.protocolVersion !== CANONICAL_STATE_PROTOCOL_VERSION) {
    throw new WsBorshError(ERROR_UNSUPPORTED_PROTOCOL, false);
  }
  assertCanonicalEncoding(CanonicalCommandEnvelopeSchema, payload);
  return decoded;
}

export function encodeCanonicalEventPayload(event: CanonicalEvent): Uint8Array {
  assertCanonicalEventSemantics(event);
  const payload = CanonicalEventEnvelopeSchema.serialize({
    protocolVersion: CANONICAL_STATE_PROTOCOL_VERSION,
    event,
  });
  assertCanonicalPayloadBounded(payload);
  return payload;
}

export function decodeCanonicalEventPayload(payload: Uint8Array): CanonicalEventEnvelope {
  assertCanonicalPayloadBounded(payload);
  let decoded: CanonicalEventEnvelope;
  try {
    decoded = CanonicalEventEnvelopeSchema.deserialize(payload);
  } catch (error) {
    throw new WsBorshError(
      ERROR_PAYLOAD_DECODE_FAILED,
      false,
      error instanceof Error ? error.message : 'invalid canonical event'
    );
  }
  if (decoded.protocolVersion !== CANONICAL_STATE_PROTOCOL_VERSION) {
    throw new WsBorshError(ERROR_UNSUPPORTED_PROTOCOL, false);
  }
  assertCanonicalEncoding(CanonicalEventEnvelopeSchema, payload);
  assertCanonicalEventSemantics(decoded.event);
  return decoded;
}

const PANE_DATA_VARIANT = 3;
const TEXT_DECODER = new TextDecoder();

export type CanonicalPaneDataHeader = {
  pane: CanonicalPaneTarget;
  paneEpoch: Uint8Array;
  seqStart: bigint;
  seqEnd: bigint;
};

export function peekCanonicalPaneDataHeader(payload: Uint8Array): CanonicalPaneDataHeader | null {
  assertCanonicalPayloadBounded(payload);
  if (payload.byteLength < 3) {
    throw new WsBorshError(ERROR_PAYLOAD_DECODE_FAILED, false, 'invalid canonical event');
  }
  const protocolVersion = (payload[0] ?? 0) | ((payload[1] ?? 0) << 8);
  if (protocolVersion !== CANONICAL_STATE_PROTOCOL_VERSION) {
    throw new WsBorshError(ERROR_UNSUPPORTED_PROTOCOL, false);
  }
  if (payload[2] !== PANE_DATA_VARIANT) return null;
  assertCanonicalEncoding(CanonicalEventEnvelopeSchema, payload);
  return readValidatedPaneDataHeader(payload);
}

function readU32Le(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function readU64Le(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
}

function readValidatedPaneDataHeader(payload: Uint8Array): CanonicalPaneDataHeader {
  let offset = 3;
  const deviceLen = readU32Le(payload, offset);
  offset += 4;
  const deviceId = TEXT_DECODER.decode(payload.subarray(offset, offset + deviceLen));
  offset += deviceLen;
  const serverEpoch = payload.slice(offset, offset + 16);
  offset += 16;
  const paneLen = readU32Le(payload, offset);
  offset += 4;
  const paneId = TEXT_DECODER.decode(payload.subarray(offset, offset + paneLen));
  offset += paneLen;
  const paneEpoch = payload.slice(offset, offset + 16);
  offset += 16;
  const seqStart = readU64Le(payload, offset);
  offset += 8;
  const seqEnd = readU64Le(payload, offset);
  offset += 8;
  const dataLen = readU32Le(payload, offset);
  if (seqEnd < seqStart || seqEnd - seqStart !== BigInt(dataLen)) {
    throw new WsBorshError(ERROR_INVALID_FRAME, false, 'PaneData sequence range mismatch');
  }
  return {
    pane: { deviceId, serverEpoch, paneId },
    paneEpoch,
    seqStart,
    seqEnd,
  };
}
