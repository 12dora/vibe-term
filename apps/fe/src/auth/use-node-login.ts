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
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { NodeLoginFailureKind } from './login-failure-kind';
import {
  noteNodeLoginFailure,
  noteNodeLoginSuccess,
  retryNodeLoginNow,
  useNodeLoginFailure,
} from './node-login-retry';
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
  /** 这次失败属于哪一类；没失败过为 `null`。界面据此决定说「连接不上」还是「需要登录」。 */
  kind: NodeLoginFailureKind | null;
  /** 还排着一次自动退避重试：界面说「稍后自动重试」，不要催用户去点。 */
  retrying: boolean;
  /** 重新尝试一次静默登录（退避阶梯归零）。 */
  retry: () => void;
}

interface UseNodeLoginGateOptions {
  /** false 时门闸恒为 `ready` 且不发任何请求（侧边栏折叠态）。 */
  enabled?: boolean;
}

/**
 * 静默登录的触发条件：需要登录，且手上没有未消化的失败记录。
 * 网络类失败排的那次退避到点后会把记录抹掉，这个条件随即重新成立——重试就是这么发生的，
 * 本模块里没有第二个定时器。
 */
export function shouldAttemptSilentLogin(needsLogin: boolean, code: string | null): boolean {
  return needsLogin && code === null;
}

/**
 * 静默登录：`needsLogin` 起来就登一次，失败记进宿主级的 `node-login-retry`。
 *
 * 失败记录不再放组件 state：节点管理表压根不发登录请求，只有共用一份记账三处才能对同一台
 * node 给出同一句话。网络类失败由那份记账自己排退避重试——到点它把记录抹掉，本 effect
 * 的 `code` 回到 `null`，于是下一帧自然重发一次，不必在这里另开定时器。
 *
 * 结果一律记账，**不看组件是否已卸载**：写的是模块级 Map，没有「往死组件上 setState」的问题，
 * 而丢掉这条记录会让刚离开的那一屏白白重来一次。
 */
function useSilentLogin(
  nodeId: string,
  row: MeshNode | null,
  needsLogin: boolean
): {
  code: LoginFailureCode | null;
  kind: NodeLoginFailureKind | null;
  retrying: boolean;
  retry: () => void;
} {
  const failure = useNodeLoginFailure(nodeId);
  const rowRef = useRef<MeshNode | null>(row);
  rowRef.current = row;
  const code = failure?.code ?? null;

  useEffect(() => {
    if (!shouldAttemptSilentLogin(needsLogin, code)) return;
    void ensureNodeLogin(nodeId, { node: rowRef.current ?? undefined }).then((result) => {
      if (result.ok) noteNodeLoginSuccess(nodeId);
      else noteNodeLoginFailure(nodeId, result.code);
    });
  }, [needsLogin, code, nodeId]);

  return {
    code,
    kind: failure?.kind ?? null,
    retrying: failure?.retrying ?? false,
    retry: useCallback(() => retryNodeLoginNow(nodeId), [nodeId]),
  };
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
  const { code, kind, retrying, retry } = useSilentLogin(runtimeNodeId, row, needsLogin);
  return { status: resolveNodeLoginStatus(waiting, needsLogin, code), code, kind, retrying, retry };
}
