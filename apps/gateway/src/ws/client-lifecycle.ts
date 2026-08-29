import type { Server, ServerWebSocket } from 'bun';
import { agentWsHub } from '../agent/ws-hub';
import { createBorshClientState } from './borsh/codec-borsh';
import { sessionStateStore } from './borsh/session-state';
import { switchBarrier } from './borsh/switch-barrier';
import type { CanonicalFeedSession } from './canonical-feed-session';
import type { DeviceConnectionRegistry } from './device-connection-registry';
import type { ClientState, DeviceConnectionEntry } from './types';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';

export type WebSocketUpgradeServer = {
  upgrade: Server<unknown>['upgrade'];
};

export function handleUpgrade(
  req: Request,
  server: WebSocketUpgradeServer
): Response | false | undefined {
  const url = new URL(req.url);
  if (url.pathname !== '/ws') {
    return false;
  }

  const success = server.upgrade(req, {
    data: {
      borshState: createBorshClientState(),
    } satisfies ClientState,
  });

  return success ? undefined : new Response('Upgrade failed', { status: 500 });
}

export function openClient(
  ws: ServerWebSocket<ClientState>,
  connectedClients: Set<ServerWebSocket<ClientState>>
): void {
  console.log('[ws] client connected');
  sessionStateStore.create(ws);
  connectedClients.add(ws);
}

export function handleClientDrain(
  ws: ServerWebSocket<ClientState>,
  canonicalSessions: Map<ServerWebSocket<ClientState>, Pick<CanonicalFeedSession, 'onDrain'>>
): void {
  gatewayWebSocketSendGuard.handleDrain(ws as ServerWebSocket<unknown>);
  canonicalSessions.get(ws)?.onDrain();
}

export interface CloseClientHost {
  readonly connectedClients: Set<ServerWebSocket<ClientState>>;
  readonly canonicalSessions: Map<ServerWebSocket<ClientState>, CanonicalFeedSession>;
  readonly connections: Map<string, DeviceConnectionEntry>;
  refreshSnapshotPolling(deviceId: string): void;
}

export function closeClient(
  host: CloseClientHost,
  registry: DeviceConnectionRegistry,
  ws: ServerWebSocket<ClientState>
): void {
  console.log('[ws] client disconnected');

  host.canonicalSessions.get(ws)?.close();
  host.canonicalSessions.delete(ws);
  gatewayWebSocketSendGuard.forget(ws as ServerWebSocket<unknown>);
  host.connectedClients.delete(ws);
  switchBarrier.cleanupClient(ws);
  sessionStateStore.cleanup(ws);
  agentWsHub.removeClient(ws);

  for (const [deviceId, entry] of host.connections) {
    entry.canonicalClients?.delete(ws);
    if (entry.clients.delete(ws)) {
      delete ws.data.borshState.selectedPanes[deviceId];
      delete ws.data.borshState.subscribedPanes[deviceId];
    }
    host.refreshSnapshotPolling(deviceId);
    registry.scheduleConnectionEntryRelease(deviceId, entry);
  }
}

export function closeAllClients(
  canonicalSessions: Map<ServerWebSocket<ClientState>, CanonicalFeedSession>,
  registry: DeviceConnectionRegistry
): void {
  for (const session of canonicalSessions.values()) session.close();
  canonicalSessions.clear();
  registry.closeAll();
}
