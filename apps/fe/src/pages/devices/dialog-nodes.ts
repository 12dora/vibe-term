// 文件传输 / 端口映射两个弹窗共用的节点选项：把 `/api/mesh/nodes` 的成员表折成
// 「运行时 id + 真实 mesh id + 可用性」三件套。
//
// 两个 id 都要留着：拼 `/n/<id>` 路径用运行时 id（entry 自身退化成 `self`），而 grant 的
// `fromNodeId`、放行记录的 `fromNodeId` 要的是对端认得的真实 mesh id。

import { sortNodes, toRuntimeNodeId } from '@/node/mesh-nodes';
import { SELF_NODE_ID } from '@tmex/api-client';
import type { MeshNode } from '@tmex/api-client/auth/index';

export interface DialogNodeOption {
  /** 拼 `/n/<id>` 与建 ApiClient 用；entry 自身为 `self`。 */
  id: string;
  /** 对端认得的真实 mesh node id；standalone 下退化成 `self`。 */
  meshId: string;
  name: string;
  online: boolean;
  loggedIn: boolean;
  isSelf: boolean;
  /** 在线且已登录才能发请求。 */
  usable: boolean;
}

/** standalone（或节点列表还没回来）时唯一的那个选项：本机自己。 */
function selfOnly(selfName: string, entryNodeId: string | null): DialogNodeOption {
  return {
    id: SELF_NODE_ID,
    meshId: entryNodeId ?? SELF_NODE_ID,
    name: selfName,
    online: true,
    loggedIn: true,
    isSelf: true,
    usable: true,
  };
}

export function toDialogNodeOptions(
  nodes: MeshNode[],
  entryNodeId: string | null,
  selfName: string
): DialogNodeOption[] {
  if (nodes.length === 0) return [selfOnly(selfName, entryNodeId)];
  return sortNodes(nodes, entryNodeId).map((node) => {
    const runtimeNodeId = toRuntimeNodeId(node.id, entryNodeId);
    const isSelf = runtimeNodeId === SELF_NODE_ID;
    return {
      id: runtimeNodeId,
      meshId: node.id,
      name: node.name,
      online: node.online,
      loggedIn: node.loggedIn,
      isSelf,
      usable: node.online && node.loggedIn,
    };
  });
}

export function findDialogNode(
  options: DialogNodeOption[],
  id: string | null
): DialogNodeOption | undefined {
  return id === null ? undefined : options.find((option) => option.id === id);
}

/** 第一个可用节点；一个都没有时返回 null（弹窗此时只显示空态）。 */
export function firstUsableNode(options: DialogNodeOption[]): string | null {
  return options.find((option) => option.usable)?.id ?? null;
}

export type NodeUnavailableReason = 'offline' | 'signedOut' | null;

export function nodeUnavailableReason(option: DialogNodeOption): NodeUnavailableReason {
  if (!option.online) return 'offline';
  if (!option.loggedIn) return 'signedOut';
  return null;
}
