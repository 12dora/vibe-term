// WebSocket Borsh 协议编解码器
// 参考: docs/ws-protocol/2026021402-ws-borsh-v1-spec.md

import type { Schema } from '@zorsh/zorsh';
import type { b } from '@zorsh/zorsh';
import {
  CANONICAL_STATE_MAX_FRAME_BYTES,
  CANONICAL_STATE_MAX_PAYLOAD_BYTES,
  CANONICAL_STATE_PROTOCOL_VERSION,
  type CanonicalEvent,
  encodeCanonicalEventPayload,
} from './canonical-state';
import { assertCanonicalEventSemantics } from './canonical-state-validation';
import {
  ERROR_FRAME_TOO_LARGE,
  ERROR_INVALID_FRAME,
  ERROR_PAYLOAD_DECODE_FAILED,
  WsBorshError,
} from './errors';
import { KIND_CANONICAL_EVENT } from './kind';
import { ChunkSchema, EnvelopeSchema } from './schema';

// ========== 常量 ==========

export const MAGIC = new Uint8Array([0x54, 0x58]); // "TX"
export const CURRENT_VERSION = 1;
export const DEFAULT_MAX_FRAME_BYTES = 1_048_576; // 1MiB
const ENVELOPE_HEADER_BYTES = 16;
const PANE_DATA_VARIANT = 3;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const utf8Encoder = new TextEncoder();

// ========== Flags ==========

export const FLAG_ACK_REQUIRED = 1 << 0;
export const FLAG_IS_ACK = 1 << 1;
export const FLAG_IS_ERROR = 1 << 2;
export const FLAG_IS_CHUNK = 1 << 3;
export const FLAG_IS_COMPRESSED = 1 << 4;

// ========== 类型定义 ==========

export type Envelope = b.infer<typeof EnvelopeSchema>;

export interface DecodedEnvelope<T = unknown> {
  version: number;
  kind: number;
  flags: number;
  seq: number;
  payload: T;
}

// ========== 编码函数 ==========

export function encodeEnvelope(
  kind: number,
  payload: Uint8Array,
  seq: number,
  flags = 0,
  version = CURRENT_VERSION
): Uint8Array {
  const envelope: Envelope = {
    magic: MAGIC,
    version,
    kind,
    flags,
    seq,
    payload,
  };
  return EnvelopeSchema.serialize(envelope);
}

function assertUnsignedNumber(value: number, max: number, type: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`Value out of range for ${type}`);
  }
}

function assertU64(value: bigint): void {
  if (value < 0n || value > U64_MAX) {
    throw new Error('Value out of range for u64');
  }
}

function assertFixedBytes(value: Uint8Array, length: number): void {
  if (value.byteLength !== length) {
    throw new Error(`Bytes length mismatch: expected ${length}, got ${value.byteLength}`);
  }
}

function createEnvelopeFrame(
  kind: number,
  payloadLength: number,
  seq: number,
  flags: number,
  version: number
): { frame: Uint8Array; view: DataView } {
  assertUnsignedNumber(version, 0xffff, 'u16');
  assertUnsignedNumber(kind, 0xffff, 'u16');
  assertUnsignedNumber(flags, 0xffff, 'u16');
  assertUnsignedNumber(seq, 0xffff_ffff, 'u32');
  assertUnsignedNumber(payloadLength, 0xffff_ffff, 'u32');
  const frame = new Uint8Array(ENVELOPE_HEADER_BYTES + payloadLength);
  const view = new DataView(frame.buffer);
  frame.set(MAGIC, 0);
  view.setUint16(2, version, true);
  view.setUint16(4, kind, true);
  view.setUint16(6, flags, true);
  view.setUint32(8, seq, true);
  view.setUint32(12, payloadLength, true);
  return { frame, view };
}

function writeLengthPrefixedBytes(
  frame: Uint8Array,
  view: DataView,
  offset: number,
  value: Uint8Array
): number {
  view.setUint32(offset, value.byteLength, true);
  frame.set(value, offset + 4);
  return offset + 4 + value.byteLength;
}

function assertCanonicalFrameBounded(frameLength: number, negotiatedMaxFrameBytes: number): void {
  const maxFrameBytes = Math.min(CANONICAL_STATE_MAX_FRAME_BYTES, negotiatedMaxFrameBytes);
  if (frameLength > maxFrameBytes) {
    throw new WsBorshError(
      ERROR_FRAME_TOO_LARGE,
      false,
      `canonical event frame exceeds ${maxFrameBytes} byte wire limit`
    );
  }
}

export function encodeCanonicalEventFrame(
  event: CanonicalEvent,
  seq: number,
  negotiatedMaxFrameBytes = CANONICAL_STATE_MAX_FRAME_BYTES
): Uint8Array {
  if (!('PaneData' in event)) {
    const frame = encodeEnvelope(KIND_CANONICAL_EVENT, encodeCanonicalEventPayload(event), seq);
    assertCanonicalFrameBounded(frame.byteLength, negotiatedMaxFrameBytes);
    return frame;
  }

  assertCanonicalEventSemantics(event);
  const value = event.PaneData;
  assertFixedBytes(value.pane.serverEpoch, 16);
  assertFixedBytes(value.paneEpoch, 16);
  assertU64(value.seqStart);
  assertU64(value.seqEnd);
  const deviceId = utf8Encoder.encode(value.pane.deviceId);
  const paneId = utf8Encoder.encode(value.pane.paneId);
  const payloadLength = 63 + deviceId.byteLength + paneId.byteLength + value.data.byteLength;
  if (payloadLength > CANONICAL_STATE_MAX_PAYLOAD_BYTES) {
    throw new WsBorshError(
      ERROR_FRAME_TOO_LARGE,
      false,
      `canonical payload exceeds ${CANONICAL_STATE_MAX_PAYLOAD_BYTES} bytes`
    );
  }
  const frameLength = ENVELOPE_HEADER_BYTES + payloadLength;
  assertCanonicalFrameBounded(frameLength, negotiatedMaxFrameBytes);
  const { frame, view } = createEnvelopeFrame(
    KIND_CANONICAL_EVENT,
    payloadLength,
    seq,
    0,
    CURRENT_VERSION
  );
  let offset = ENVELOPE_HEADER_BYTES;
  view.setUint16(offset, CANONICAL_STATE_PROTOCOL_VERSION, true);
  frame[offset + 2] = PANE_DATA_VARIANT;
  offset += 3;
  offset = writeLengthPrefixedBytes(frame, view, offset, deviceId);
  frame.set(value.pane.serverEpoch, offset);
  offset += 16;
  offset = writeLengthPrefixedBytes(frame, view, offset, paneId);
  frame.set(value.paneEpoch, offset);
  offset += 16;
  view.setBigUint64(offset, value.seqStart, true);
  view.setBigUint64(offset + 8, value.seqEnd, true);
  writeLengthPrefixedBytes(frame, view, offset + 16, value.data);
  return frame;
}

export function encodePayload<T>(schema: Schema<T>, data: T): Uint8Array {
  return schema.serialize(data);
}

// ========== 解码函数 ==========

export function decodeEnvelope(data: Uint8Array): Envelope {
  if (data.length < 12) {
    throw new WsBorshError(ERROR_INVALID_FRAME, false, 'Envelope too small');
  }

  // 检查 magic
  if (data[0] !== MAGIC[0] || data[1] !== MAGIC[1]) {
    throw new WsBorshError(ERROR_INVALID_FRAME, false, 'Invalid magic bytes');
  }

  try {
    return EnvelopeSchema.deserialize(data);
  } catch (err) {
    throw new WsBorshError(
      ERROR_INVALID_FRAME,
      false,
      err instanceof Error ? err.message : 'Failed to decode envelope'
    );
  }
}

// 零拷贝解码：bytes 字段返回入参缓冲的 subarray 视图，只用于 TERM_OUTPUT 这类每帧可达 MiB 级的
// 热路径（通用 schema 解码器逐字节 copy 一遍）。调用方不得改写返回的视图，也不得跨帧长期持有。

export function decodeEnvelopeView(data: Uint8Array): Envelope {
  if (data.length < 12) {
    throw new WsBorshError(ERROR_INVALID_FRAME, false, 'Envelope too small');
  }
  if (data[0] !== MAGIC[0] || data[1] !== MAGIC[1]) {
    throw new WsBorshError(ERROR_INVALID_FRAME, false, 'Invalid magic bytes');
  }
  if (data.length < ENVELOPE_HEADER_BYTES) {
    throw new WsBorshError(ERROR_INVALID_FRAME, false, 'Envelope header truncated');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const payloadLength = view.getUint32(12, true);
  if (payloadLength > data.length - ENVELOPE_HEADER_BYTES) {
    throw new WsBorshError(ERROR_INVALID_FRAME, false, 'Envelope payload truncated');
  }
  return {
    magic: data.subarray(0, 2),
    version: view.getUint16(2, true),
    kind: view.getUint16(4, true),
    flags: view.getUint16(6, true),
    seq: view.getUint32(8, true),
    payload: data.subarray(ENVELOPE_HEADER_BYTES, ENVELOPE_HEADER_BYTES + payloadLength),
  };
}

export function decodePayload<T>(schema: Schema<T>, data: Uint8Array): T {
  try {
    return schema.deserialize(data);
  } catch (err) {
    throw new WsBorshError(
      ERROR_PAYLOAD_DECODE_FAILED,
      false,
      err instanceof Error ? err.message : 'Failed to decode payload'
    );
  }
}

// ========== Chunk 编码/解码 ==========

export type ChunkData = b.infer<typeof ChunkSchema>;

export function encodeChunk(chunk: ChunkData, seq: number): Uint8Array {
  const payloadBytes = ChunkSchema.serialize(chunk);
  return encodeEnvelope(/* KIND_CHUNK */ 0x0501, payloadBytes, seq);
}

export function decodeChunk(data: Uint8Array): ChunkData {
  return ChunkSchema.deserialize(data);
}

// ========== 辅助函数 ==========

export function hasFlag(flags: number, flag: number): boolean {
  return (flags & flag) !== 0;
}

export function setFlag(flags: number, flag: number, value: boolean): number {
  return value ? flags | flag : flags & ~flag;
}

export function checkMagic(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === MAGIC[0] && data[1] === MAGIC[1];
}

export function createSeqGenerator(): () => number {
  let seq = 1;
  return () => seq++;
}
