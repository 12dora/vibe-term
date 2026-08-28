import type { Device, EventType, SiteSettings, WebhookEvent } from '@tmex/shared';
import type { ConnectionAlertSource } from './connection-alerts';

export const DISCONNECT_ERROR_TYPES = new Set([
  'connection_closed',
  'network_unreachable',
  'connection_refused',
  'timeout',
  'host_not_found',
  'handshake_failed',
]);

export const BRIDGE_EVENT_SOURCES = new Set<ConnectionAlertSource>(['close', 'connect', 'probe']);

const BRIDGE_EVENT_BY_ERROR_TYPE: Record<string, EventType> = {
  tmux_unavailable: 'device_tmux_missing',
  connection_closed: 'device_disconnect',
  network_unreachable: 'device_disconnect',
  connection_refused: 'device_disconnect',
  timeout: 'device_disconnect',
  host_not_found: 'device_disconnect',
  handshake_failed: 'device_disconnect',
};

export function mapErrorTypeToBridgeEvent(errorType: string): EventType | null {
  return BRIDGE_EVENT_BY_ERROR_TYPE[errorType] ?? null;
}

export function resolveConnectionBridgeEvent(
  source: ConnectionAlertSource,
  errorType: string,
  sessionClosedEmitted: boolean
): EventType | null {
  if (!BRIDGE_EVENT_SOURCES.has(source)) return null;
  const eventType = mapErrorTypeToBridgeEvent(errorType);
  if (!eventType) return null;
  if (eventType === 'device_disconnect' && sessionClosedEmitted) return null;
  return eventType;
}

export function buildConnectionBridgeEvent(
  device: Device,
  settings: SiteSettings,
  friendlyMessage: string
): Omit<WebhookEvent, 'eventType' | 'timestamp'> {
  return {
    site: { name: settings.siteName, url: settings.siteUrl },
    device: { id: device.id, name: device.name, type: device.type, host: device.host },
    tmux: { sessionName: device.session?.trim() || 'tmex' },
    payload: { message: friendlyMessage },
  };
}

export function isWithinThrottleWindow(
  lastTs: number | undefined,
  now: number,
  windowMs: number
): boolean {
  return now - (lastTs ?? 0) < windowMs;
}

export function sweepExpiredThrottleKeys(
  map: Map<string, number>,
  deviceId: string,
  keepKey: string,
  now: number,
  windowMs: number
): void {
  for (const [otherKey, ts] of map) {
    if (otherKey !== keepKey && otherKey.startsWith(`${deviceId}:`) && now - ts >= windowMs) {
      map.delete(otherKey);
    }
  }
}
