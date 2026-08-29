import { GATEWAY_CAPABILITIES, wsBorsh } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import { agentWsHub } from '../agent/ws-hub';
import { getDisplayVersion } from '../system/version';
import type { ClientState } from './types';

export interface HelloNegotiationHost {
  sendEnvelope(ws: ServerWebSocket<ClientState>, kind: number, payload: Uint8Array): void;
  sendError(
    ws: ServerWebSocket<ClientState>,
    refSeq: number | null,
    code: number,
    message: string,
    retryable: boolean
  ): void;
}

export function handleHello(
  host: HelloNegotiationHost,
  ws: ServerWebSocket<ClientState>,
  refSeq: number,
  payload: Uint8Array
): void {
  let hello: wsBorsh.b.infer<typeof wsBorsh.schema.HelloC2SSchema>;
  try {
    hello = wsBorsh.decodePayload(wsBorsh.schema.HelloC2SSchema, payload);
  } catch (err) {
    const e = err instanceof wsBorsh.WsBorshError ? err : null;
    host.sendError(
      ws,
      refSeq,
      e?.code ?? wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
      e?.message ?? 'HELLO payload decode failed',
      e?.retryable ?? false
    );
    return;
  }

  const serverMaxFrameBytes = wsBorsh.DEFAULT_MAX_FRAME_BYTES;
  const effectiveMaxFrameBytes = Math.min(hello.maxFrameBytes, serverMaxFrameBytes);

  ws.data.borshState.negotiated = true;
  ws.data.borshState.clientImpl = hello.clientImpl.slice(0, 64);
  ws.data.borshState.maxFrameBytes = effectiveMaxFrameBytes;
  agentWsHub.registerClient(ws);

  const helloS2C: wsBorsh.b.infer<typeof wsBorsh.schema.HelloS2CSchema> = {
    serverImpl: 'tmex-gateway',
    serverVersion: getDisplayVersion(),
    selectedVersion: wsBorsh.CURRENT_VERSION,
    maxFrameBytes: serverMaxFrameBytes,
    heartbeatIntervalMs: 15000,
    capabilities: [...GATEWAY_CAPABILITIES],
  };

  const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, helloS2C);
  host.sendEnvelope(ws, wsBorsh.KIND_HELLO_S2C, payloadBytes);
}

export function handlePing(
  host: HelloNegotiationHost,
  ws: ServerWebSocket<ClientState>,
  refSeq: number,
  payload: Uint8Array
): void {
  try {
    const ping = wsBorsh.decodePayload(wsBorsh.schema.PingPongSchema, payload);
    const pongPayload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, {
      nonce: ping.nonce,
      timeMs: ping.timeMs,
    });
    host.sendEnvelope(ws, wsBorsh.KIND_PONG, pongPayload);
  } catch (err) {
    const e = err instanceof wsBorsh.WsBorshError ? err : null;
    host.sendError(
      ws,
      refSeq,
      e?.code ?? wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
      e?.message ?? 'PING payload decode failed',
      e?.retryable ?? false
    );
  }
}
