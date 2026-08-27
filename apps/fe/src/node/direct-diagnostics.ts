// 设备页头部徽标的数据源：浏览器↔node 的承载与 RTT，以及 entry↔node 的到达路径。
//
// 数据来自 `DirectCarrierController.diagnosticsSource`——`node-runtimes.ts` 在给非 self 的
// node 建连时把它挂到 `connection.directDiagnostics`。connection 上没有（`self`、或直连
// 不可用）时 `resolveDirectDiagnostics()` 回落到恒为 `primary` 的桩，契约与桩都在
// `packages/ws-client/src/direct/types.ts`。

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
