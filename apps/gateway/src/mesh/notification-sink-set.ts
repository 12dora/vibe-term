// 汇聚机集合的投影：判据是**用户签过的** `notification-sink` 记录（密钥日志全网复制，
// 每台节点算出的集合一致），节点自述的 `node.status` inventory 一律不采信。
//
// 本机多一道判据：记录说它是汇聚机，本机开关（`gateway_kv`）也得开着——记录管「别人往这里发」，
// 开关管「这台机器现在收不收」。两者有一个不成立就不算汇聚机，与入站路由的判据一致。

import type { MeshNotificationSink } from '@tmex/shared';
import { isPeerReachable } from './address-class';
import { pickMeshNodeName } from './node-list-projection';
import type { PeerReach } from './types';

export type SinkSetInput = {
  selfNodeId: string;
  selfName: string | null;
  selfEnabled: boolean;
  /** 密钥日志投影：已声明为汇聚机的节点编号。 */
  declared: ReadonlySet<string>;
  /** `state.lastNodeList?.nodes`：hub / 中继广播的最新一代列表，只用来取显示名。 */
  listed: ReadonlyArray<{ id: string; name?: string }>;
  certs: ReadonlyArray<{ nodeId: string; revokedLogSeq: number | null }>;
  peers: ReadonlyArray<{ nodeId: string; name: string }>;
  /** hub 侧 `user_nodes` 行；只用来取显示名。 */
  nodes: ReadonlyArray<{ id: string; name: string }>;
  reach: ReadonlyMap<string, PeerReach | undefined>;
  hubOnline: ReadonlySet<string>;
};

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
    if (!input.declared.has(id)) continue;
    if (isSelf && !input.selfEnabled) continue;
    const listed = listedById.get(id);
    const stored = nodeById.get(id);
    const peer = peerById.get(id);
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
