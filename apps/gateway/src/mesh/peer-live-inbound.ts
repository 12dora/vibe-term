import type { LinkStream } from '@vibeterm/shared/link';
import type { NodeSessionStore } from '../auth/node-session-store';
import { dispatchTcpStream } from '../portmap/dispatch';
import type { WebSocketServer } from '../ws';
import { acceptHttpStream, acceptWsStream, classifyOpenPayload } from './stream-targets';
import type { DispatchHttp } from './types';
import type { GatewaySessionClose } from './ws-stream-target';

export type PeerInboundStreamHost = {
  selfNodeId: string;
  dispatchHttp: () => DispatchHttp | undefined;
  sessionStore?: NodeSessionStore;
  wsServer?: WebSocketServer;
  now: () => number;
  onGatewaySession:
    | ((
        session: import('../ws/gateway-session').GatewaySession,
        auth: { sid: string; uid: string; via: string; cid?: string }
      ) => boolean | undefined)
    | null
    | undefined;
  onGatewaySessionClose:
    | ((
        session: import('../ws/gateway-session').GatewaySession,
        close?: GatewaySessionClose
      ) => void)
    | null
    | undefined;
};

export function handlePeerInboundStream(
  host: PeerInboundStreamHost,
  peerNodeId: string,
  stream: LinkStream
): void {
  const kind = classifyOpenPayload(stream.openPayload);
  if (kind === 'tcp') {
    dispatchTcpStream(stream, { peerNodeId, selfNodeId: host.selfNodeId });
    return;
  }
  if (kind === 'http') {
    const dispatchHttp = host.dispatchHttp();
    if (!dispatchHttp || !host.sessionStore) {
      stream.reset('http-not-configured');
      return;
    }
    void acceptHttpStream(stream, {
      peerNodeId,
      sessionStore: host.sessionStore,
      dispatchHttp,
      now: host.now,
    });
    return;
  }
  if (kind !== 'ws') return;
  if (!host.wsServer || !host.sessionStore) {
    stream.reset('ws-not-configured');
    return;
  }
  void acceptWsStream(stream, {
    peerNodeId,
    sessionStore: host.sessionStore,
    wsServer: host.wsServer,
    now: host.now,
    onGatewaySession: host.onGatewaySession ?? undefined,
    onGatewaySessionClose: host.onGatewaySessionClose ?? undefined,
  });
}
