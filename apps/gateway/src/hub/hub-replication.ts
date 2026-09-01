import type { MeshUplinkNodeList as UplinkNodeList } from '@tmex/shared/uplink';
import { type MeshHubRecord, type MeshHubStore, hubListToRecords } from '../auth/mesh-hub-store';
import type { AuthDb } from '../auth/types';
import type { UserStore } from '../auth/user-store';
import { upsertEnrolledNode } from './node-persistence';

export type { UplinkNodeList };

export type ReplicatedNodeListMeta = { hubNodeId: string | null };

export type OwnHubRow = Omit<MeshHubRecord, 'updatedAt'>;

function stringifyField(value: unknown, fallback: string): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return fallback;
  }
}

export function applyReplicatedNodeList(
  db: AuthDb,
  userStore: UserStore,
  meshHubs: MeshHubStore,
  list: UplinkNodeList,
  meta: ReplicatedNodeListMeta,
  self: {
    hubNodeId: string | undefined;
    record: OwnHubRow | null;
    authorizedHubIds?: string[];
    isAuthorizedHub?: (id: string) => boolean;
  },
  now: number
): void {
  const ownId = self.hubNodeId;
  if (ownId && meta.hubNodeId && meta.hubNodeId === ownId) return;

  for (const node of list.nodes) {
    const cert = userStore.getCert(node.id);
    if (!cert || cert.revokedLogSeq !== null) continue;
    const existing = userStore.getNode(node.id);
    upsertEnrolledNode(db, {
      id: node.id,
      userId: cert.userId,
      name: node.name,
      version: node.version,
      directCapable: node.direct_capable,
      inventoryJson: stringifyField(node.inventory, '{}'),
      endpointsJson: stringifyField(node.endpoints, '[]'),
      lastSeenAt: node.online ? now : (existing?.lastSeenAt ?? null),
      now,
    });
  }

  const envAllowed = new Set<string>();
  if (ownId) envAllowed.add(ownId.toLowerCase());
  for (const id of self.authorizedHubIds ?? []) {
    const value = id.trim().toLowerCase();
    if (value) envAllowed.add(value);
  }
  const allowed = (id: string): boolean => {
    const key = id.toLowerCase();
    if (self.isAuthorizedHub) return self.isAuthorizedHub(key);
    return envAllowed.has(key);
  };
  const incoming = list.hubs
    ? hubListToRecords(list.hubs).filter((row) => allowed(row.hubNodeId))
    : legacyIncomingHubs(list, allowed);
  const byId = new Map(incoming.map((row) => [row.hubNodeId, row]));
  if (ownId && self.record && allowed(ownId)) {
    byId.set(ownId, { ...self.record, online: true });
  }
  meshHubs.replaceAll([...byId.values()], now);
}

function legacyIncomingHubs(list: UplinkNodeList, allowed: (id: string) => boolean): OwnHubRow[] {
  if (!list.hub) return [];
  const hubNodeId = list.hub.nodeId;
  if (!allowed(hubNodeId)) return [];
  return [
    {
      hubNodeId,
      publicUrl: list.hub.publicUrl,
      name: list.hub.name ?? null,
      mode: 'active',
      priority: 100,
      writerEpoch: list.writerEpoch ?? 1,
      caFingerprint: null,
      online: true,
      lastSeenAt: null,
    },
  ];
}
