import type { EventType, WebhookEvent } from '@tmex/shared';
import { eq } from 'drizzle-orm';
import { getDeviceById, getSiteSettings } from '../db';
import type { AgentSessionRecord } from '../db/agent';
import { getDb } from '../db/client';
import { nodes, peerCache } from '../db/schema';
import { resolvePaneContext } from '../tmux/bell-context';
import { getDeviceSnapshot } from '../tmux/snapshot-directory';

export type RemoteNameLookup = {
  nodeName: (nodeId: string) => string | null;
  deviceName: (nodeId: string, deviceId: string) => string | null;
};

let remoteNameLookup: RemoteNameLookup | null = null;

export function setRemoteNameLookup(lookup: RemoteNameLookup | null): void {
  remoteNameLookup = lookup;
}

function usableName(name: string | null | undefined, id: string): string | null {
  const value = name?.trim() ?? '';
  if (!value || value === id || value === 'self') return null;
  return value;
}

function deviceNameFromInventory(
  inventoryJson: string | null | undefined,
  deviceId: string
): string | null {
  if (!inventoryJson) return null;
  try {
    const parsed: unknown = JSON.parse(inventoryJson);
    if (!parsed || typeof parsed !== 'object') return null;
    const devices = (parsed as { devices?: unknown }).devices;
    if (!Array.isArray(devices)) return null;
    for (const item of devices) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { id?: unknown; name?: unknown };
      if (row.id === deviceId && typeof row.name === 'string') {
        return usableName(row.name, deviceId);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function defaultNodeName(nodeId: string): string | null {
  try {
    const orm = getDb();
    const peer = orm
      .select({ name: peerCache.name, inventoryJson: peerCache.inventoryJson })
      .from(peerCache)
      .where(eq(peerCache.nodeId, nodeId))
      .get();
    const fromPeer = usableName(peer?.name, nodeId);
    if (fromPeer) return fromPeer;
    const node = orm.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get();
    return usableName(node?.name, nodeId);
  } catch {
    return null;
  }
}

function defaultDeviceName(nodeId: string, deviceId: string): string | null {
  try {
    const peer = getDb()
      .select({ inventoryJson: peerCache.inventoryJson })
      .from(peerCache)
      .where(eq(peerCache.nodeId, nodeId))
      .get();
    return deviceNameFromInventory(peer?.inventoryJson, deviceId);
  } catch {
    return null;
  }
}

function lookup(): RemoteNameLookup {
  return (
    remoteNameLookup ?? {
      nodeName: defaultNodeName,
      deviceName: defaultDeviceName,
    }
  );
}

function resolveRemoteNames(session: AgentSessionRecord): {
  nodeId: string | null;
  nodeName: string | null;
  deviceName: string | null;
} {
  const nodeId = session.nodeId?.trim() || null;
  if (!nodeId) {
    return { nodeId: null, nodeName: null, deviceName: null };
  }
  const names = lookup();
  const deviceId = session.deviceId ?? '';
  return {
    nodeId,
    nodeName: names.nodeName(nodeId),
    deviceName: deviceId ? names.deviceName(nodeId, deviceId) : null,
  };
}

function displayDeviceName(
  localName: string | undefined,
  remote: { nodeId: string | null; nodeName: string | null; deviceName: string | null },
  deviceId: string
): string {
  const base = localName ?? remote.deviceName ?? (remote.nodeId ? deviceId : 'unknown');
  const nodeName = remote.nodeName ?? remote.nodeId;
  if (remote.nodeId && nodeName) {
    return `${base} (${nodeName})`;
  }
  return base;
}

function resolveSessionPaneContext(session: AgentSessionRecord, siteUrl: string, remote: boolean) {
  if (remote || !session.deviceId || !session.paneId) {
    return null;
  }
  return resolvePaneContext({
    deviceId: session.deviceId,
    siteUrl,
    snapshot: getDeviceSnapshot(session.deviceId),
    rawData: { paneId: session.paneId },
  });
}

function nodePayloadFields(remote: {
  nodeId: string | null;
  nodeName: string | null;
}): Record<string, string> {
  if (!remote.nodeId) return {};
  if (remote.nodeName) {
    return { nodeId: remote.nodeId, nodeName: remote.nodeName };
  }
  return { nodeId: remote.nodeId };
}

function optionalText(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function buildAgentNotifyEvent(
  session: AgentSessionRecord,
  payload: Record<string, unknown>
): Omit<WebhookEvent, 'eventType' | 'timestamp'> {
  const settings = getSiteSettings();
  const localDevice = session.deviceId ? getDeviceById(session.deviceId) : null;
  const remote = resolveRemoteNames(session);
  const deviceId = localDevice?.id ?? session.deviceId ?? '-';
  const paneContext = resolveSessionPaneContext(session, settings.siteUrl, Boolean(remote.nodeId));
  return {
    site: {
      name: settings.siteName,
      url: settings.siteUrl,
    },
    device: {
      id: deviceId,
      name: displayDeviceName(localDevice?.name, remote, deviceId),
      type: localDevice?.type ?? 'local',
      host: localDevice?.host,
    },
    tmux: {
      sessionName: localDevice?.session,
      ...(paneContext ?? {}),
      paneId: optionalText(session.paneId),
      paneTitle: optionalText(paneContext?.paneTitle ?? session.originPaneTitle),
      paneCurrentCommand: optionalText(
        paneContext?.paneCurrentCommand ?? session.originProcessName
      ),
    },
    payload: {
      ...payload,
      agentSessionId: session.id,
      agentSessionTitle: session.title,
      ...nodePayloadFields(remote),
    },
  };
}

export async function notifyAgentEvent(params: {
  notify: (
    eventType: EventType,
    event: Omit<WebhookEvent, 'eventType' | 'timestamp'>
  ) => Promise<void>;
  session: AgentSessionRecord;
  eventType: EventType;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await params.notify(params.eventType, buildAgentNotifyEvent(params.session, params.payload));
  } catch (error) {
    console.error(`[agent-run] notify ${params.eventType} failed for ${params.session.id}:`, error);
  }
}
