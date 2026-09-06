import type { PortMapExportStoreLike } from './store';
import type { PortMapPeers } from './types';

/**
 * 每个 mesh 节点在本进程内的端口映射绑定。以 nodeId 为键，是为了让同进程跑两个
 * MeshRuntime 的集成测试各自持有自己的库与链路。
 */
export type PortMapNodeBinding = {
  peers: PortMapPeers;
  exports: PortMapExportStoreLike;
};

const bindings = new Map<string, PortMapNodeBinding>();

export function bindPortMapNode(nodeId: string, binding: PortMapNodeBinding): () => void {
  bindings.set(nodeId, binding);
  return () => {
    if (bindings.get(nodeId) === binding) bindings.delete(nodeId);
  };
}

export function getPortMapNodeBinding(nodeId: string): PortMapNodeBinding | null {
  return bindings.get(nodeId) ?? null;
}

/** 生产环境只会有一个绑定；映射的监听端据此拿到 PeerManager。 */
export function solePortMapPeers(): PortMapPeers | null {
  if (bindings.size !== 1) return null;
  for (const binding of bindings.values()) return binding.peers;
  return null;
}
