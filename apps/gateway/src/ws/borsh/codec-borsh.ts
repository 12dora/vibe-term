// Gateway Borsh 编解码与发送工具
// 封装 ws-borsh 协议,提供面向 Gateway 的便捷接口

import { type b, wsBorsh } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import { gatewayWebSocketSendGuard } from '../websocket-send-guard';

// ========== 类型定义 ==========

export interface BorshClientState {
  seqGen: () => number;
  negotiated: boolean;
  clientImpl: string | null;
  maxFrameBytes: number;
  chunkReassembler: wsBorsh.ChunkReassembler;
  selectedPanes: Record<string, string | null>;
  // 分屏：焦点 pane（selectedPanes）之外还要接收输出的 pane 集合（per device）
  subscribedPanes: Record<string, Set<string>>;
}

export function createBorshClientState(): BorshClientState {
  return {
    seqGen: wsBorsh.createSeqGenerator(),
    negotiated: false,
    clientImpl: null,
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    chunkReassembler: new wsBorsh.ChunkReassembler(),
    selectedPanes: {},
    subscribedPanes: {},
  };
}

// ========== 编码辅助函数 ==========

export function encodeHelloS2C(
  params: b.infer<typeof wsBorsh.schema.HelloS2CSchema>,
  seq: number
): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, params);
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_S2C, payload, seq);
}

export function encodeError(
  params: b.infer<typeof wsBorsh.schema.ErrorSchema>,
  seq: number
): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.ErrorSchema, params);
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_ERROR, payload, seq);
}

export function encodePong(
  params: b.infer<typeof wsBorsh.schema.PingPongSchema>,
  seq: number
): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, params);
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_PONG, payload, seq);
}

export function encodeDeviceConnected(
  params: b.infer<typeof wsBorsh.schema.DeviceConnectedSchema>,
  seq: number
): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectedSchema, params);
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_DEVICE_CONNECTED, payload, seq);
}

export function encodeDeviceDisconnected(
  params: b.infer<typeof wsBorsh.schema.DeviceDisconnectedSchema>,
  seq: number
): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.DeviceDisconnectedSchema, params);
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_DEVICE_DISCONNECTED, payload, seq);
}

export function encodeDeviceEvent(
  params: b.infer<typeof wsBorsh.schema.DeviceEventSchema>,
  seq: number
): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.DeviceEventSchema, params);
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_DEVICE_EVENT, payload, seq);
}

export function encodeStateSnapshot(
  params: b.infer<typeof wsBorsh.schema.StateSnapshotSchema>,
  seqGen: () => number,
  maxFrameBytes: number
): Uint8Array[] {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.StateSnapshotSchema, params);
  return encodePayloadFrames(wsBorsh.KIND_STATE_SNAPSHOT, payload, seqGen, maxFrameBytes);
}

export function encodeTmuxEvent(
  params: b.infer<typeof wsBorsh.schema.TmuxEventSchema>,
  seq: number
): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TmuxEventSchema, params);
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_TMUX_EVENT, payload, seq);
}

export function encodeTermOutput(
  params: b.infer<typeof wsBorsh.schema.TermOutputSchema>,
  seq: number
): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TermOutputSchema, params);
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_TERM_OUTPUT, payload, seq);
}

export function encodeTermHistory(
  params: b.infer<typeof wsBorsh.schema.TermHistorySchema>,
  seqGen: () => number,
  maxFrameBytes: number
): Uint8Array[] {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TermHistorySchema, params);
  return encodePayloadFrames(wsBorsh.KIND_TERM_HISTORY, payload, seqGen, maxFrameBytes);
}

export function encodeSwitchAck(
  params: b.infer<typeof wsBorsh.schema.SwitchAckSchema>,
  seq: number
): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.SwitchAckSchema, params);
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_SWITCH_ACK, payload, seq);
}

export function encodeClipboardWrite(
  params: b.infer<typeof wsBorsh.schema.ClipboardWriteSchema>,
  seq: number
): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.ClipboardWriteSchema, params);
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_CLIPBOARD_WRITE, payload, seq);
}

export function encodeLiveResume(
  params: b.infer<typeof wsBorsh.schema.LiveResumeSchema>,
  seq: number
): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.LiveResumeSchema, params);
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_LIVE_RESUME, payload, seq);
}

export function encodeCanonicalEvent(
  event: wsBorsh.CanonicalEvent,
  seq: number,
  negotiatedMaxFrameBytes = wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES
): Uint8Array {
  const payload = wsBorsh.encodeCanonicalEventPayload(event);
  const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_CANONICAL_EVENT, payload, seq);
  const maxFrameBytes = Math.min(wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES, negotiatedMaxFrameBytes);
  if (frame.byteLength > maxFrameBytes) {
    throw new wsBorsh.WsBorshError(
      wsBorsh.ERROR_FRAME_TOO_LARGE,
      false,
      `canonical event frame exceeds ${maxFrameBytes} byte wire limit`
    );
  }
  return frame;
}

export function decodeCanonicalCommand(data: Uint8Array): wsBorsh.CanonicalCommandEnvelope {
  return wsBorsh.decodeCanonicalCommandPayload(data);
}

// ========== 分片编码 ==========

export function encodePayloadFrames(
  kind: number,
  payload: Uint8Array,
  seqGen: () => number,
  maxFrameBytes: number
): Uint8Array[] {
  const originalSeq = seqGen();
  const chunkResult = wsBorsh.splitPayloadIntoChunks(payload, kind, originalSeq, {
    maxFrameBytes,
    chunkStreamId: wsBorsh.generateChunkStreamId(),
  });

  if (chunkResult.totalChunks === 0) {
    return [wsBorsh.encodeEnvelope(kind, payload, originalSeq)];
  }

  return chunkResult.chunks.map((chunk) => wsBorsh.encodeChunk(chunk, seqGen()));
}

// ========== 发送工具 ==========

export function sendToClient(
  ws: ServerWebSocket<unknown>,
  data: Uint8Array | Uint8Array[]
): boolean {
  const frames = Array.isArray(data) ? data : [data];
  return gatewayWebSocketSendGuard.sendFrames(ws, frames as readonly BufferSource[]);
}

// ========== 解码辅助函数 ==========

export function decodeHelloC2S(data: Uint8Array): b.infer<typeof wsBorsh.schema.HelloC2SSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.HelloC2SSchema, data);
}

export function decodePing(data: Uint8Array): b.infer<typeof wsBorsh.schema.PingPongSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.PingPongSchema, data);
}

export function decodeDeviceConnect(
  data: Uint8Array
): b.infer<typeof wsBorsh.schema.DeviceConnectSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.DeviceConnectSchema, data);
}

export function decodeDeviceDisconnect(
  data: Uint8Array
): b.infer<typeof wsBorsh.schema.DeviceDisconnectSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.DeviceDisconnectSchema, data);
}

export function decodeTmuxSelect(
  data: Uint8Array
): b.infer<typeof wsBorsh.schema.TmuxSelectSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.TmuxSelectSchema, data);
}

export function decodeTmuxSelectWindow(
  data: Uint8Array
): b.infer<typeof wsBorsh.schema.TmuxSelectWindowSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.TmuxSelectWindowSchema, data);
}

export function decodeTmuxCreateWindow(
  data: Uint8Array
): b.infer<typeof wsBorsh.schema.TmuxCreateWindowSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.TmuxCreateWindowSchema, data);
}

export function decodeTmuxCloseWindow(
  data: Uint8Array
): b.infer<typeof wsBorsh.schema.TmuxCloseWindowSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.TmuxCloseWindowSchema, data);
}

export function decodeTmuxClosePane(
  data: Uint8Array
): b.infer<typeof wsBorsh.schema.TmuxClosePaneSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.TmuxClosePaneSchema, data);
}

export function decodeTmuxRenameWindow(
  data: Uint8Array
): b.infer<typeof wsBorsh.schema.TmuxRenameWindowSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.TmuxRenameWindowSchema, data);
}

export function decodeTermInput(data: Uint8Array): b.infer<typeof wsBorsh.schema.TermInputSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.TermInputSchema, data);
}

export function decodeTermPaste(data: Uint8Array): b.infer<typeof wsBorsh.schema.TermPasteSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.TermPasteSchema, data);
}

export function decodeTermResize(
  data: Uint8Array
): b.infer<typeof wsBorsh.schema.TermResizeSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.TermResizeSchema, data);
}

export function decodeTermSyncSize(
  data: Uint8Array
): b.infer<typeof wsBorsh.schema.TermSyncSizeSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.TermSyncSizeSchema, data);
}

export function decodeChunkPayload(data: Uint8Array): wsBorsh.ChunkData {
  return wsBorsh.decodeChunk(data);
}
