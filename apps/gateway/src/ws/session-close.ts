import { agentWsHub } from '../agent/ws-hub';
import { logAt } from '../log/level';
import { sessionStateStore } from './borsh/session-state';
import type { CanonicalFeedSession } from './canonical-feed-session';
import type { DeviceConnectionRegistry } from './device-connection-registry';
import type { GatewaySession } from './gateway-session';
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

const WS_CLOSE_REASON_LOG_MAX = 64;

/** 断开日志只保留 ASCII 打印字符并截断，避免控制序列清屏或把 token 整段写入轮转文件。 */
export function sanitizeWsCloseReason(reason: string): string {
  let out = '';
  for (let i = 0; i < reason.length && out.length < WS_CLOSE_REASON_LOG_MAX; i++) {
    const code = reason.charCodeAt(i);
    if (code >= 32 && code <= 126) out += reason[i];
  }
  return out;
}

export function logWsClientDisconnected(
  session: GatewaySession,
  code: number,
  reason: string
): void {
  const level = code === 1000 || code === 1001 ? 'debug' : 'info';
  const safeReason = sanitizeWsCloseReason(reason);
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
  connections: Map<string, DeviceConnectionEntry>;
  refreshSnapshotPolling(deviceId: string): void;
  dropViewportClaims(session: GatewaySession): void;
  dropPaneSizeEpochs(session: GatewaySession): void;
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
  sessionStateStore.cleanup(session);
  agentWsHub.removeClient(session);

  for (const [deviceId, entry] of host.connections) {
    entry.canonicalClients?.delete(session);
    entry.clients.delete(session);
    host.refreshSnapshotPolling(deviceId);
    host.registry.scheduleConnectionEntryRelease(deviceId, entry);
  }
  host.dropViewportClaims(session);
  host.dropPaneSizeEpochs(session);
}
