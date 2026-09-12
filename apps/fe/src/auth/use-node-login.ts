// 「用到才登录」的门闸。
//
// 登录页只登录 entry 自身，其余 node 一律在用户真的要用它时才登录：路由进 `/n/:id/*`，
// 或在侧边栏展开该 node。内存里的会话钥还在就静默完成，不打断用户；钥没了才退回
// 「登录此节点」按钮 → `/login?node=`。

import {
  type MeshNodesState,
  ensureAuthMode,
  getMeshNodesState,
  meshEnabledOf,
  refreshMeshNodes,
  subscribeMeshNodes,
} from '@/node/mesh-nodes';
import { SELF_NODE_ID } from '@vibeterm/api-client';
import type { MeshNode } from '@vibeterm/api-client/auth/index';
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

function isRemoteGateActive(
  runtimeNodeId: string,
  enabled: boolean,
  entryNodeId: string | null
): boolean {
  return enabled && runtimeNodeId !== SELF_NODE_ID && runtimeNodeId !== entryNodeId;
}

function meshRowOf(
  snapshot: MeshNodesState,
  runtimeNodeId: string,
  active: boolean
): MeshNode | null {
  if (!active || !meshEnabledOf(snapshot)) return null;
  return snapshot.nodes.find((node) => node.id === runtimeNodeId) ?? null;
}

function isMeshListPending(snapshot: MeshNodesState, meshOn: boolean): boolean {
  return meshOn && snapshot.loadedAt === null && snapshot.error === null;
}

function resolveNodeLoginStatus(
  waiting: boolean,
  needsLogin: boolean,
  code: LoginFailureCode | null
): NodeLoginGateStatus {
  if (waiting) return 'pending';
  if (!needsLogin) return 'ready';
  return code === null ? 'pending' : 'blocked';
}

/**
 * `runtimeNodeId`：路由 / 运行时用的 id（entry 自身为 `self`）。
 *
 * 本机与 standalone 永远 `ready`——单 node 形态不该因为这个门闸多发一个请求，也不该被挡住。
 * 远端 node：首帧缓存里已有这一行就按 `loggedIn` 当场判定（true 直接放行，false 走登录），
 * 不必等 `/api/mesh/nodes` 的 `loadedAt`。缓存偶发过期由 4401 / NodeSessionGuard 收回。
 * 这一行在缓存和列表里都没有时才 `pending` 等 REST；mode / 列表任一失败都落回 `ready`，
 * 不会无限转圈。
 */
export function useNodeLoginGate(
  runtimeNodeId: string,
  options: UseNodeLoginGateOptions = {}
): NodeLoginGate {
  const snapshot = useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);
  const active = isRemoteGateActive(runtimeNodeId, options.enabled ?? true, snapshot.entryNodeId);
  const row = meshRowOf(snapshot, runtimeNodeId, active);
  const listPending = isMeshListPending(snapshot, active && meshEnabledOf(snapshot));
  const waiting = (active && !snapshot.modeLoaded && row === null) || (listPending && row === null);

  useEffect(() => {
    if (active) void ensureAuthMode();
  }, [active]);
  useEffect(() => {
    if (listPending) void refreshMeshNodes();
  }, [listPending]);

  const needsLogin = row?.online === true && !row.loggedIn;
  const { code, retry } = useSilentLogin(runtimeNodeId, row, needsLogin);
  return { status: resolveNodeLoginStatus(waiting, needsLogin, code), code, retry };
}
