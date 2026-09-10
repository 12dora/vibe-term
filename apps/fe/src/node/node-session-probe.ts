// WS 4401 之后那一次「会话还在吗」的探测（宿主实现），以及每 node REST 的退避门。
//
// 与 `@vibeterm/stores` 里的缺省探测的区别只有两点，都来自宿主才知道的事：
//   * 这台 node 正在退避窗口里就**不发**探测——它刚被证明打不通，再发一次只是白等
//     转发器的 5 秒链路截止；
//   * 探测的成败要回喂退避记账，与设备列表那条共用同一份。
//
// 门（`createGatedNodeApiClient`）挂在每 node 运行时的 ApiClient 上：设备列表在包内有多个
// 观察者（侧栏树、统计、文件页、控制台），react-query 的 `enabled` 是**按观察者**算的，
// 只在 provider 那一份上关掉根本拦不住请求。挡在客户端这一层才是唯一的收口。
// 只挡 GET / HEAD：写操作是用户主动发起的，永远放行，成功了还顺手解除退避。

import {
  ApiClient,
  type FetchLike,
  createNodeApiClient,
  fetchDevices,
  isNodeLoginRequiredError,
  isSelfNode,
  nodePathPrefix,
} from '@vibeterm/api-client';
import type { NodeSessionProbe } from '@vibeterm/stores/node-session-guard';
import {
  NodeBackoffSkippedError,
  isNodeRequestBlocked,
  noteNodeReachable,
  noteNodeRequestOutcome,
} from './node-unreachable-backoff';

/** 探测的自备超时：转发器的链路截止是 5 秒，留一点余量就该收手。 */
export const SESSION_PROBE_TIMEOUT_MS = 8_000;

/** 只有幂等读请求才受退避门约束。 */
function isIdempotentRead(init?: RequestInit): boolean {
  const method = (init?.method ?? 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD';
}

/**
 * 带退避门的每 node REST 客户端：退避窗口里的 GET 就地短路（不进网络），
 * 其余请求照常发出并把成败记进退避。`self` 不设门。
 */
export function createGatedNodeApiClient(nodeId: string): ApiClient {
  if (isSelfNode(nodeId)) return createNodeApiClient(nodeId);
  const transport: FetchLike = (url, init) => {
    if (isIdempotentRead(init) && isNodeRequestBlocked(nodeId)) {
      return Promise.reject(new NodeBackoffSkippedError(nodeId));
    }
    return fetch(url, init).then(
      (res) => {
        // 2xx 才算「答上话了」：转发器打不通目标时回的也是一个正常的 HTTP 响应（503）。
        if (res.ok) noteNodeReachable(nodeId);
        return res;
      },
      (error: unknown) => {
        noteNodeRequestOutcome(nodeId, error);
        throw error;
      }
    );
  };
  return new ApiClient(nodePathPrefix(nodeId), transport);
}

/**
 * 宿主版会话探测。退避窗口里直接给「打不通」——调用方（`NodeSessionGuard`）据此只重连、
 * 不动登录态，而重连的时机由退避剩余时长兜底。
 */
export async function probeNodeSession(nodeId: string): Promise<NodeSessionProbe> {
  if (isNodeRequestBlocked(nodeId)) return 'unreachable';
  try {
    await fetchDevices(createNodeApiClient(nodeId), {
      signal: AbortSignal.timeout(SESSION_PROBE_TIMEOUT_MS),
    });
    noteNodeReachable(nodeId);
    return 'ok';
  } catch (error) {
    noteNodeRequestOutcome(nodeId, error);
    return isNodeLoginRequiredError(error) ? 'login-required' : 'unreachable';
  }
}
