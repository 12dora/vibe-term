import { agentWsHub } from '../agent/ws-hub';
import { logAt } from '../log/level';
import { sessionStateStore } from './borsh/session-state';
import { switchBarrier } from './borsh/switch-barrier';
import type { CanonicalFeedSession } from './canonical-feed-session';
import type { DeviceConnectionRegistry } from './device-connection-registry';
import type { GatewaySession } from './gateway-session';
import type { LegacyFeedBroadcaster } from './legacy-feed-broadcaster';
import type { DeviceConnectionEntry } from './types';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';

export function formatWsClientFields(session: GatewaySession): string {
  const carrier = session.activeCarrier ?? session.primary;
  const kind = carrier.logContext?.kind ?? 'unknown';
  return `session=${session.id} carrier=${kind}`;
}

export function logWsClientConnected(session: GatewaySession): void {
  logAt('debug', `[ws] client connected ${formatWsClientFields(session)}`);
}

export function logWsClientDisconnected(
  session: GatewaySession,
  code: number,
  reason: string
): void {
  const level = code === 1000 || code === 1001 ? 'debug' : 'info';
  const safeReason = reason.replace(/[\r\n]+/g, ' ');
  logAt(
    level,
    `[ws] client disconnected ${formatWsClientFields(session)} code=${code} reason=${safeReason}`
  );
}

export interface SessionCloseHost {
  onSessionClosed: ((session: GatewaySession) => void) | null;
  registry: DeviceConnectionRegistry;
  canonicalSessions: Map<GatewaySession, CanonicalFeedSession>;
  connectedClients: Set<GatewaySession>;
  feed: LegacyFeedBroadcaster;
  connections: Map<string, DeviceConnectionEntry>;
  refreshSnapshotPolling(deviceId: string): void;
  dropViewportClaims(session: GatewaySession): void;
}

export function closeGatewaySession(
  host: SessionCloseHost,
  session: GatewaySession,
  code: number,
  reason: string
): void {
  if (session.closed) {
    return;
  }
  session.closed = true;
  logWsClientDisconnected(session, code, reason);
  try {
    host.onSessionClosed?.(session);
  } catch {
    // mesh teardown
  }

  const attached = session.carriers();
  for (const carrier of attached) {
    gatewayWebSocketSendGuard.forget(carrier);
  }
  for (const carrier of attached) {
    try {
      carrier.close(code, reason);
    } catch {
      // The carrier may already be closing.
    }
  }
  if (session.direct) {
    session.detachCarrier(session.direct);
  }

  host.registry.abandonSocket(session);
  host.canonicalSessions.get(session)?.close();
  host.canonicalSessions.delete(session);
  host.connectedClients.delete(session);
  switchBarrier.cleanupClient(session);
  sessionStateStore.cleanup(session);
  agentWsHub.removeClient(session);
  host.feed.releaseLegacyPaneObservers(session);

  for (const [deviceId, entry] of host.connections) {
    entry.canonicalClients?.delete(session);
    if (entry.clients.delete(session)) {
      delete session.borshState.selectedPanes[deviceId];
      delete session.borshState.subscribedPanes[deviceId];
    }
    host.refreshSnapshotPolling(deviceId);
    host.registry.scheduleConnectionEntryRelease(deviceId, entry);
  }
  host.dropViewportClaims(session);
}
