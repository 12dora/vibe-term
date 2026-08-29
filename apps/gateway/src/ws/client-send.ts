import { wsBorsh } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import { encodePayloadFrames, sendToClient } from './borsh/codec-borsh';
import type { ClientState } from './types';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';

export function sendClientEnvelope(
  ws: ServerWebSocket<ClientState>,
  kind: number,
  payload: Uint8Array
): void {
  sendClientChunked(ws, kind, payload);
}

export function sendClientChunked(
  ws: ServerWebSocket<ClientState>,
  kind: number,
  payload: Uint8Array
): boolean {
  if (!gatewayWebSocketSendGuard.canSend(ws as ServerWebSocket<unknown>)) {
    return false;
  }
  const state = ws.data.borshState;
  return sendToClient(
    ws as ServerWebSocket<unknown>,
    encodePayloadFrames(kind, payload, state.seqGen, state.maxFrameBytes)
  );
}

export function sendClientError(
  ws: ServerWebSocket<ClientState>,
  refSeq: number | null,
  code: number,
  message: string,
  retryable: boolean
): void {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.ErrorSchema, {
    refSeq,
    code,
    message,
    retryable,
  });
  sendClientEnvelope(ws, wsBorsh.KIND_ERROR, payload);
}
