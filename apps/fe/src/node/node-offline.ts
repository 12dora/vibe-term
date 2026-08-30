// node 离线判定：侧边栏的文件页外壳与 agent 会话行共用一份。
//
// 单独成模块是为了避开环：`app-sidebar → sidebar-device-list → sidebar-agent-sessions →
// use-sidebar-agent-sessions`，两端都不能互相 import。

import { SELF_NODE_ID } from '@tmex/api-client';
import type { MeshNode } from '@tmex/api-client/auth/index';

/**
 * 该 node 是否离线。`self` 查的是 entry 自身那条；名单里没有这个 node（standalone、
 * mesh 列表还没回来）一律按在线处理——宁可让用户点进去看到请求错误，也不要把本机的
 * 设备树 / 会话行凭空灰掉。
 */
export function isNodeOffline(
  nodes: readonly MeshNode[],
  entryNodeId: string | null,
  nodeId: string
): boolean {
  const targetId = nodeId === SELF_NODE_ID ? entryNodeId : nodeId;
  if (!targetId) return false;
  const row = nodes.find((node) => node.id === targetId);
  return row ? !row.online : false;
}
