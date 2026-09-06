// 「成员列表到齐了没有」的统一判据。
//
// 加入中继后重启，证书立刻就在、成员的名字与 inventory 却要等上级把状态块解开：此时
// `/api/mesh/nodes` 会返回一份**成功但不完整**的列表（只有本机，或成员名是 raw id）。
// 各屏若直接照着画，就会把「还在同步」渲染成「只有一台机器」。
//
// 判据优先用网关下发的 `pendingMembers`；旧网关不下发时退回中继上报的成员数交叉验证
// （`nodesViaRelay` 比列表里的对端还多，说明列表落后于中继）。

import { useSyncExternalStore } from 'react';
import {
  type MeshNodesState,
  getMeshNodesState,
  meshEnabledOf,
  subscribeMeshNodes,
} from './mesh-nodes-store';
import { getMeshRelayState, subscribeMeshRelay } from './mesh-relay';

export interface InventoryReadiness {
  /** 成员列表完整可信：standalone 恒为 true。 */
  ready: boolean;
  /** 该显示加载占位。首拉失败（有 `error`）不算加载中，否则会永远转下去。 */
  loading: boolean;
  /** 最近一次 `/api/mesh/nodes` 的失败原因；没有为 `null`。 */
  error: string | null;
}

export interface InventoryReadinessInput {
  meshEnabled: boolean;
  loadedAt: number | null;
  error: string | null;
  /** 网关下发的待同步成员数；旧网关不下发为 `null`。 */
  pendingMembers: number | null;
  /** 列表里的行数（含本机）。 */
  nodeCount: number;
  /** 中继上报的对端数（不含本机）；非中继模式或还没读到为 `null`。 */
  nodesViaRelay: number | null;
}

/** 旧网关的退化判据：中继说有 N 个对端，列表里却不足 N 行，差额即「还没到」。 */
function relayLag(input: InventoryReadinessInput): number {
  if (input.nodesViaRelay === null) return 0;
  return Math.max(0, input.nodesViaRelay - Math.max(0, input.nodeCount - 1));
}

export function inventoryReadinessOf(input: InventoryReadinessInput): InventoryReadiness {
  if (!input.meshEnabled) return { ready: true, loading: false, error: null };
  if (input.loadedAt === null) {
    return { ready: false, loading: input.error === null, error: input.error };
  }
  const pending = input.pendingMembers ?? relayLag(input);
  if (pending > 0) return { ready: false, loading: true, error: input.error };
  return { ready: true, loading: false, error: input.error };
}

/** 中继链路这份快照只读不拉：拉取由节点管理页那个 owner 负责，别的屏不该多发一次请求。 */
export function nodesViaRelayOf(state: {
  mode: string;
  loadedAt: number | null;
  nodesViaRelay: number;
}): number | null {
  if (state.loadedAt === null || state.mode !== 'relay') return null;
  return state.nodesViaRelay;
}

export function readinessInputOf(
  nodes: MeshNodesState,
  nodesViaRelay: number | null
): InventoryReadinessInput {
  return {
    meshEnabled: meshEnabledOf(nodes),
    loadedAt: nodes.loadedAt,
    error: nodes.error,
    pendingMembers: nodes.pendingMembers,
    nodeCount: nodes.nodes.length,
    nodesViaRelay,
  };
}

export function useInventoryReadiness(): InventoryReadiness {
  const nodes = useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);
  const relay = useSyncExternalStore(subscribeMeshRelay, getMeshRelayState, getMeshRelayState);
  return inventoryReadinessOf(readinessInputOf(nodes, nodesViaRelayOf(relay)));
}
