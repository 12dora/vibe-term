import type { UserStore } from '../auth/user-store';
import { jsonText } from './json-text';
import type { UplinkNodeList } from './uplink-protocol';

function usablePeerName(name: string | null | undefined, nodeId: string): string | null {
  const trimmed = name?.trim() ?? '';
  if (!trimmed || trimmed === nodeId) return null;
  return trimmed;
}

/** 把 `node.list` 里已 admit 的对端（含 hub 自己）写入 `peer_cache`，带上 version。 */
export function persistUplinkPeerCache(input: {
  userStore: UserStore;
  userId: string;
  selfNodeId: string;
  list: UplinkNodeList;
  now: number;
}): void {
  const { userStore, userId, selfNodeId, list, now } = input;
  for (const node of list.nodes) {
    if (node.id === selfNodeId) continue;
    const cert = userStore.getCert(node.id);
    if (!cert || cert.userId !== userId || cert.revokedLogSeq != null) continue;
    const existing = userStore.getPeer(node.id);
    const version = node.version ?? existing?.version ?? null;
    // 无 blob、只知道 online 的新行会让 rotate-root-keep / set-relays 把未握过手当成旧节点。
    // 已解密出 endpoints/inventory 的 2.2.x 对端可以没有 version，仍要建缓存行。
    if (!existing && !version && !hasDecryptablePeerPayload(node)) continue;
    userStore.upsertPeer({
      nodeId: node.id,
      name: node.name,
      endpointsJson: jsonText(node.endpoints),
      inventoryJson: jsonText(node.inventory),
      directCapable: node.direct_capable,
      lastSeenAt: now,
      listVersion: list.version,
      version,
    });
  }
  persistHubPeer(input);
}

function hasDecryptablePeerPayload(node: UplinkNodeList['nodes'][number]): boolean {
  if (node.direct_capable) return true;
  if (node.name && node.name !== node.id) return true;
  if (Array.isArray(node.endpoints) && node.endpoints.length > 0) return true;
  return node.inventory != null;
}

function persistHubPeer(input: {
  userStore: UserStore;
  userId: string;
  selfNodeId: string;
  list: UplinkNodeList;
  now: number;
}): void {
  const { userStore, userId, selfNodeId, list, now } = input;
  const hub = list.hub;
  if (!hub || hub.nodeId === selfNodeId) return;
  const fromNodes = list.nodes.find((node) => node.id === hub.nodeId);
  const name = usablePeerName(fromNodes?.name, hub.nodeId) ?? usablePeerName(hub.name, hub.nodeId);
  if (!name) return;
  const cert = userStore.getCert(hub.nodeId);
  if (!cert || cert.userId !== userId || cert.revokedLogSeq != null) return;
  const existing = userStore.listPeers().find((row) => row.nodeId === hub.nodeId);
  userStore.upsertPeer({
    nodeId: hub.nodeId,
    name,
    endpointsJson: existing?.endpointsJson ?? '[]',
    inventoryJson: existing?.inventoryJson ?? '{}',
    directCapable: existing?.directCapable ?? false,
    lastSeenAt: now,
    listVersion: list.version,
    version: fromNodes?.version ?? existing?.version ?? null,
  });
}
