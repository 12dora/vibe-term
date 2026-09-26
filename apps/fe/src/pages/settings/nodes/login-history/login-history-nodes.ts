// 登录历史要问哪些节点：记录存在各自提供登录的那台节点上，逐台经 `/n/<id>` 拉。
// 问不了的节点不静默丢掉，而是带着原因摆成一枚标签（离线 / 需升级 / 需登录 / 已暂停）。

import { isMeshNodePaused } from '@/node/merge-nodes';
import { sortNodes, toRuntimeNodeId } from '@/node/mesh-nodes';
import {
  ApiError,
  SELF_NODE_ID,
  isNodeLoginRequiredError,
  isNodeUnreachableError,
} from '@vibeterm/api-client';
import type { MeshNode } from '@vibeterm/api-client/auth/index';
import { compareSemver } from '@vibeterm/shared';

export interface LoginHistoryNode {
  /** 拼 `/n/<id>` 用；entry 自身为 `self`。 */
  id: string;
  /** 真实 mesh id：记录里的 `viaNodeId` / `targetNodeId` 按它对名字。 */
  meshId: string;
  name: string;
  isSelf: boolean;
}

export type LoginHistorySkipReason = 'offline' | 'tooOld' | 'loginRequired' | 'paused' | 'failed';

export interface LoginHistorySkip {
  node: LoginHistoryNode;
  reason: LoginHistorySkipReason;
}

export interface LoginHistoryPlan {
  targets: LoginHistoryNode[];
  skipped: LoginHistorySkip[];
}

type PlanNode = Pick<MeshNode, 'id' | 'name' | 'online' | 'loggedIn' | 'version'> & {
  paused?: boolean;
};

/** 版本能解析且低于门槛才算过旧；解析不了的交给请求本身（老节点回 404）裁决。 */
export function isTooOldForLoginRecords(version: string | null, minVersion: string): boolean {
  if (!version) return false;
  return compareSemver(version, minVersion) === -1;
}

function skipReason(
  node: PlanNode,
  isSelf: boolean,
  minVersion: string
): LoginHistorySkipReason | null {
  if (isSelf) return null;
  if (isTooOldForLoginRecords(node.version, minVersion)) return 'tooOld';
  if (!node.online) return 'offline';
  if (!node.loggedIn) return 'loginRequired';
  if (isMeshNodePaused(node)) return 'paused';
  return null;
}

export function planLoginHistoryNodes(
  nodes: readonly PlanNode[],
  entryNodeId: string | null,
  selfName: string,
  minVersion: string
): LoginHistoryPlan {
  if (nodes.length === 0) {
    const self = {
      id: SELF_NODE_ID,
      meshId: entryNodeId ?? SELF_NODE_ID,
      name: selfName,
      isSelf: true,
    };
    return { targets: [self], skipped: [] };
  }
  const plan: LoginHistoryPlan = { targets: [], skipped: [] };
  for (const node of sortNodes(nodes as MeshNode[], entryNodeId)) {
    const id = toRuntimeNodeId(node.id, entryNodeId);
    const isSelf = id === SELF_NODE_ID;
    const entry: LoginHistoryNode = { id, meshId: node.id, name: node.name, isSelf };
    const reason = skipReason(node, isSelf, minVersion);
    if (reason) plan.skipped.push({ node: entry, reason });
    else plan.targets.push(entry);
  }
  return plan;
}

/** 请求失败归到哪一类：转发器的信封 → 离线 / 需登录；老节点没有这条路由 → 需升级。 */
export function classifyLoginHistoryError(err: unknown): LoginHistorySkipReason {
  if (isNodeUnreachableError(err)) return 'offline';
  if (isNodeLoginRequiredError(err)) return 'loginRequired';
  if (err instanceof ApiError) {
    if (err.status === 404 || err.status === 405) return 'tooOld';
    if (err.status === 401) return 'loginRequired';
  }
  return 'failed';
}
