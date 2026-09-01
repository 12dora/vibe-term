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
  self: { hubNodeId: string | undefined; record: OwnHubRow | null },
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

  if (!list.hubs) return;
  const incoming = hubListToRecords(list.hubs);
  const byId = new Map(incoming.map((row) => [row.hubNodeId, row]));
  if (ownId && self.record) {
    byId.set(ownId, { ...self.record, online: true });
  }
  meshHubs.replaceAll([...byId.values()], now);
}
