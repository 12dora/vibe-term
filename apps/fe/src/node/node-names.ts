// nodeId → 展示名。包内（stores / panels）的提示语手里只有编号，要点名是哪台机器就得回来
// 查宿主的节点目录，本文件是那条查询的唯一出口。
//
// 单独成文件而不是并进 `mesh-nodes.ts`：后者已经顶着文件行数门禁的存量上限（只降不升）。

import { SELF_NODE_ID } from '@tmex/api-client';
import { getMeshNodesState } from './mesh-nodes';

/**
 * `self` 按 entry 自身解析。每次调用现查 store——runtime 建起来那一刻列表可能还没拉到。
 * 列表里没有这一行、或该行名字为空时返回 null，由调用方退回编号。
 */
export function resolveMeshNodeName(nodeId: string): string | null {
  const { nodes, entryNodeId } = getMeshNodesState();
  const target = nodeId === SELF_NODE_ID ? entryNodeId : nodeId;
  if (!target) return null;
  return nodes.find((node) => node.id === target)?.name.trim() || null;
}
