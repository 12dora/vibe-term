// 转发件来源节点的显示名：只从**本机自己的**节点元数据里查（peer_cache → nodes），
// 与 `agent/run-notify.ts` 的远端节点名解析同源。body 里的 `origin.nodeName` 由发送方控制，
// 不能进通知文案。

import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { nodes, peerCache } from '../db/schema';

function usableName(name: string | null | undefined, nodeId: string): string | null {
  const value = name?.trim() ?? '';
  if (!value || value === nodeId || value === 'self') return null;
  return value;
}

export function resolveMeshNodeDisplayName(nodeId: string): string | null {
  try {
    const orm = getDb();
    const peer = orm
      .select({ name: peerCache.name })
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
