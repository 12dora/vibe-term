import type { LinkStream } from '@vibeterm/shared/link';
import type { NodeSessionStore } from '../auth/node-session-store';
import { dispatchTcpStream } from '../portmap/dispatch';
import type { WebSocketServer } from '../ws';
import { acceptExecStream } from './exec-stream-target';
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

type InboundAcceptor = (
  host: PeerInboundStreamHost,
  peerNodeId: string,
  stream: LinkStream
) => void;

function acceptTcp(host: PeerInboundStreamHost, peerNodeId: string, stream: LinkStream): void {
  dispatchTcpStream(stream, { peerNodeId, selfNodeId: host.selfNodeId });
}

function acceptExec(host: PeerInboundStreamHost, peerNodeId: string, stream: LinkStream): void {
  if (!host.sessionStore) {
    stream.reset('exec-not-configured');
    return;
  }
  acceptExecStream(stream, { peerNodeId, sessionStore: host.sessionStore, now: host.now });
}

function acceptHttp(host: PeerInboundStreamHost, peerNodeId: string, stream: LinkStream): void {
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
}

function acceptWs(host: PeerInboundStreamHost, peerNodeId: string, stream: LinkStream): void {
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

const INBOUND_ACCEPTORS: Partial<Record<ReturnType<typeof classifyOpenPayload>, InboundAcceptor>> =
  {
    tcp: acceptTcp,
    exec: acceptExec,
    http: acceptHttp,
    ws: acceptWs,
  };

export function handlePeerInboundStream(
  host: PeerInboundStreamHost,
  peerNodeId: string,
  stream: LinkStream
): void {
  if (stream.dead) return;
  const accept = INBOUND_ACCEPTORS[classifyOpenPayload(stream.openPayload)];
  if (!accept) {
    stream.reset('unknown-stream-type');
    return;
  }
  accept(host, peerNodeId, stream);
}
