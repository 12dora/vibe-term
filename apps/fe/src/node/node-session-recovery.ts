// 每 node 请求撞上 401 `NODE_LOGIN_REQUIRED` 之后的会话自愈。
//
// 背景：入口站点换过 node id（`hub leave` → `relay join`）之后，浏览器手上仍留着按旧入口
// 签发的 `tmex_s_<target>` cookie。目标 node 的 via 校验不认它，一路回 401，而
// `/api/mesh/nodes` 的 `loggedIn` 只表示「有没有这只 cookie」，门闸（`useNodeLoginGate`）
// 因此永远判定「已登录」，不会再登一次——设备列表就一直加载失败。
//
// 这里补上那一次重登。记账（`attempted`）的规则只有三条：
//   * 重登成功：留着，直到该 node 的设备请求**真的又成功**（`noteNodeQuerySuccess`）才解除。
//     期间再来的 401 一律 `skipped`，401 → 重登 → 401 不会转成死循环。
//   * 失败且需要用户介入（凭证 / 二次验证 / 没有会话钥）：留着，并把该 node 标未登录，
//     界面退回登录入口；用户登进去之后设备请求成功，记账随之解除。
//   * 其余失败（断网、限流、认不出的码、实现自己抛异常）：**当场解除**，否则面板上的
//     「重试」只会重发一次请求、再撞 401、再被 skip，用户永远退不出这个状态。
//
// 一次 401 就翻 `loggedIn` 是不行的：转发路径（直连/中转切换）会产生会话仍有效的 401，
// 就地登出会抽掉整棵子树再静默登回来，表现为设备卡片闪断。

import { isCredentialFailure } from '@/auth/login-errors';
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

/**
 * 这次重登失败需要用户亲自介入吗？为真才把该 node 标未登录（界面退回登录入口）。
 *
 * 白名单而不是黑名单：`RATE_LIMITED`、`CHALLENGE_EXPIRED` 这类**临时**的服务端结论，以及
 * 任何认不出的码，都不该把整棵 node 子树抽掉——限流窗口里登出再自动登回来只会把限流撞得更死。
 * 凭证本身不可用的那批码由 `isCredentialFailure` 判定，与登录页共用同一份定义。
 */
export function needsUserSignIn(code: string | undefined): boolean {
  if (!code) return false;
  return INTERACTION_REQUIRED.has(code) || isCredentialFailure(code);
}

/** 重发多少次都不会变的失败：会话钥没了、要补二次验证、节点公钥对不上。 */
const INTERACTION_REQUIRED = new Set<string>([
  'NO_SESSION_KEY',
  'TOTP_REQUIRED',
  'TOTP_CODE_REQUIRED',
  'TOTP_INVALID',
  'PASSKEY_REQUIRED',
  'PASSKEY_VERIFY_FAILED',
  'PASSKEY_ABORTED',
  'PASSKEY_CREDENTIAL_UNKNOWN',
  'NO_PASSKEY_FOR_ORIGIN',
  'NODE_PK_MISMATCH',
]);

const attempted = new Set<string>();
const inFlight = new Map<string, Promise<NodeSessionRecoveryOutcome>>();
const lastSuccessAt = new Map<string, number>();

function silentNodeLogin(nodeId: string): Promise<{ ok: boolean; code?: string }> {
  return import('@/auth/session-key-store').then((mod) => mod.ensureNodeLogin(nodeId));
}

/** 重登落定后的记账与登出判定，返回给调用方的结论。 */
function settleLogin(
  nodeId: string,
  result: { ok: boolean; code?: string },
  deps: NodeSessionRecoveryDeps
): NodeSessionRecoveryOutcome {
  if (result.ok) {
    deps.onRecovered?.();
    return 'recovered';
  }
  if (needsUserSignIn(result.code)) {
    (deps.markLoggedOut ?? markLoggedOut)(nodeId);
    return 'failed';
  }
  attempted.delete(nodeId);
  return 'failed';
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

  const task = (deps.login ?? silentNodeLogin)(nodeId)
    .then((result) => settleLogin(nodeId, result, deps))
    .catch((): NodeSessionRecoveryOutcome => {
      // 实现自己抛异常（chunk 拉不下来之类）同样是临时故障：让用户点重试还能再来一次。
      attempted.delete(nodeId);
      return 'failed';
    })
    .finally(() => {
      inFlight.delete(nodeId);
    });
  inFlight.set(nodeId, task);
  return task;
}

/**
 * 该 node 的设备请求**又成功了一次**：解除记账，下一轮会话失效可以再自愈。
 *
 * 判据是 react-query 的 `dataUpdatedAt` 前进，而不是「有没有数据」：后台刷新失败时
 * react-query 会留着上一次的数据，只看有无数据等于永远认为「已经成功过」，记账再也解不开，
 * 该 node 之后每一次会话失效都会被 `skipped` 卡死。
 */
export function noteNodeQuerySuccess(nodeId: string, dataUpdatedAt: number): void {
  if (dataUpdatedAt <= 0 || lastSuccessAt.get(nodeId) === dataUpdatedAt) return;
  lastSuccessAt.set(nodeId, dataUpdatedAt);
  attempted.delete(nodeId);
}

/** 仅测试使用：清掉记账、在途的重登与成功水位。 */
export function resetNodeSessionRecoveryForTest(): void {
  attempted.clear();
  inFlight.clear();
  lastSuccessAt.clear();
}
