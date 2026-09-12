import {
  CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1,
  GATEWAY_CAPABILITY_HELLO_SCREEN_INTENT_V1,
  wsBorsh,
} from '@vibeterm/shared';
import { agentWsHub } from '../agent/ws-hub';
import { getDisplayVersion } from '../system/version';
import type { CanonicalFeedSession } from './canonical-feed-session';
import { ERROR_CANONICAL_V11_REQUIRED, clientTooOldMessage } from './canonical-gate';
import type { GatewaySession } from './gateway-session';
import { helloS2CCapabilities } from './hello-connection-id';

export interface HelloNegotiateHost {
  sendError(
    ws: GatewaySession,
    refSeq: number | null,
    code: number,
    message: string,
    retryable: boolean
  ): void;
  sendEnvelope(ws: GatewaySession, kind: number, payload: Uint8Array): void;
  closeSession(ws: GatewaySession, code: number, reason: string): void;
  getOrCreateCanonicalSession(ws: GatewaySession): CanonicalFeedSession;
}

function helloS2CPayload(ws: GatewaySession, acceptedHelloIntent: boolean): Uint8Array {
  const capabilities = helloS2CCapabilities(ws.connectionId);
  if (acceptedHelloIntent) capabilities.push(GATEWAY_CAPABILITY_HELLO_SCREEN_INTENT_V1);
  return wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, {
    serverImpl: 'vibeterm-gateway',
    serverVersion: getDisplayVersion(),
    selectedVersion: wsBorsh.CURRENT_VERSION,
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    heartbeatIntervalMs: 15000,
    capabilities,
  });
}

export async function negotiateHello(
  host: HelloNegotiateHost,
  ws: GatewaySession,
  refSeq: number,
  payload: Uint8Array
): Promise<void> {
  let hello: wsBorsh.HelloC2S;
  try {
    hello = wsBorsh.decodeHelloC2S(payload);
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

  const clientVersion = hello.clientVersion.slice(0, 64);
  if (!wsBorsh.peerSupportsCanonicalV11(clientVersion)) {
    host.sendError(
      ws,
      refSeq,
      ERROR_CANONICAL_V11_REQUIRED,
      clientTooOldMessage(clientVersion),
      false
    );
    host.closeSession(ws, 1002, 'canonical-state-v1.1 required');
    return;
  }

  const serverMaxFrameBytes = wsBorsh.DEFAULT_MAX_FRAME_BYTES;
  ws.borshState.negotiated = true;
  ws.borshState.clientImpl = hello.clientImpl.slice(0, 64);
  ws.borshState.clientVersion = clientVersion;
  ws.borshState.maxFrameBytes = Math.min(hello.maxFrameBytes, serverMaxFrameBytes);
  if (!ws.shareScope) agentWsHub.registerClient(ws);

  const acceptHelloIntent = Boolean(
    hello.screenIntent &&
      wsBorsh.helloC2SHasCapability(hello, CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1)
  );
  host.sendEnvelope(ws, wsBorsh.KIND_HELLO_S2C, helloS2CPayload(ws, acceptHelloIntent));
  if (!acceptHelloIntent || !hello.screenIntent) return;
  await host.getOrCreateCanonicalSession(ws).applyHelloScreenIntent(hello.screenIntent);
}
