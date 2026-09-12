// 打不通的 node 不该继续按原速重试。
//
// 每 node 的 REST 走入口的 `/n/<id>` 转发器，目标不可达时它要等满链路截止（5 秒）才回
// 503 `NODE_UNREACHABLE`。而界面上重复发的那几条（设备列表、hub 管理面轮询）各有各的节奏，
// 一台离线的 node 于是被稳定地按原速轰下去：请求全额付出，答案永远是同一句。
//
// 这里给「打不通」记一份每 node 的退避：超时类 2–5 秒抖动起步、硬失败（no_link / offline）
// 更长，逐次翻倍，封顶 10 分钟；退避窗口内该 node 的重复 GET 由 `node-runtimes` 的门
// （`createGatedNodeApiClient`）就地短路，不进网络。
// 解除只认三件事——**又成功了一次**、`/api/mesh/nodes` 报出这台 node 从离线转成在线、
// 页面重新可见 / 网络恢复。
//
// 只针对「根本没问到」的失败：服务端应答过的 401 / 4xx / 5xx 业务错误各有各的处置，
// 主动取消（切路由、组件卸载）更不是故障。
//
// `self` 永远豁免：entry 就是浏览器直连的那台，网关重启期间挡住它自己的设备列表，
// 换来的只是一个连本地都刷不出来的界面。

import { ApiError, isSelfNode } from '@vibeterm/api-client';
import { useEffect, useSyncExternalStore } from 'react';
import { onPageRecovery } from './mesh-recovery';

/** 超时类第一次退避下限（再叠加抖动）。 */
export const BACKOFF_FIRST_MS = 2_000;

/** 超时类第一次退避上限。 */
export const BACKOFF_FIRST_MAX_MS = 5_000;

/** 硬失败（no_link / 离线）第一次退避。 */
export const BACKOFF_HARD_FIRST_MS = 15_000;

/** 退避上限。 */
export const BACKOFF_MAX_MS = 600_000;

const HARD_UNREACHABLE_REASONS = new Set(['no_link', 'not_admitted', 'relay_reset:offline']);

/** 转发器打不通目标 node 时的契约错误码。 */
const NODE_UNREACHABLE_CODE = 'NODE_UNREACHABLE';

interface BackoffEntry {
  failures: number;
  blocked: boolean;
  /** 退避窗口的到期时刻（用于算「还要等多久」）。 */
  until: number;
  timer: unknown;
  /** 上一次实际用的延迟，下一次翻倍的基数。 */
  lastDelay: number;
  /** 最近一次 503 的 reason（给 UI 插值）。 */
  reason: string | null;
}

export type UnreachableBackoffKind = 'timeout' | 'hard';

export interface BackoffTimers {
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  now: () => number;
  /** `[0, 1)`，用于首次超时退避抖动；缺省 `Math.random`。 */
  random?: () => number;
}

const realTimers: BackoffTimers = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  random: Math.random,
};

let timers: BackoffTimers = realTimers;
const entries = new Map<string, BackoffEntry>();
/** 每 node 最近一次成功 / 失败的 react-query 水位（同一份缓存有多个观察者）。 */
const lastSuccessAt = new Map<string, number>();
const lastErrorAt = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * 退避窗口里被就地短路的请求：它连网络都没碰，绝不能再算一次失败去加倍退避。
 * 携带 `NODE_UNREACHABLE` 码是给调用方看的——语义上它就是「这台 node 现在打不通」。
 */
export class NodeBackoffSkippedError extends ApiError {
  readonly skippedByBackoff = true;

  constructor(nodeId: string) {
    super(503, NODE_UNREACHABLE_CODE, {
      code: NODE_UNREACHABLE_CODE,
      nodeId,
      reason: entries.get(nodeId)?.reason ?? null,
    });
    this.name = 'NodeBackoffSkippedError';
  }
}

function errorCode(error: Error): string | null {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * 这次失败属于「根本没问到」吗。
 *
 * 判定用**白名单**：转发器的 `NODE_UNREACHABLE`、超时，以及连 `status` 都没有的传输层异常。
 * 带 `status` 的一律不算——`ApiError`、`HubApiError` 那些是服务端答过话的结论（401 要登录、
 * 500 是对端出错），拿来加倍退避只会把能修的问题拖成打不通。
 */
export function isUnreachableFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // 门自己短路出来的错误：没发过请求，不构成新的证据。
  if (error instanceof NodeBackoffSkippedError) return false;
  if (errorCode(error) === NODE_UNREACHABLE_CODE) return true;
  // 调用方主动取消（切路由、组件卸载）不是故障；超时则是实打实的打不通。
  if (error.name === 'AbortError') return false;
  if (error.name === 'TimeoutError') return true;
  return !('status' in error);
}

function entryOf(nodeId: string): BackoffEntry {
  let entry = entries.get(nodeId);
  if (!entry) {
    entry = { failures: 0, blocked: false, until: 0, timer: null, lastDelay: 0, reason: null };
    entries.set(nodeId, entry);
  }
  return entry;
}

function errorReason(error: unknown): string | null {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' && reason !== '' ? reason : null;
}

/** 超时 / link_lost 走短退避；no_link、离线、未接纳走长退避。无 reason 的 503 按超时（冷拨常见）。 */
export function unreachableBackoffKind(error: unknown): UnreachableBackoffKind {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  const reason = errorReason(error);
  if (reason && HARD_UNREACHABLE_REASONS.has(reason)) return 'hard';
  return 'timeout';
}

function jitterMs(min: number, max: number): number {
  const span = Math.max(0, max - min);
  const unit = timers.random?.() ?? Math.random();
  return min + Math.floor(unit * (span + 1));
}

function nextBackoffDelayMs(entry: BackoffEntry, kind: UnreachableBackoffKind): number {
  if (entry.lastDelay > 0) return Math.min(entry.lastDelay * 2, BACKOFF_MAX_MS);
  if (kind === 'hard') return BACKOFF_HARD_FIRST_MS;
  return jitterMs(BACKOFF_FIRST_MS, BACKOFF_FIRST_MAX_MS);
}

/** 记一次「打不通」并进入退避；同一 node 连续失败逐次翻倍。`self` 不参与。 */
export function noteNodeUnreachable(nodeId: string, error?: unknown): void {
  if (isSelfNode(nodeId)) return;
  const entry = entryOf(nodeId);
  if (entry.timer !== null) timers.cancel(entry.timer);
  entry.failures += 1;
  entry.blocked = true;
  entry.reason = errorReason(error) ?? entry.reason;
  const delay = nextBackoffDelayMs(entry, unreachableBackoffKind(error));
  entry.lastDelay = delay;
  entry.until = timers.now() + delay;
  entry.timer = timers.schedule(() => {
    entry.timer = null;
    entry.blocked = false;
    entry.until = 0;
    notify();
  }, delay);
  notify();
}

/** 这台 node 又答上话了：退避连同失败计数一起清掉。 */
export function noteNodeReachable(nodeId: string): void {
  clearNodeBackoff(nodeId);
}

export function clearNodeBackoff(nodeId: string): void {
  const entry = entries.get(nodeId);
  if (!entry) return;
  if (entry.timer !== null) timers.cancel(entry.timer);
  entries.delete(nodeId);
  if (entry.blocked) notify();
}

/** 按一次请求的结果记账：`error` 为空即成功。 */
export function noteNodeRequestOutcome(nodeId: string, error: unknown): void {
  if (isSelfNode(nodeId)) return;
  if (error === null || error === undefined) {
    noteNodeReachable(nodeId);
    return;
  }
  if (isUnreachableFailure(error)) noteNodeUnreachable(nodeId, error);
}

/** 该 node 此刻在退避窗口里（重复请求应当跳过）。`self` 永远为 false。 */
export function isNodeRequestBlocked(nodeId: string): boolean {
  if (isSelfNode(nodeId)) return false;
  return entries.get(nodeId)?.blocked === true;
}

/** 退避窗口还剩多久（毫秒）；没在退避里为 0。 */
export function nodeBackoffRemainingMs(nodeId: string): number {
  const entry = entries.get(nodeId);
  if (!entry?.blocked) return 0;
  return Math.max(0, entry.until - timers.now());
}

/** 最近一次打不通的 reason；没在记账里为 null。已有 UI 用 `{{reason}}` 插值。 */
export function nodeUnreachableReason(nodeId: string): string | null {
  return entries.get(nodeId)?.reason ?? null;
}

export function subscribeNodeBackoff(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 该 node 的查询**又成功了一次**（react-query 的 `dataUpdatedAt` 前进）：解除退避。
 * 判据是「前进」而不是「有数据」：同一个 node 的多份 provider 共用一份缓存，
 * 只看有没有数据会让任何一次挂载都把刚记下的退避抹掉。
 */
export function noteNodeQuerySuccessAt(nodeId: string, dataUpdatedAt: number): void {
  if (dataUpdatedAt <= 0) return;
  if (dataUpdatedAt <= (lastSuccessAt.get(nodeId) ?? 0)) return;
  lastSuccessAt.set(nodeId, dataUpdatedAt);
  noteNodeReachable(nodeId);
}

/**
 * 该 node 的查询**又失败了一次**。水位与成功侧对称：react-query 会把失败的 error 对象连同
 * `errorUpdatedAt` 一起留在缓存里，同一个 node 的第二份 provider 挂上来（或任何一次重挂）
 * 都会拿到同一个 error。只看 error 身份就会把一次失败记成两次，退避直接翻倍。
 */
export function noteNodeQueryErrorAt(nodeId: string, error: unknown, errorUpdatedAt: number): void {
  if (!error || errorUpdatedAt <= 0) return;
  if (errorUpdatedAt <= (lastErrorAt.get(nodeId) ?? 0)) return;
  lastErrorAt.set(nodeId, errorUpdatedAt);
  noteNodeRequestOutcome(nodeId, error);
}

/** 把一条每 node 查询的成败接到退避上（设备列表用）。 */
export function useNodeReachabilityFromQuery(
  nodeId: string,
  query: { error: unknown; dataUpdatedAt: number; errorUpdatedAt: number }
): void {
  const { error, dataUpdatedAt, errorUpdatedAt } = query;
  useEffect(() => {
    if (isSelfNode(nodeId)) return;
    noteNodeQuerySuccessAt(nodeId, dataUpdatedAt);
  }, [nodeId, dataUpdatedAt]);
  useEffect(() => {
    if (isSelfNode(nodeId)) return;
    noteNodeQueryErrorAt(nodeId, error, errorUpdatedAt);
  }, [nodeId, error, errorUpdatedAt]);
}

/** 退避态的 React 绑定：窗口一到期查询自动放行。 */
export function useNodeRequestBlocked(nodeId: string): boolean {
  return useSyncExternalStore(
    subscribeNodeBackoff,
    () => isNodeRequestBlocked(nodeId),
    () => false
  );
}

/**
 * `/api/mesh/nodes` 报出某台 node **从离线转成在线**：链路刚回来，退避不该再挡着。
 * 判据必须是「转变」而不是「当前在线」：真正打不通的那台往往仍被列表报成在线，
 * 每次刷新都清一遍等于退避从来没生效过。
 */
export function noteMeshNodesOnline(
  previous: readonly { id: string; online?: boolean }[],
  next: readonly { id: string; online?: boolean }[]
): void {
  if (entries.size === 0) return;
  const before = new Map(previous.map((node) => [node.id, node.online === true]));
  for (const node of next) {
    if (node.online !== true) continue;
    if (before.get(node.id) === true) continue;
    clearNodeBackoff(node.id);
  }
}

/** 页面重新可见 / 网络恢复：整份退避作废，各条请求重新试一次。 */
export function clearAllNodeBackoff(): void {
  for (const nodeId of [...entries.keys()]) clearNodeBackoff(nodeId);
}

/** 仅测试使用：替换定时器实现（传 null 恢复真实定时器）并清空记账。 */
export function setNodeBackoffTimersForTest(next: BackoffTimers | null): void {
  clearAllNodeBackoff();
  entries.clear();
  lastSuccessAt.clear();
  lastErrorAt.clear();
  timers = next ?? realTimers;
}

// 页面重新可见 / 网络恢复本身就是「链路可能刚回来」的信号，退避到此为止。
onPageRecovery(clearAllNodeBackoff);
