// 打不通的 node 不该继续按原速重试。
//
// 每 node 的 REST 走入口的 `/n/<id>` 转发器，目标不可达时它要等满链路截止（5 秒）才回
// 503 `NODE_UNREACHABLE`。而界面上重复发的那几条（设备列表、hub 管理面轮询）各有各的节奏，
// 一台离线的 node 于是被稳定地按原速轰下去：请求全额付出，答案永远是同一句。
//
// 这里给「打不通」记一份每 node 的退避：1 分钟起步，逐次翻倍，封顶 10 分钟；退避窗口内
// 该 node 的重复请求整条跳过。解除只认两件事——**又成功了一次**，或 `/api/mesh/nodes` 报出
// 这台 node 从离线转成在线（页面重新可见 / 网络恢复同样解除，那多半正是链路刚回来）。
//
// 只针对「根本没问到」的失败：服务端明确应答过的 401 / 5xx 业务错误不算，它们各有各的处置。

import { ApiError, isNodeUnreachableError } from '@vibeterm/api-client';
import { useEffect, useSyncExternalStore } from 'react';
import { onPageRecovery } from './mesh-recovery';

/** 第一次退避时长。 */
export const BACKOFF_FIRST_MS = 60_000;

/** 退避上限。 */
export const BACKOFF_MAX_MS = 600_000;

interface BackoffEntry {
  failures: number;
  blocked: boolean;
  timer: unknown;
}

export interface BackoffTimers {
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
}

const realTimers: BackoffTimers = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

let timers: BackoffTimers = realTimers;
const entries = new Map<string, BackoffEntry>();
/** 每 node 最近一次成功的 `dataUpdatedAt` 水位。 */
const lastSuccessAt = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** 这次失败属于「根本没问到」吗：转发器的 503 与传输层异常算，服务端的业务错误不算。 */
export function isUnreachableFailure(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if (isNodeUnreachableError(error)) return true;
  // 应答过就说明链路是通的（401、404、5xx 业务错误各有各的处置）。
  if (error instanceof ApiError) return false;
  // 调用方主动取消（切路由、组件卸载）不是故障。
  if (error instanceof Error && error.name === 'AbortError') return false;
  return error instanceof Error;
}

function entryOf(nodeId: string): BackoffEntry {
  let entry = entries.get(nodeId);
  if (!entry) {
    entry = { failures: 0, blocked: false, timer: null };
    entries.set(nodeId, entry);
  }
  return entry;
}

/** 记一次「打不通」并进入退避；同一 node 连续失败逐次翻倍。 */
export function noteNodeUnreachable(nodeId: string): void {
  const entry = entryOf(nodeId);
  if (entry.timer !== null) timers.cancel(entry.timer);
  entry.failures += 1;
  entry.blocked = true;
  const delay = Math.min(BACKOFF_FIRST_MS * 2 ** (entry.failures - 1), BACKOFF_MAX_MS);
  entry.timer = timers.schedule(() => {
    entry.timer = null;
    entry.blocked = false;
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
  if (error === null || error === undefined) {
    noteNodeReachable(nodeId);
    return;
  }
  if (isUnreachableFailure(error)) noteNodeUnreachable(nodeId);
}

/** 该 node 此刻在退避窗口里（重复请求应当跳过）。 */
export function isNodeRequestBlocked(nodeId: string): boolean {
  return entries.get(nodeId)?.blocked === true;
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

/** 把一条每 node 查询的成败接到退避上（设备列表用）。 */
export function useNodeReachabilityFromQuery(
  nodeId: string,
  error: unknown,
  dataUpdatedAt: number
): void {
  useEffect(() => {
    noteNodeQuerySuccessAt(nodeId, dataUpdatedAt);
  }, [nodeId, dataUpdatedAt]);
  useEffect(() => {
    if (error) noteNodeRequestOutcome(nodeId, error);
  }, [nodeId, error]);
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
  timers = next ?? realTimers;
}

// 页面重新可见 / 网络恢复本身就是「链路可能刚回来」的信号，退避到此为止。
onPageRecovery(clearAllNodeBackoff);
