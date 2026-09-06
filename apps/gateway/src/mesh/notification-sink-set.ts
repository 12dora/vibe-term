// 汇聚机集合的投影：把三处 inventory（node.list 广播 / peer_cache / hub 的 nodes 行）
// 归并成一份 `MeshNotificationSink[]`。
//
// 三处来源的新鲜度按拓扑不同：叶子节点只有 node.list 与 peer_cache 会被刷新，
// hub 自己没有 node.list、`nodes` 行由 node.status 直接刷新。任一来源为真即判定为
// 汇聚机——「关」在所有来源刷新后收敛，「开」立刻生效，不会因为某一路陈旧而漏发。

import { MESH_NOTIFY_SINK_INVENTORY_KEY, type MeshNotificationSink } from '@tmex/shared';
import { isPeerReachable } from './address-class';
import { pickMeshNodeName } from './node-list-projection';
import type { PeerReach } from './types';

export type SinkSetInput = {
  selfNodeId: string;
  selfName: string | null;
  selfEnabled: boolean;
  /** `state.lastNodeList?.nodes`：hub / 中继广播的最新一代列表。 */
  listed: ReadonlyArray<{ id: string; name?: string; inventory?: unknown }>;
  certs: ReadonlyArray<{ nodeId: string; revokedLogSeq: number | null }>;
  peers: ReadonlyArray<{ nodeId: string; name: string; inventoryJson: string }>;
  /** hub 侧 `user_nodes` 行；叶子节点上这份 inventory 恒为空壳，只做兜底。 */
  nodes: ReadonlyArray<{ id: string; name: string; inventoryJson: string }>;
  reach: ReadonlyMap<string, PeerReach | undefined>;
  hubOnline: ReadonlySet<string>;
};

function sinkFlagOf(inventory: unknown): boolean {
  if (!inventory || typeof inventory !== 'object') return false;
  return (inventory as Record<string, unknown>)[MESH_NOTIFY_SINK_INVENTORY_KEY] === true;
}

function sinkFlagOfJson(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    return sinkFlagOf(JSON.parse(raw));
  } catch {
    return false;
  }
}

export function collectMeshNotificationSinks(input: SinkSetInput): MeshNotificationSink[] {
  const listedById = new Map(input.listed.map((node) => [node.id, node]));
  const peerById = new Map(input.peers.map((peer) => [peer.nodeId, peer]));
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const ids = new Set<string>([
    input.selfNodeId,
    ...input.certs.filter((cert) => cert.revokedLogSeq == null).map((cert) => cert.nodeId),
    ...listedById.keys(),
  ]);

  const sinks: MeshNotificationSink[] = [];
  for (const id of ids) {
    const isSelf = id === input.selfNodeId;
    const listed = listedById.get(id);
    const peer = peerById.get(id);
    const stored = nodeById.get(id);
    const enabled = isSelf
      ? input.selfEnabled
      : sinkFlagOfJson(peer?.inventoryJson) ||
        sinkFlagOf(listed?.inventory) ||
        sinkFlagOfJson(stored?.inventoryJson);
    if (!enabled) continue;
    sinks.push({
      nodeId: id,
      name: pickMeshNodeName({
        id,
        isSelf,
        listedName: listed?.name,
        registryName: stored?.name ?? peer?.name,
        selfName: input.selfName,
      }),
      self: isSelf,
      online: isSelf || input.hubOnline.has(id) || isPeerReachable(input.reach.get(id)),
    });
  }
  sinks.sort((a, b) => (a.self === b.self ? a.name.localeCompare(b.name) : a.self ? -1 : 1));
  return sinks;
}
