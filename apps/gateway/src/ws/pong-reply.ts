import { wsBorsh } from '@vibeterm/shared';
import { encodePayloadFrames } from './borsh/codec-borsh';
import type { Carrier } from './carrier';
import { recordPingProbe } from './gateway-metrics-log';
import type { GatewaySession } from './gateway-session';
import {
  GATEWAY_WS_PONG_BYPASS_BUFFERED_BYTES,
  gatewayWebSocketSendGuard,
} from './websocket-send-guard';
import { carrierKindOf } from './ws-backpressure-log';

function monotonicMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function replyToGatewayPing(input: {
  ws: GatewaySession;
  refSeq: number;
  payload: Uint8Array;
  carrier: Carrier | null;
  sendError: (code: number, message: string, retryable: boolean) => void;
}): void {
  const startedAt = monotonicMs();
  try {
    const ping = wsBorsh.decodePayload(wsBorsh.schema.PingPongSchema, input.payload);
    const pongPayload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, {
      nonce: ping.nonce,
      timeMs: ping.timeMs,
    });
    sendGatewayPong(input.ws, input.carrier, pongPayload, startedAt);
  } catch (err) {
    const e = err instanceof wsBorsh.WsBorshError ? err : null;
    input.sendError(
      e?.code ?? wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
      e?.message ?? 'PING payload decode failed',
      e?.retryable ?? false
    );
  }
}

function sendGatewayPong(
  ws: GatewaySession,
  inbound: Carrier | null,
  payload: Uint8Array,
  startedAt: number
): void {
  if (ws.closed) return;
  const carrier = inbound ?? ws.activeCarrier;
  const state = ws.borshState;
  const frames = encodePayloadFrames(wsBorsh.KIND_PONG, payload, state.seqGen, state.maxFrameBytes);
  let buffered = 0;
  try {
    buffered = Math.max(0, carrier.bufferedAmount());
  } catch {
    buffered = 0;
  }
  const bypassed =
    buffered < GATEWAY_WS_PONG_BYPASS_BUFFERED_BYTES &&
    !gatewayWebSocketSendGuard.isBackpressured(carrier);
  gatewayWebSocketSendGuard.sendPriorityFrames(carrier, frames as readonly BufferSource[]);
  recordPingProbe({
    serverHandleMs: monotonicMs() - startedAt,
    path: bypassed ? 'bypassed' : 'queued',
    bufferedBytes: buffered,
    kind: carrierKindOf(carrier),
  });
}
