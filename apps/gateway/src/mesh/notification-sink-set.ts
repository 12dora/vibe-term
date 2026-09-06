// 汇聚机集合的投影：把三处 inventory（node.list 广播 / peer_cache / hub 的 nodes 行）
// 归并成一份 `MeshNotificationSink[]`。
//
// 选取规则是「取最新的一次权威观测」，不是「任一为真」：
//   - `peer_cache` 由上行 `node.list`、中继状态块与直连 `peer.status` 共同刷新，是最全的一路，
//     它有行就以它为准；
//   - `nodes` 行（hub 侧由 `node.status` 直接刷新）与 peer 行同时存在时，比 `lastSeenAt` 取新的；
//   - peer 行缺失时才退回 `node.list` 广播，再退回 `nodes` 行。
// 取「或」会让节点在上行中断期间关掉开关后仍被判成汇聚机（陈旧的那一路一直为真），
// 事件会继续往一台已经不接收的机器上发。

import { MESH_NOTIFY_SINK_INVENTORY_KEY, type MeshNotificationSink } from '@tmex/shared';
import { isPeerReachable } from './address-class';
import { pickMeshNodeName } from './node-list-projection';
import type { PeerReach } from './types';

type InventoryRow = { inventoryJson: string; lastSeenAt?: number | null };

export type SinkSetInput = {
  selfNodeId: string;
  selfName: string | null;
  selfEnabled: boolean;
  /** `state.lastNodeList?.nodes`：hub / 中继广播的最新一代列表。 */
  listed: ReadonlyArray<{ id: string; name?: string; inventory?: unknown }>;
  certs: ReadonlyArray<{ nodeId: string; revokedLogSeq: number | null }>;
  peers: ReadonlyArray<{
    nodeId: string;
    name: string;
    inventoryJson: string;
    lastSeenAt?: number | null;
  }>;
  /** hub 侧 `user_nodes` 行；叶子节点上这份 inventory 恒为空壳，只做兜底。 */
  nodes: ReadonlyArray<{
    id: string;
    name: string;
    inventoryJson: string;
    lastSeenAt?: number | null;
  }>;
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

/** peer 行与 nodes 行同时存在时取 `lastSeenAt` 更新的一路。 */
function newestStoredFlag(peer: InventoryRow, stored: InventoryRow | undefined): boolean {
  if (!stored) return sinkFlagOfJson(peer.inventoryJson);
  const newer = (stored.lastSeenAt ?? 0) > (peer.lastSeenAt ?? 0) ? stored : peer;
  return sinkFlagOfJson(newer.inventoryJson);
}

function sinkFlagFor(input: {
  peer: InventoryRow | undefined;
  stored: InventoryRow | undefined;
  listed: { inventory?: unknown } | undefined;
}): boolean {
  if (input.peer) return newestStoredFlag(input.peer, input.stored);
  if (input.listed) return sinkFlagOf(input.listed.inventory);
  return input.stored ? sinkFlagOfJson(input.stored.inventoryJson) : false;
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
    const enabled = isSelf ? input.selfEnabled : sinkFlagFor({ peer, stored, listed });
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
