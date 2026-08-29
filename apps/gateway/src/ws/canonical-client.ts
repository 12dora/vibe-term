import type { wsBorsh } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import { encodeCanonicalEvent } from './borsh/codec-borsh';
import { CanonicalFeedSession } from './canonical-feed-session';
import type { DeviceConnectionRegistry } from './device-connection-registry';
import type { TerminalOutputMetrics } from './terminal-output-metrics';
import type { ClientState, DeviceConnectionEntry } from './types';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';

export interface CanonicalSessionHost {
  readonly connections: Map<string, DeviceConnectionEntry>;
  readonly canonicalSessions: Map<ServerWebSocket<ClientState>, CanonicalFeedSession>;
  readonly terminalOutputMetrics: TerminalOutputMetrics;
  getOrCreateConnectionEntry(
    deviceId: string,
    ws: ServerWebSocket<ClientState>
  ): Promise<DeviceConnectionEntry | null>;
}

export function sendCanonicalEvent(
  metrics: TerminalOutputMetrics,
  ws: ServerWebSocket<ClientState>,
  event: wsBorsh.CanonicalEvent
): boolean | 'backpressured' {
  const terminalBytes = 'PaneData' in event ? event.PaneData.data.byteLength : null;
  try {
    const frame = encodeCanonicalEvent(
      event,
      ws.data.borshState.seqGen(),
      ws.data.borshState.maxFrameBytes
    );
    const status = gatewayWebSocketSendGuard.sendFramesStatus(ws as ServerWebSocket<unknown>, [
      frame as unknown as BufferSource,
    ]);
    if (terminalBytes !== null) {
      metrics.recordCanonicalRecipient(terminalBytes, status === 'sent');
    }
    if (status === 'backpressured') return 'backpressured';
    return status === 'sent';
  } catch (error) {
    if (terminalBytes !== null) {
      metrics.recordCanonicalRecipient(terminalBytes, false);
    }
    console.error('[ws] failed to encode canonical event:', error);
    return false;
  }
}

export function getOrCreateCanonicalSession(
  host: CanonicalSessionHost,
  registry: DeviceConnectionRegistry,
  ws: ServerWebSocket<ClientState>
): CanonicalFeedSession {
  const existing = host.canonicalSessions.get(ws);
  if (existing) return existing;
  const session = new CanonicalFeedSession({
    maxFrameBytes: ws.data.borshState.maxFrameBytes,
    sendEvent: (event) => sendCanonicalEvent(host.terminalOutputMetrics, ws, event),
    resolveRuntime: async (deviceId) => {
      const entry = await host.getOrCreateConnectionEntry(deviceId, ws);
      if (!entry) return null;
      entry.canonicalClients ??= new Set();
      entry.canonicalClients.add(ws);
      registry.clearIdleReleaseTimer(entry);
      return entry.runtime;
    },
    initialDeviceIds: () =>
      Array.from(host.connections, ([deviceId, entry]) =>
        entry.clients.has(ws) ? deviceId : null
      ).filter((deviceId): deviceId is string => deviceId !== null),
    onDeviceAttached: (deviceId, runtime) => {
      const entry = host.connections.get(deviceId);
      if (!entry || entry.runtime !== runtime) return;
      entry.canonicalClients ??= new Set();
      entry.canonicalClients.add(ws);
      registry.clearIdleReleaseTimer(entry);
    },
    onDeviceDetached: (deviceId, runtime) => {
      const entry = host.connections.get(deviceId);
      if (!entry || entry.runtime !== runtime) return;
      entry.canonicalClients?.delete(ws);
      registry.scheduleConnectionEntryRelease(deviceId, entry);
    },
  });
  host.canonicalSessions.set(ws, session);
  return session;
}
