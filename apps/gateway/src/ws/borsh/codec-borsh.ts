// Gateway Borsh 编解码与发送工具
// 封装 ws-borsh 协议,提供面向 Gateway 的便捷接口

import { type b, wsBorsh } from '@tmex/shared';
import type { Carrier } from '../carrier';
import { gatewayWebSocketSendGuard } from '../websocket-send-guard';

export interface BorshSessionState {
  seqGen: () => number;
  negotiated: boolean;
  clientImpl: string | null;
  maxFrameBytes: number;
  chunkReassembler: wsBorsh.ChunkReassembler;
  selectedPanes: Record<string, string | null>;
  // 分屏：焦点 pane（selectedPanes）之外还要接收输出的 pane 集合（per device）
  subscribedPanes: Record<string, Set<string>>;
}

export function createBorshSessionState(): BorshSessionState {
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

export function sendToClient(
  carrier: Carrier,
  data: Uint8Array | Uint8Array[],
  maxFrameBytes?: number | null
): boolean {
  const frames = Array.isArray(data) ? data : [data];
  return gatewayWebSocketSendGuard.sendFrames(
    carrier,
    frames as readonly BufferSource[],
    maxFrameBytes
  );
}
