// 「这台 node 现在该显示成什么」的唯一判定。侧边栏、设备页分组、节点管理表共用。
//
// 拆出来的原因是三处此前各算各的，而且都只看 `loggedIn`：`/api/mesh/nodes` 的 `loggedIn`
// 其实只表示「这只浏览器有没有 `vibeterm_s_<nodeId>` 这只 cookie」，链路抖动时它照样是 true，
// 于是传输层故障被一路呈现成「未登录 / 登录失败」。这里把「打不通」单列一档。

import { classifyNodeLoginFailure } from './login-failure-kind';

export type NodeSignInState =
  /** 节点本身离线。 */
  | 'offline'
  /** 节点报在线，但这一侧根本问不到它（登录打不通，或 REST 正在退避）。 */
  | 'unreachable'
  /** 确实没有该节点的会话，需要用户登录。 */
  | 'signedOut'
  /** 可以直接用。 */
  | 'ready';

export interface NodeSignInInput {
  online: boolean;
  loggedIn: boolean;
  /** 最近一次登录失败的码；没失败过给 `null`。 */
  failureCode?: string | null;
  /** 该 node 的 REST 正处在「打不通」退避窗口里。 */
  unreachable?: boolean;
}

/**
 * 「打不通」排在 `loggedIn` 之前：`loggedIn` 只是一只 cookie 在不在，链路断了它照样是 true。
 * 手上有实证说这台问不到（登录败在传输层，或它的 REST 正在退避）时，说「连接不上」才是真话。
 */
export function nodeSignInState(input: NodeSignInInput): NodeSignInState {
  if (!input.online) return 'offline';
  if (input.unreachable === true) return 'unreachable';
  if (classifyNodeLoginFailure(input.failureCode) === 'unreachable') return 'unreachable';
  return input.loggedIn ? 'ready' : 'signedOut';
}
