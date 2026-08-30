// 「用到才登录」的门闸。
//
// 登录页只登录 entry 自身，其余 node 一律在用户真的要用它时才登录：路由进 `/n/:id/*`，
// 或在侧边栏展开该 node。内存里的会话钥还在就静默完成，不打断用户；钥没了才退回
// 「登录此节点」按钮 → `/login?node=`。

import {
  ensureAuthMode,
  getMeshNodesState,
  refreshMeshNodes,
  subscribeMeshNodes,
} from '@/node/mesh-nodes';
import { SELF_NODE_ID } from '@tmex/api-client';
import type { MeshNode } from '@tmex/api-client/auth/index';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { type LoginFailureCode, ensureNodeLogin } from './session-key-store';

type NodeLoginGateStatus =
  /** 可以直接渲染该 node 的内容：本机、standalone、已登录，或确定判断不了。 */
  | 'ready'
  /** 正在确认状态或正在静默登录。 */
  | 'pending'
  /** 静默登录失败，需要用户介入。 */
  | 'blocked';

export interface NodeLoginGate {
  status: NodeLoginGateStatus;
  /** `blocked` 时的失败码。 */
  code: LoginFailureCode | null;
  /** 重新尝试一次静默登录。 */
  retry: () => void;
}

interface UseNodeLoginGateOptions {
  /** false 时门闸恒为 `ready` 且不发任何请求（侧边栏折叠态）。 */
  enabled?: boolean;
}

/**
 * 静默登录：`needsLogin` 起来就登一次，失败后停下等 `retry()`。
 * 失败记录带上 nodeId：切到另一台 node 时旧的失败自动不再匹配，不必额外重置。
 */
function useSilentLogin(
  nodeId: string,
  row: MeshNode | null,
  needsLogin: boolean
): { code: LoginFailureCode | null; retry: () => void } {
  const [failure, setFailure] = useState<{ nodeId: string; code: LoginFailureCode } | null>(null);
  const rowRef = useRef<MeshNode | null>(row);
  rowRef.current = row;
  const code = failure?.nodeId === nodeId ? failure.code : null;

  useEffect(() => {
    if (!needsLogin || code !== null) return;
    let cancelled = false;
    void ensureNodeLogin(nodeId, { node: rowRef.current ?? undefined }).then((result) => {
      if (!cancelled && !result.ok) setFailure({ nodeId, code: result.code });
    });
    return () => {
      cancelled = true;
    };
  }, [needsLogin, code, nodeId]);

  // 清掉失败记录即重新触发上面的静默登录。
  return { code, retry: useCallback(() => setFailure(null), []) };
}

/**
 * `runtimeNodeId`：路由 / 运行时用的 id（entry 自身为 `self`）。
 *
 * 本机与 standalone 永远 `ready`——单 node 形态不该因为这个门闸多发一个请求，也不该被挡住。
 * 远端 node 在「还不知道它是不是已登录」期间是 `pending`：先渲染子树再抽走会把整棵树重挂一遍
 * （终端、WS 全部重连），所以宁可先等那两个必定会落地的请求（`/api/auth/mode`、`/api/mesh/nodes`）。
 * 两者任一失败都会落回 `ready`，不会无限转圈。
 */
export function useNodeLoginGate(
  runtimeNodeId: string,
  options: UseNodeLoginGateOptions = {}
): NodeLoginGate {
  const snapshot = useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);
  const active =
    (options.enabled ?? true) &&
    runtimeNodeId !== SELF_NODE_ID &&
    runtimeNodeId !== snapshot.entryNodeId;
  const meshEnabled = active && snapshot.mode?.mode === 'mesh';
  const row = meshEnabled
    ? (snapshot.nodes.find((node) => node.id === runtimeNodeId) ?? null)
    : null;
  const modeUnknown = active && !snapshot.modeLoaded;
  const listUnknown = meshEnabled && snapshot.loadedAt === null && snapshot.error === null;

  useEffect(() => {
    if (active) void ensureAuthMode();
  }, [active]);
  useEffect(() => {
    if (listUnknown) void refreshMeshNodes();
  }, [listUnknown]);

  const needsLogin = row?.online === true && !row.loggedIn;
  const { code, retry } = useSilentLogin(runtimeNodeId, row, needsLogin);

  let status: NodeLoginGateStatus = 'ready';
  if (modeUnknown || listUnknown) status = 'pending';
  else if (needsLogin) status = code === null ? 'pending' : 'blocked';

  return { status, code, retry };
}
