// node 离线判定：侧边栏的智能体 / 文件页外壳与 agent 会话行共用一份。
//
// 单独成模块是为了避开环：`app-sidebar → sidebar-device-list → sidebar-agent-sessions →
// use-sidebar-agent-sessions`，两端都不能互相 import。

import { SELF_NODE_ID } from '@tmex/api-client';
import type { MeshNode } from '@tmex/api-client/auth/index';
import { useMeshNodes } from './mesh-nodes';

export interface NodeOfflineSnapshot {
  nodes: readonly MeshNode[];
  entryNodeId: string | null;
  /** mesh 成员列表是否已成功加载过一次（standalone 永远为 false） */
  loaded: boolean;
}

/**
 * 该 node 是否离线，三态：
 * - `undefined`：状态未知——standalone，或 mesh 列表还没回来（别据此灰掉任何东西）；
 * - `true`：列表已加载但没有这一行（已撤销 / 已移除 / 路由 id 根本不是成员），或该行 `online` 为假；
 * - `false`：该行在线。
 *
 * `self` 查的是 entry 自身那条。
 */
export function isNodeOffline(snapshot: NodeOfflineSnapshot, nodeId: string): boolean | undefined {
  if (!snapshot.loaded) return undefined;
  const targetId = nodeId === SELF_NODE_ID ? snapshot.entryNodeId : nodeId;
  if (!targetId) return undefined;
  const row = snapshot.nodes.find((node) => node.id === targetId);
  return row ? !row.online : true;
}

/**
 * 读宿主级 mesh 快照判定离线态。`enabled: false`：不发 `/api/mesh/*`、不订阅事件流
 * ——拉取与订阅归外壳里常驻的 `MeshNodesResident`，切侧边栏标签或路由都不会中断。
 */
export function useNodeOffline(nodeId: string): boolean | undefined {
  const { nodes, entryNodeId, mode, loadedAt } = useMeshNodes({ enabled: false });
  return isNodeOffline(
    { nodes, entryNodeId, loaded: mode?.mode === 'mesh' && loadedAt !== null },
    nodeId
  );
}
