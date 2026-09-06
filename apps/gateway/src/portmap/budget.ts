import { PORT_MAP_MAX_PEER_STREAMS } from './types';

/**
 * 每条 peer 链路上端口映射流的共享名额。
 *
 * mux 的 `MAX_LINK_UNACKED` 是 65 个满窗（65 MiB）——被突破会关掉整条链路，而那条链路同时
 * 承载着终端会话与文件传输。所以并发上限必须按「链路」算，而不是按单条映射算：A 侧指向同一个
 * 节点的所有映射、B 侧来自同一个对端的所有入站流，共用同一份名额，并给其它流量留出余量。
 *
 * 键只用对端 nodeId：生产环境一个进程只有一个本节点身份；集成测试里同进程的两个节点互为对端，
 * 键天然不同。
 */
const inUse = new Map<string, number>();

export type PeerStreamSlot = { release(): void };

/** 名额不足返回 null，调用方必须在开流之前就拒绝这条连接。 */
export function acquirePeerStreamSlot(
  peerNodeId: string,
  limit: number = PORT_MAP_MAX_PEER_STREAMS
): PeerStreamSlot | null {
  const used = inUse.get(peerNodeId) ?? 0;
  if (used >= limit) return null;
  inUse.set(peerNodeId, used + 1);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const current = inUse.get(peerNodeId) ?? 0;
      if (current <= 1) inUse.delete(peerNodeId);
      else inUse.set(peerNodeId, current - 1);
    },
  };
}

export function peerStreamSlotsInUse(peerNodeId: string): number {
  return inUse.get(peerNodeId) ?? 0;
}

/** 仅供测试：清空计数。 */
export function resetPeerStreamSlots(): void {
  inUse.clear();
}
