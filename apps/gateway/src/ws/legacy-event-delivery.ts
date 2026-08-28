import { wsBorsh } from '@tmex/shared';
import { sessionStateStore } from './borsh/session-state';
import type { GatewaySession } from './gateway-session';

export interface LegacyEventSender {
  sendEnvelope(session: GatewaySession, kind: number, payload: Uint8Array): void;
}

function asEventData(data: unknown): Record<string, unknown> {
  return (data ?? {}) as Record<string, unknown>;
}

function eventStringField(data: Record<string, unknown>, key: string, fallback: string): string {
  const value = data[key];
  return typeof value === 'string' && value ? value : fallback;
}

export function isEmptyNotification(type: string, data: unknown): boolean {
  if (type !== 'notification') return false;
  const record = asEventData(data);
  const title = eventStringField(record, 'title', '');
  const body = typeof record.body === 'string' ? record.body : '';
  return !title && !body;
}

function deliverToAllowedClients(
  clients: Iterable<GatewaySession>,
  payloadBytes: Uint8Array,
  sender: LegacyEventSender,
  allow: (client: GatewaySession) => boolean
): number {
  let deliveryAttempts = 0;
  for (const client of clients) {
    if (!allow(client)) continue;
    sender.sendEnvelope(client, wsBorsh.KIND_TMUX_EVENT, payloadBytes);
    deliveryAttempts += 1;
  }
  return deliveryAttempts;
}

export function deliverBell(
  clients: Iterable<GatewaySession>,
  payloadBytes: Uint8Array,
  deviceId: string,
  data: unknown,
  throttleSeconds: number,
  sender: LegacyEventSender
): number {
  const paneId = eventStringField(asEventData(data), 'paneId', '-');
  return deliverToAllowedClients(clients, payloadBytes, sender, (client) =>
    sessionStateStore.shouldAllowBell(client, deviceId, paneId, throttleSeconds)
  );
}

export function deliverNotification(
  clients: Iterable<GatewaySession>,
  payloadBytes: Uint8Array,
  deviceId: string,
  data: unknown,
  throttleSeconds: number,
  sender: LegacyEventSender
): number {
  const record = asEventData(data);
  const paneId = eventStringField(record, 'paneId', '-');
  const source = eventStringField(record, 'source', 'osc9');
  return deliverToAllowedClients(clients, payloadBytes, sender, (client) =>
    sessionStateStore.shouldAllowNotification(client, deviceId, paneId, source, throttleSeconds)
  );
}

export function deliverGenericEvent(
  clients: Iterable<GatewaySession>,
  payloadBytes: Uint8Array,
  sender: LegacyEventSender
): number {
  return deliverToAllowedClients(clients, payloadBytes, sender, () => true);
}
