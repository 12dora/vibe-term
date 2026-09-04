// 每 node 请求撞上 401 `NODE_LOGIN_REQUIRED` 之后的会话自愈。
//
// 背景：入口站点换过 node id（`hub leave` → `relay join`）之后，浏览器手上仍留着按旧入口
// 签发的 `tmex_s_<target>` cookie。目标 node 的 via 校验不认它，一路回 401，而
// `/api/mesh/nodes` 的 `loggedIn` 只表示「有没有这只 cookie」，门闸（`useNodeLoginGate`）
// 因此永远判定「已登录」，不会再登一次——设备列表就一直加载失败。
//
// 这里补上那一次重登：每个 node 每轮失效只登一次（`attempted` 记账，请求重新成功才清），
// 成功就回源，失败且不是网络类原因才把该 node 标未登录，让界面退回登录入口。
// 一次 401 就翻 `loggedIn` 是不行的：转发路径（直连/中转切换）会产生会话仍有效的 401，
// 就地登出会抽掉整棵子树再静默登回来，表现为设备卡片闪断。

import { SELF_NODE_ID, isNodeLoginRequiredError } from '@tmex/api-client';
import { markLoggedOut } from './mesh-nodes';

export type NodeSessionRecoveryOutcome =
  /** 不是「该 node 要重新登录」，不归本模块管。 */
  | 'ignored'
  /** 这一轮已经重登过一次，不再重复（防 401 → 重登 → 401 的死循环）。 */
  | 'skipped'
  /** 重登成功，调用方应当立刻回源。 */
  | 'recovered'
  /** 重登失败，错误交给界面呈现。 */
  | 'failed';

export interface NodeSessionRecoveryDeps {
  /** 静默重登（测试注入）；缺省懒加载 `ensureNodeLogin`。 */
  login?: (nodeId: string) => Promise<{ ok: boolean; code?: string }>;
  /** 重登成功后的回源（失效的那条查询重新发起）。 */
  onRecovered?: () => void;
  /** 标记该 node 未登录（测试注入）。 */
  markLoggedOut?: (nodeId: string) => void;
}

/** 这些失败是「等会儿再来」，不足以判定会话作废，保持 `loggedIn` 不动。 */
const TRANSIENT_LOGIN_FAILURES = new Set<string>(['NETWORK_ERROR', 'NODE_LIST_FAILED']);

const attempted = new Set<string>();
const inFlight = new Map<string, Promise<NodeSessionRecoveryOutcome>>();

function silentNodeLogin(nodeId: string): Promise<{ ok: boolean; code?: string }> {
  return import('@/auth/session-key-store').then((mod) => mod.ensureNodeLogin(nodeId));
}

/**
 * 处理一次每 node 请求的失败。只对 `NODE_LOGIN_REQUIRED` 动作，其余原样放过。
 *
 * entry 自身（`self`）不在此列：它的 401 由全局拦截器负责踢去登录页。
 */
export function handleNodeApiError(
  nodeId: string,
  error: unknown,
  deps: NodeSessionRecoveryDeps = {}
): Promise<NodeSessionRecoveryOutcome> {
  if (nodeId === SELF_NODE_ID || !isNodeLoginRequiredError(error)) {
    return Promise.resolve('ignored');
  }
  const running = inFlight.get(nodeId);
  if (running) return running;
  if (attempted.has(nodeId)) return Promise.resolve('skipped');
  attempted.add(nodeId);

  const login = deps.login ?? silentNodeLogin;
  const signOut = deps.markLoggedOut ?? markLoggedOut;
  const task = login(nodeId)
    .then((result): NodeSessionRecoveryOutcome => {
      if (result.ok) {
        deps.onRecovered?.();
        return 'recovered';
      }
      if (!TRANSIENT_LOGIN_FAILURES.has(result.code ?? '')) signOut(nodeId);
      return 'failed';
    })
    .catch((): NodeSessionRecoveryOutcome => 'failed')
    .finally(() => {
      inFlight.delete(nodeId);
    });
  inFlight.set(nodeId, task);
  return task;
}

/** 该 node 的请求重新成功：下一次会话失效可以再自愈一轮。 */
export function resetNodeSessionRecovery(nodeId: string): void {
  attempted.delete(nodeId);
}

/** 仅测试使用：清掉记账与在途的重登。 */
export function resetNodeSessionRecoveryForTest(): void {
  attempted.clear();
  inFlight.clear();
}
