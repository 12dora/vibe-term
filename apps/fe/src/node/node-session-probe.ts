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
// 三条出口：
//   1. **显式标记**：`manualRead(init)` 给这一发请求打上标记（一个只在浏览器内部存在、
//      发出前就被摘掉的请求头），门直接放行。调用方明确知道这是用户点出来的读。
//   2. **探路名额**：退避窗口里每 `GATE_CANARY_INTERVAL_MS` 放行一发 GET。没打标记的
//      重试（包内面板的 `refetch()`）因此最多等这一档，而不是干等到退避结束。
//   3. **就地解除**：`clearNodeBackoff(nodeId)`（`node-unreachable-backoff`）——登录成功、
//      节点管理页刷新、hub 手动刷新、页面恢复都会调它。

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

/** 退避窗口里放行一发「探路」GET 的最小间隔。 */
export const GATE_CANARY_INTERVAL_MS = 20_000;

/**
 * 「这一发是用户点出来的读」的标记。它是一个请求头，但**永远不会被发出去**：
 * 门在放行前就把它摘掉。用请求头而不是 init 上的自定义字段，是因为 `RequestInit` 会被
 * `fetch` 原样透传，多带一个非标准字段在某些运行时里会被丢掉或报错。
 */
export const MANUAL_READ_HEADER = 'x-vibeterm-manual';

/** 给一发读请求打上「用户点的」标记：退避门直接放行。 */
export function manualRead(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(MANUAL_READ_HEADER, '1');
  return { ...init, headers };
}

/** 取出标记并把它从请求头里摘掉（返回的 init 可以直接发出去）。 */
function takeManualMark(init?: RequestInit): { manual: boolean; init?: RequestInit } {
  if (!init?.headers) return { ...(init ? { init } : {}), manual: false };
  const headers = new Headers(init.headers);
  if (!headers.has(MANUAL_READ_HEADER)) return { init, manual: false };
  headers.delete(MANUAL_READ_HEADER);
  return { init: { ...init, headers }, manual: true };
}

/** 只有幂等读请求才受退避门约束。 */
function isIdempotentRead(init?: RequestInit): boolean {
  const method = (init?.method ?? 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD';
}

let gateNow: () => number = () => Date.now();
const lastCanaryAt = new Map<string, number>();

/** 领一次探路名额；同一 node 每 `GATE_CANARY_INTERVAL_MS` 只有一发。 */
function claimCanary(nodeId: string): boolean {
  const at = gateNow();
  if (at - (lastCanaryAt.get(nodeId) ?? Number.NEGATIVE_INFINITY) < GATE_CANARY_INTERVAL_MS) {
    return false;
  }
  lastCanaryAt.set(nodeId, at);
  return true;
}

/** 仅测试使用：替换门的时钟并清掉探路名额。 */
export function setGateClockForTest(now: (() => number) | null): void {
  lastCanaryAt.clear();
  gateNow = now ?? (() => Date.now());
}

/**
 * 带退避门的每 node REST 客户端：退避窗口里的 GET 就地短路（不进网络），
 * 其余请求照常发出并把成败记进退避。`self` 不设门。
 */
export function createGatedNodeApiClient(nodeId: string): ApiClient {
  if (isSelfNode(nodeId)) return createNodeApiClient(nodeId);
  const transport: FetchLike = (url, rawInit) => {
    const { manual, init } = takeManualMark(rawInit);
    // 用户点出来的读永远放行；其余读在退避窗口里只有探路名额放得过去。
    if (!manual && isIdempotentRead(init) && isNodeRequestBlocked(nodeId) && !claimCanary(nodeId)) {
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
