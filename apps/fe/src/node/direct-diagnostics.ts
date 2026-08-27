// 设备页头部徽标的数据源：浏览器↔node 的承载与 RTT，以及 entry↔node 的到达路径。
//
// 直连（DataChannel）尚未落地（F3-1），`resolveDirectDiagnostics()` 在 connection 上找不到
// `directDiagnostics` 时返回恒为 `primary` 的桩——契约与桩都在
// `packages/ws-client/src/direct/types.ts`，F3-1 只需给 `GatewayConnection` 挂上真实实现。

import type { DirectDiagnostics } from '@tmex/ws-client/direct/types';
import { resolveDirectDiagnostics } from '@tmex/ws-client/direct/types';
import { useMemo, useSyncExternalStore } from 'react';
import { getMeshNodesState, subscribeMeshNodes } from './mesh-nodes';
import { appNodeRuntimes } from './node-runtimes';

/** 浏览器 ↔ 该 node 的承载诊断。 */
export function useDirectDiagnostics(nodeId: string): DirectDiagnostics {
  const source = useMemo(
    () => resolveDirectDiagnostics(appNodeRuntimes.get(nodeId).connection),
    [nodeId]
  );
  return useSyncExternalStore(source.subscribe, source.get, source.get);
}

/** entry ↔ 该 node 的到达路径（`lan` / `relay` / null）。 */
export function useNodeReach(nodeId: string): 'lan' | 'relay' | null {
  const state = useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);
  const node = state.nodes.find(
    (row) => row.id === nodeId || (state.entryNodeId === row.id && nodeId === 'self')
  );
  const reach = node?.reach ?? null;
  return reach === 'lan' || reach === 'relay' ? reach : null;
}
