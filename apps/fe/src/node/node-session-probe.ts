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
//
// 门必须留出口，否则一台被判打不通的 node 会有整整 10 分钟**任何**读都发不出去，
// 而用户点「重试」走的是 react-query 的 `refetch()`——它绕得过 `enabled`，绕不过门。
// 出口只有一条，也只需要一条：**就地解除**（`clearNodeBackoff(nodeId)`）。调用它的地方是
// 明确的用户意图——包内重试按钮（经 `runtime.releaseRequestBackoff` 钩子）、节点管理页刷新、
// hub 手动刷新、登录成功、页面重新可见 / 网络恢复、以及该 node 被报成重新上线。
//
// 刻意**不留**「退避窗口里每隔 N 秒放一发探路请求」那种自动出口：探路失败会再记一次退避，
// 指数退避当场被拉平成固定周期（20 秒一发，每发还占着转发器 5 秒链路），
// 与「打不通的节点最多 10 分钟碰一次」的目标正好相反。

import {
  ApiClient,
  type FetchLike,
  createNodeApiClient,
  fetchDevices,
  isNodeLoginRequiredError,
  isSelfNode,
  nodePathPrefix,
  sessionProbeTimeoutMs,
} from '@vibeterm/api-client';
import type { NodeSessionProbe } from '@vibeterm/stores/node-session-guard';
import {
  NodeBackoffSkippedError,
  isNodeRequestBlocked,
  noteNodeReachable,
  noteNodeRequestOutcome,
} from './node-unreachable-backoff';

/** 探测超时下限：无 EWMA 时 8s，高 RTT 由 `sessionProbeTimeoutMs` 放大到 30s。 */
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
const gatedClients = new Map<string, ApiClient>();

/** 同一 node 复用一个实例：运行时与会话探测共享延迟 EWMA，探测超时才有观测可依。 */
export function createGatedNodeApiClient(nodeId: string): ApiClient {
  if (isSelfNode(nodeId)) return createNodeApiClient(nodeId);
  const cached = gatedClients.get(nodeId);
  if (cached) return cached;
  const client = buildGatedNodeApiClient(nodeId);
  gatedClients.set(nodeId, client);
  return client;
}

/**
 * 丢掉全部缓存的带门客户端。**只在会话被明确作废时调用**（登出 / 换账号 / 凭证重置）：
 * 缓存实例身上挂着上一个会话的延迟 EWMA，换账号后继续用它去推探测超时是拿错账本；
 * 实例本身也不该跨账号活着。会话到期后的静默重登不走这条路（那不是换账号）。
 */
export function resetGatedNodeApiClients(): void {
  gatedClients.clear();
}

function buildGatedNodeApiClient(nodeId: string): ApiClient {
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
  // 每 node 客户端（带退避门）。超时按该实例 EWMA 放大；新实例尚无观测时退化为 8s。
  const client = createGatedNodeApiClient(nodeId);
  try {
    await fetchDevices(client, {
      signal: AbortSignal.timeout(sessionProbeTimeoutMs(client.lastLatencyMs())),
    });
    noteNodeReachable(nodeId);
    return 'ok';
  } catch (error) {
    noteNodeRequestOutcome(nodeId, error);
    return isNodeLoginRequiredError(error) ? 'login-required' : 'unreachable';
  }
}
