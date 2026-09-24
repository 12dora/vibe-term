import type { UserStore } from '../auth/user-store';
import { jsonText } from './json-text';
import { peerCapabilitiesChanged } from './peer-capability-change';
import { ingestPeerReachMap } from './port-reach';
import type { UplinkNodeList } from './uplink-protocol';

/** 把 `node.list` 里已 admit 的对端写入 `peer_cache`，带上 version。 */
export function persistUplinkPeerCache(input: {
  userStore: UserStore;
  userId: string;
  selfNodeId: string;
  list: UplinkNodeList;
  now: number;
  onCapabilitiesChanged?: (nodeId: string) => void;
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
    const inventoryJson = jsonText(node.inventory);
    if (
      peerCapabilitiesChanged(existing, {
        version,
        directCapable: node.direct_capable,
        inventoryJson,
      })
    ) {
      input.onCapabilitiesChanged?.(node.id);
    }
    userStore.upsertPeer({
      nodeId: node.id,
      name: node.name,
      endpointsJson: jsonText(node.endpoints),
      inventoryJson,
      directCapable: node.direct_capable,
      lastSeenAt: now,
      listVersion: list.version,
      version,
    });
    ingestPeerReachMap(node.id, node.peer_reach, selfNodeId);
  }
}

function hasDecryptablePeerPayload(node: UplinkNodeList['nodes'][number]): boolean {
  if (node.direct_capable) return true;
  if (node.name && node.name !== node.id) return true;
  if (Array.isArray(node.endpoints) && node.endpoints.length > 0) return true;
  return node.inventory != null;
}
