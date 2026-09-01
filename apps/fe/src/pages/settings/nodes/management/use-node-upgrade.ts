// 节点升级：latest 版本查询 + 每节点一份的升级状态机。
//
// 升级由目标节点自己的网关执行，执行阶段它会被替换并重启——轮询打不通目标是**预期现象**，
// 不能当失败。因此状态机的判定链是：
//   POST → 见过非 idle（downloading / executing）→ 掉线 / 回到 idle → 刷新节点列表比版本。
// 只有版本对上（或时间预算内目标重新可达且 latest 未知）才算成功；预算耗尽只提示「未确认」，
// 让用户自己刷新核对，绝不猜一个结论。
//
// POST 一律不重试：目标可能已经开始升级却来不及回包，重发会撞上 `UPGRADE_IN_PROGRESS`。
// 同理，POST 的网络异常与 `NODE_UNREACHABLE` 都不是失败结论，只说明「结果未知」，要走轮询确认。
//
// 状态只活在 React 里，刷新页面就没了，而升级还在目标机上跑：因此挂载时要按行回读
// `GET /api/mesh/nodes/:id/upgrade`，非 idle 的行直接接上轮询（`resumeNodeUpgrade`）。
//
// 每一行一把 `AbortController`（`createNodeAbortRegistry`）：按「停止升级」只掐这一行的轮询，
// 不波及同批的其他节点；组件卸载时一把全停，之后不再 toast / 刷新 / 轮询。

import { type NodeRow, getMeshNodesState, refreshMeshNodes } from '@/node/mesh-nodes';
import { defaultApiClient } from '@tmex/api-client';
import { UPGRADE_CANCELLED, type UpgradeStatus } from '@tmex/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  IDLE_UPGRADE_BATCH,
  IDLE_UPGRADE_ENTRY,
  type NodeUpgradeBatchState,
  type NodeUpgradeController,
  type NodeUpgradeEntry,
  type NodeUpgradeLatest,
  type NodeUpgradePhase,
  type UpgradeRunOutcome,
} from './types';
import {
  MIN_REMOTE_UPGRADE_VERSION,
  type UpgradeBatchSummary,
  eligibleUpgradeRows,
  runUpgradeBatch,
} from './upgrade-batch';

export { MIN_REMOTE_UPGRADE_VERSION };

const POLL_MS = 2000;
/** 下载 + 解包 + 重启 + 版本回传的总预算。 */
const BUDGET_MS = 6 * 60_000;
/** POST 之后目标迟迟不进入非 idle：判定没真正开始，不要空等满预算。 */
const START_GRACE_MS = 30_000;
/** 刷新后回读各节点升级状态的并发上限。 */
export const RESTORE_CONCURRENCY = 3;

/** 后端取消升级后留在 idle 状态上的标记；FE 必须按「已取消」而不是失败处理。 */
export const UPGRADE_CANCELLED_ERROR: string = UPGRADE_CANCELLED;

type Translate = (key: string, options?: Record<string, unknown>) => string;

const ERROR_KEYS: Record<string, string> = {
  NODE_LOGIN_REQUIRED: 'nodes.upgrade.loginRequired',
  NODE_UNREACHABLE: 'nodes.upgrade.unreachable',
  NOT_FOUND: 'nodes.upgrade.nodeGone',
  UPGRADE_NOT_ALLOWED: 'nodes.upgrade.notAllowed',
  UPGRADE_IN_PROGRESS: 'nodes.upgrade.inProgress',
  UPGRADE_UNSUPPORTED: 'nodes.upgrade.unsupported',
  RELEASE_UNAVAILABLE: 'nodes.upgrade.releaseUnavailable',
};

/** 轮询期间必须立刻收尾的业务错误：节点被吊销、会话失效、目标压根不支持升级。 */
const DEFINITIVE_POLL_CODES = new Set([
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NODE_LOGIN_REQUIRED',
  'UPGRADE_NOT_ALLOWED',
  'UPGRADE_UNSUPPORTED',
]);

/**
 * 轮询拿到非 2xx 时该重试还是收尾。
 * 5xx（502/503/504 等）是入口转发不到目标，也就是「重启中」的常态，继续等；
 * 4xx 与明确的业务码是确定性结论，再等六分钟只会给用户一个牛头不对马嘴的超时提示。
 */
export function classifyPollFailure(status: number, code: string): 'retry' | 'definitive' {
  if (DEFINITIVE_POLL_CODES.has(code)) return 'definitive';
  return status >= 500 ? 'retry' : 'definitive';
}

/** 可取消的等待：正常走完返回 `true`，被取消返回 `false`（timer 同步清掉）。 */
function waitFor(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function readCode(res: Response): Promise<string> {
  try {
    const payload = (await res.json()) as { code?: unknown; error?: unknown };
    if (typeof payload.code === 'string') return payload.code;
    if (typeof payload.error === 'string') return payload.error;
  } catch {
    // 落到通用码
  }
  return 'UPGRADE_FAILED';
}

export async function fetchUpgradeLatest(): Promise<NodeUpgradeLatest | null> {
  const res = await defaultApiClient.fetch('/api/mesh/upgrade/latest');
  if (!res.ok) return null;
  const payload = (await res.json()) as Partial<NodeUpgradeLatest>;
  if (typeof payload.latestVersion !== 'string' || !payload.latestVersion) return null;
  return {
    latestVersion: payload.latestVersion,
    changelog: payload.changelog ?? null,
    publishedAt: payload.publishedAt ?? null,
  };
}

/** `unconfirmed`：POST 回包丢了，目标可能已经在升级——只能靠轮询与版本变化确认。 */
export type UpgradeStartOutcome =
  | { kind: 'started'; status: UpgradeStatus }
  | { kind: 'unconfirmed' }
  | { kind: 'alreadyLatest' }
  | { kind: 'failed'; code: string }
  | { kind: 'cancelled' };

/** `unreachable`：目标暂时打不通（网络异常 / 5xx），按「重启中」继续等。 */
export type UpgradePollOutcome =
  | { kind: 'status'; status: UpgradeStatus }
  | { kind: 'unreachable' }
  | { kind: 'failed'; code: string }
  | { kind: 'cancelled' };

/** `DELETE /api/mesh/nodes/:id/upgrade` 的两种结论；`httpStatus` 只用于诊断，判定一律看 `code`。 */
export type UpgradeCancelOutcome =
  | { kind: 'cancelled'; status: UpgradeStatus }
  | { kind: 'failed'; code: string; httpStatus: number };

/** 状态机与真实请求之间的接缝：单测注入假实现，不碰网络与计时器。 */
export interface UpgradeIo {
  start(nodeId: string, signal: AbortSignal): Promise<UpgradeStartOutcome>;
  /** 轮询与刷新后的状态回读共用同一个 GET。 */
  poll(nodeId: string, signal: AbortSignal): Promise<UpgradePollOutcome>;
  cancel(nodeId: string, signal: AbortSignal): Promise<UpgradeCancelOutcome>;
  /** 刷新节点列表后回读目标版本；节点已不在列表返回 `undefined`。 */
  nodeVersion(nodeId: string): Promise<string | null | undefined>;
  wait(ms: number, signal: AbortSignal): Promise<boolean>;
  now(): number;
}

async function requestUpgradeStart(
  nodeId: string,
  signal: AbortSignal
): Promise<UpgradeStartOutcome> {
  let res: Response;
  try {
    res = await defaultApiClient.fetch(`/api/mesh/nodes/${nodeId}/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal,
    });
  } catch {
    // 链路在回包前断掉：目标可能已经开始升级，绝不能报失败并重新放开按钮。
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'unconfirmed' };
  }
  if (res.ok) {
    try {
      return { kind: 'started', status: (await res.json()) as UpgradeStatus };
    } catch {
      return signal.aborted ? { kind: 'cancelled' } : { kind: 'unconfirmed' };
    }
  }
  const code = await readCode(res);
  if (signal.aborted) return { kind: 'cancelled' };
  if (code === 'UPGRADE_ALREADY_LATEST') return { kind: 'alreadyLatest' };
  // 入口转发不到目标时不会重试 POST，但目标可能已经收到并开始执行。
  if (code === 'NODE_UNREACHABLE') return { kind: 'unconfirmed' };
  return { kind: 'failed', code };
}

async function requestUpgradeStatus(
  nodeId: string,
  signal: AbortSignal
): Promise<UpgradePollOutcome> {
  let res: Response;
  try {
    res = await defaultApiClient.fetch(`/api/mesh/nodes/${nodeId}/upgrade`, { signal });
  } catch {
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'unreachable' };
  }
  if (res.ok) {
    try {
      return { kind: 'status', status: (await res.json()) as UpgradeStatus };
    } catch {
      return signal.aborted ? { kind: 'cancelled' } : { kind: 'unreachable' };
    }
  }
  const code = await readCode(res);
  if (signal.aborted) return { kind: 'cancelled' };
  if (classifyPollFailure(res.status, code) === 'retry') return { kind: 'unreachable' };
  return { kind: 'failed', code };
}

async function requestUpgradeCancel(
  nodeId: string,
  signal: AbortSignal
): Promise<UpgradeCancelOutcome> {
  let res: Response;
  try {
    res = await defaultApiClient.fetch(`/api/mesh/nodes/${nodeId}/upgrade`, {
      method: 'DELETE',
      signal,
    });
  } catch {
    return { kind: 'failed', code: 'NODE_UNREACHABLE', httpStatus: 0 };
  }
  if (res.ok) {
    try {
      return { kind: 'cancelled', status: (await res.json()) as UpgradeStatus };
    } catch {
      // 回包读不出来不影响结论：200 就是已取消。
      return {
        kind: 'cancelled',
        status: {
          state: 'idle',
          targetVersion: null,
          error: UPGRADE_CANCELLED_ERROR,
          startedAt: null,
        },
      };
    }
  }
  return { kind: 'failed', code: await readCode(res), httpStatus: res.status };
}

async function readNodeVersion(nodeId: string): Promise<string | null | undefined> {
  await refreshMeshNodes();
  const node = getMeshNodesState().nodes.find((item) => item.id === nodeId);
  return node ? (node.version ?? null) : undefined;
}

export const defaultUpgradeIo: UpgradeIo = {
  start: requestUpgradeStart,
  poll: requestUpgradeStatus,
  cancel: requestUpgradeCancel,
  nodeVersion: readNodeVersion,
  wait: waitFor,
  now: () => Date.now(),
};

export interface UpgradeWatchContext {
  nodeId: string;
  targetVersion: string | null;
  /** POST 回包里目标已在非 idle：升级确实转起来了。 */
  sawActive: boolean;
  /** POST 回包丢失：没见过 downloading / executing，只能拿版本变化当唯一证据。 */
  unconfirmedStart: boolean;
  io: UpgradeIo;
  signal: AbortSignal;
  describeError: (code: string) => string;
  phase: (phase: NodeUpgradePhase) => void;
}

/** `stopped`：目标已被中断（`error === 'UPGRADE_CANCELLED'`），是良性结论，不能报失败。 */
export type UpgradeWatchResult =
  | { kind: 'done' }
  | { kind: 'failed'; error: string }
  | { kind: 'timeout' }
  | { kind: 'stopped' }
  | { kind: 'cancelled' };

/**
 * 刷新节点列表比对版本：升级成功唯一可信的证据（升级状态不跨进程持久化）。
 * `strict` 用于「没见过升级过程」的分支——此时 latest 未知就无从判断，绝不能猜成功。
 */
async function versionConfirmed(ctx: UpgradeWatchContext, strict: boolean): Promise<boolean> {
  const version = await ctx.io.nodeVersion(ctx.nodeId);
  if (version === undefined) return false;
  if (!ctx.targetVersion) return !strict;
  return version === ctx.targetVersion;
}

/** 目标回到 idle 时的收尾判定；拿不准就返回 `null`，继续等下一轮。 */
async function settleIdle(
  ctx: UpgradeWatchContext,
  status: UpgradeStatus,
  sawActive: boolean,
  elapsed: number
): Promise<UpgradeWatchResult | null> {
  // 状态不跨进程持久化：重启回来后 error 一定是空的，所以 idle 上还挂着 error 就是下载阶段失败。
  if (status.error === UPGRADE_CANCELLED_ERROR) return { kind: 'stopped' };
  if (status.error) return { kind: 'failed', error: status.error };
  if (!sawActive) {
    // POST 结果未知：目标可能已经升完重启回来，版本对上就是成功。
    if (ctx.unconfirmedStart && (await versionConfirmed(ctx, true))) return { kind: 'done' };
    return elapsed > START_GRACE_MS ? { kind: 'timeout' } : null;
  }
  ctx.phase('restarting');
  return (await versionConfirmed(ctx, false)) ? { kind: 'done' } : null;
}

export async function watchUpgrade(ctx: UpgradeWatchContext): Promise<UpgradeWatchResult> {
  const startedAt = ctx.io.now();
  const deadline = startedAt + BUDGET_MS;
  let sawActive = ctx.sawActive;
  while (ctx.io.now() < deadline) {
    if (!(await ctx.io.wait(POLL_MS, ctx.signal))) return { kind: 'cancelled' };
    const poll = await ctx.io.poll(ctx.nodeId, ctx.signal);
    if (poll.kind === 'cancelled') return { kind: 'cancelled' };
    if (poll.kind === 'failed') {
      // 目标可能是升完重启才把会话弄丢的：版本对上就算成功，别把一次成功的升级判成失败。
      if (await versionConfirmed(ctx, true)) return { kind: 'done' };
      return { kind: 'failed', error: ctx.describeError(poll.code) };
    }
    if (poll.kind === 'unreachable') {
      ctx.phase(sawActive || ctx.unconfirmedStart ? 'restarting' : 'pending');
      continue;
    }
    const status = poll.status;
    if (status.state !== 'idle') {
      sawActive = true;
      ctx.phase(status.state);
      continue;
    }
    const settled = await settleIdle(ctx, status, sawActive, ctx.io.now() - startedAt);
    if (settled) return settled;
  }
  return { kind: 'timeout' };
}

/** sonner 的最小子集：单测注入 spy，避免真的弹 toast。 */
export interface UpgradeToasts {
  success: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
}

export interface UpgradeRunParams {
  row: Pick<NodeRow, 'id' | 'name'>;
  targetVersion: string | null;
  io: UpgradeIo;
  signal: AbortSignal;
  t: Translate;
  toasts: UpgradeToasts;
  patch: (entry: Partial<NodeUpgradeEntry>) => void;
  onChanged: () => void;
}

/** POST 的四种结论；只有「已开始」与「结果未知」要继续轮询。 */
function reportStart(
  p: UpgradeRunParams,
  started: Exclude<UpgradeStartOutcome, { kind: 'cancelled' }>
): UpgradeStatus | null {
  if (started.kind === 'alreadyLatest') {
    // 已是最新是良性结论，不当失败报。
    p.patch({ phase: 'idle', error: null });
    p.toasts.info(p.t('nodes.upgrade.alreadyLatest', { name: p.row.name }));
    return null;
  }
  if (started.kind === 'failed') {
    const error = upgradeErrorText(p.t, started.code);
    p.patch({ phase: 'failed', error });
    p.toasts.error(p.t('nodes.upgrade.failed', { error }));
    return null;
  }
  if (started.kind === 'unconfirmed') {
    // POST 结果未知：按「重启中」继续盯，按钮保持禁用，避免用户重复触发同一次升级。
    p.patch({ phase: 'restarting', targetVersion: p.targetVersion });
    p.toasts.warning(p.t('nodes.upgrade.startUnconfirmed', { name: p.row.name }));
    return null;
  }
  const version = started.status.targetVersion ?? p.targetVersion;
  p.patch({ phase: started.status.state, targetVersion: version });
  p.toasts.success(p.t('nodes.upgrade.started', { version: version ?? '' }));
  return started.status;
}

function reportResult(p: UpgradeRunParams, version: string | null, result: UpgradeWatchResult) {
  if (result.kind === 'done') {
    p.patch({ phase: 'done', error: null });
    p.toasts.success(p.t('nodes.upgrade.done', { name: p.row.name, version: version ?? '' }));
    p.onChanged();
    return;
  }
  if (result.kind === 'stopped') {
    // 别处（本页的停止按钮、另一个标签页）已经把这次升级掐了：回到静止态，不留失败痕迹。
    p.patch({ phase: 'idle', targetVersion: null, error: null });
    p.toasts.info(p.t('nodes.upgrade.cancelled', { name: p.row.name }));
    p.onChanged();
    return;
  }
  if (result.kind === 'failed') {
    p.patch({ phase: 'failed', error: result.error });
    p.toasts.error(p.t('nodes.upgrade.failed', { error: result.error }));
    return;
  }
  p.patch({ phase: 'failed', error: p.t('nodes.upgrade.timeout') });
  p.toasts.warning(p.t('nodes.upgrade.timeout'));
  p.onChanged();
}

function outcomeOf(result: UpgradeWatchResult): UpgradeRunOutcome {
  return result.kind === 'stopped' ? 'cancelled' : result.kind;
}

/** 一次升级的完整流程：POST → 轮询 → 结论。取消（组件卸载）后一律静默返回。 */
export async function runNodeUpgrade(p: UpgradeRunParams): Promise<UpgradeRunOutcome> {
  p.patch({ phase: 'pending', targetVersion: p.targetVersion, error: null });
  const started = await p.io.start(p.row.id, p.signal);
  if (started.kind === 'cancelled' || p.signal.aborted) return 'cancelled';
  const status = reportStart(p, started);
  if (!status && started.kind !== 'unconfirmed') {
    return started.kind === 'alreadyLatest' ? 'alreadyLatest' : 'failed';
  }
  const version = status?.targetVersion ?? p.targetVersion;
  const result = await watchUpgrade({
    nodeId: p.row.id,
    targetVersion: version,
    sawActive: status != null && status.state !== 'idle',
    unconfirmedStart: status == null,
    io: p.io,
    signal: p.signal,
    describeError: (code) => upgradeErrorText(p.t, code),
    phase: (phase) => p.patch({ phase }),
  });
  if (result.kind === 'cancelled' || p.signal.aborted) return 'cancelled';
  reportResult(p, version, result);
  return outcomeOf(result);
}

export interface UpgradeResumeParams extends UpgradeRunParams {
  /** 刷新时回读到的非 idle 状态。 */
  status: UpgradeStatus;
}

/**
 * 刷新页面后接上一次已经在跑的升级：先把回读到的阶段写回表格，再按「已见过非 idle」继续盯。
 * 不重发 POST——目标正在升级，再来一次只会撞上 `UPGRADE_IN_PROGRESS`。
 */
export async function resumeNodeUpgrade(p: UpgradeResumeParams): Promise<UpgradeRunOutcome> {
  const version = p.status.targetVersion ?? p.targetVersion;
  p.patch({ phase: p.status.state, targetVersion: version, error: null });
  const result = await watchUpgrade({
    nodeId: p.row.id,
    targetVersion: version,
    sawActive: true,
    unconfirmedStart: false,
    io: p.io,
    signal: p.signal,
    describeError: (code) => upgradeErrorText(p.t, code),
    phase: (phase) => p.patch({ phase }),
  });
  if (result.kind === 'cancelled' || p.signal.aborted) return 'cancelled';
  reportResult(p, version, result);
  return outcomeOf(result);
}

/** 批量升级期间用它顶掉每节点 toast：进度仍然逐行落到表格上，只是不再刷屏。 */
export const SILENT_UPGRADE_TOASTS: UpgradeToasts = {
  success: () => undefined,
  info: () => undefined,
  warning: () => undefined,
  error: () => undefined,
};

/** 批量结束后的唯一一条 toast；被取消时不提示（结论不完整）。 */
export function reportBatchSummary(
  t: Translate,
  toasts: UpgradeToasts,
  summary: UpgradeBatchSummary
): void {
  if (summary.cancelled) return;
  const counts = { success: summary.succeeded, failed: summary.failed };
  if (summary.cancelledCount > 0) {
    // 有人中途按了停止：三个数一起报，失败节点名让位给「已取消」这一档。
    const text = t('nodes.upgrade.allDoneWithCancelled', {
      ...counts,
      cancelled: summary.cancelledCount,
    });
    if (summary.failed === 0) toasts.info(text);
    else toasts.warning(text);
    return;
  }
  if (summary.failed === 0) {
    toasts.success(t('nodes.upgrade.allDone', counts));
    return;
  }
  const names = summary.failedNames.join(t('nodes.upgrade.listSeparator'));
  toasts.warning(t('nodes.upgrade.allDoneWithFailures', { ...counts, names }));
}

/** 刷新后需要回读升级状态的行：在线，且是本机或已登录（否则 GET 只会吃一条 401）。 */
export function restorableRows(rows: NodeRow[]): NodeRow[] {
  return rows.filter((row) => row.online && (row.isSelf || row.loggedIn));
}

export interface UpgradeRestoreParams {
  rows: NodeRow[];
  io: UpgradeIo;
  signal: AbortSignal;
  concurrency?: number;
  /** 本会话已经有升级在跑的行：跳过，别把自己的状态机覆盖一遍。 */
  skip: (nodeId: string) => boolean;
  /** 目标仍在升级：由调用方写回表格并接上轮询。 */
  onActive: (row: NodeRow, status: UpgradeStatus) => void;
}

/**
 * 刷新后按行回读 `GET /api/mesh/nodes/:id/upgrade`，把还在跑的升级交回调用方接管。
 * idle 的行一律不复活：`UPGRADE_CANCELLED` 是良性结论，旧的失败也没必要在刷新后再报一次。
 */
export async function restoreUpgradeStates(p: UpgradeRestoreParams): Promise<void> {
  const queue = restorableRows(p.rows);
  let next = 0;
  const limit = Math.min(p.concurrency ?? RESTORE_CONCURRENCY, queue.length);
  const worker = async () => {
    while (!p.signal.aborted) {
      const row = queue[next++];
      if (!row) return;
      if (p.skip(row.id)) continue;
      const outcome = await p.io.poll(row.id, p.signal);
      if (p.signal.aborted || outcome.kind !== 'status') continue;
      if (outcome.status.state === 'idle') continue;
      p.onActive(row, outcome.status);
    }
  };
  await Promise.allSettled(Array.from({ length: limit }, worker));
}

/** 「停止升级」被后端拒绝时的三种良性结论：说清原因即可，轮询照常继续。 */
const CANCEL_REJECT_KEYS: Record<string, string> = {
  UPGRADE_NOT_CANCELLABLE: 'nodes.upgrade.cancelNotAllowed',
  UPGRADE_CANCEL_UNSUPPORTED: 'nodes.upgrade.cancelUnsupported',
};

export interface UpgradeCancelParams {
  row: Pick<NodeRow, 'id' | 'name'>;
  io: UpgradeIo;
  signal: AbortSignal;
  t: Translate;
  toasts: UpgradeToasts;
  patch: (entry: Partial<NodeUpgradeEntry>) => void;
  /** 取消成功后立刻掐掉这一行的轮询，免得它把「回到 idle」再判一次。 */
  stopWatch: () => void;
  onChanged: () => void;
}

/** `DELETE /api/mesh/nodes/:id/upgrade`：成功即回到静止态，被拒绝时只说明原因、不动状态。 */
export async function cancelNodeUpgrade(p: UpgradeCancelParams): Promise<'cancelled' | 'rejected'> {
  const outcome = await p.io.cancel(p.row.id, p.signal);
  if (p.signal.aborted) return 'rejected';
  if (outcome.kind === 'cancelled') {
    p.stopWatch();
    p.patch({ phase: 'idle', targetVersion: null, error: null });
    p.toasts.info(p.t('nodes.upgrade.cancelled', { name: p.row.name }));
    p.onChanged();
    return 'cancelled';
  }
  if (outcome.code === 'UPGRADE_NOT_RUNNING') {
    p.toasts.info(p.t('nodes.upgrade.cancelNotRunning'));
    return 'rejected';
  }
  const key = CANCEL_REJECT_KEYS[outcome.code];
  if (key) p.toasts.warning(p.t(key));
  else
    p.toasts.error(
      p.t('nodes.upgrade.cancelFailed', { error: upgradeErrorText(p.t, outcome.code) })
    );
  return 'rejected';
}

/** 每节点一把 `AbortController`：停一行不波及别的行，卸载时一把全停。 */
export interface NodeAbortRegistry {
  open(nodeId: string): AbortController;
  stop(nodeId: string): void;
  /** 归还自己那把；已经被下一次升级换掉时什么都不做。 */
  release(nodeId: string, controller: AbortController): void;
  stopAll(): void;
}

export function createNodeAbortRegistry(): NodeAbortRegistry {
  const controllers = new Map<string, AbortController>();
  return {
    open(nodeId) {
      const controller = new AbortController();
      controllers.set(nodeId, controller);
      return controller;
    },
    stop(nodeId) {
      const controller = controllers.get(nodeId);
      if (!controller) return;
      controllers.delete(nodeId);
      controller.abort();
    },
    release(nodeId, controller) {
      if (controllers.get(nodeId) === controller) controllers.delete(nodeId);
    },
    stopAll() {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    },
  };
}

export interface UpgradeBatchLaunch {
  rows: NodeRow[];
  latestVersion: string | null;
  /** 已有行内升级在跑：批量必须让路，否则它会把那台机器当成「跳过」并打乱 hub → self 的次序。 */
  rowRunning: boolean;
  signal: AbortSignal;
  t: Translate;
  toasts: UpgradeToasts;
  confirm: (message: string) => boolean;
  runOne: (row: NodeRow, version: string, toasts: UpgradeToasts) => Promise<UpgradeRunOutcome>;
  onStart: (total: number) => void;
  onProgress: (completed: number) => void;
}

/**
 * 「全部升级」的完整决策链：无行内任务 → latest 已知 → 筛候选 → 一次确认 → 按序执行 → 一条汇总 toast。
 * 没启动（有行内任务 / latest 未知 / 没有候选 / 用户取消）返回 `null`，调用方据此不进入 running 态。
 */
export function launchUpgradeBatch(p: UpgradeBatchLaunch): Promise<UpgradeBatchSummary> | null {
  if (p.rowRunning) {
    p.toasts.info(p.t('nodes.upgrade.allBusy'));
    return null;
  }
  const version = p.latestVersion;
  if (!version) return null;
  const targets = eligibleUpgradeRows(p.rows, version);
  if (targets.length === 0) return null;
  if (!p.confirm(p.t('nodes.upgrade.confirmAll', { count: targets.length, version }))) return null;
  p.onStart(targets.length);
  return runUpgradeBatch({
    rows: targets,
    signal: p.signal,
    // 批量期间每节点的 toast 全部吞掉，只保留行内阶段与最后那条汇总。
    run: (row) => p.runOne(row, version, SILENT_UPGRADE_TOASTS),
    onProgress: p.onProgress,
  }).then((summary) => {
    reportBatchSummary(p.t, p.toasts, summary);
    return summary;
  });
}

function confirmText(t: Translate, row: NodeRow, version: string | null): string {
  const target = version ?? t('nodes.upgrade.latestPending');
  return row.isSelf
    ? t('nodes.upgrade.confirmSelf', { version: target })
    : t('nodes.upgrade.confirmRemote', { name: row.name, version: target });
}

export interface UpgradeRowLaunch {
  row: NodeRow;
  latestVersion: string | null;
  /** 批量正在推进：行内按钮不受理，否则同一台机器会被两条流程抢。 */
  batchRunning: boolean;
  /** 这一行自己已经有一次升级在跑。 */
  nodeRunning: boolean;
  t: Translate;
  confirm: (message: string) => boolean;
  runOne: (row: NodeRow, version: string | null) => Promise<UpgradeRunOutcome>;
}

/** 行内「升级」的准入与确认；没启动返回 `null`。与 `launchUpgradeBatch` 互斥。 */
export function launchRowUpgrade(p: UpgradeRowLaunch): Promise<UpgradeRunOutcome> | null {
  if (p.batchRunning || p.nodeRunning) return null;
  if (!p.confirm(confirmText(p.t, p.row, p.latestVersion))) return null;
  return p.runOne(p.row, p.latestVersion);
}

export function upgradeErrorText(t: Translate, code: string): string {
  const key = ERROR_KEYS[code];
  return key ? t(key) : code;
}

/** 阶段 → 按钮上的进度文案；静止阶段没有文案。 */
export function upgradePhaseText(t: Translate, phase: NodeUpgradePhase): string | null {
  if (phase === 'downloading') return t('nodes.upgrade.stateDownloading');
  if (phase === 'executing') return t('nodes.upgrade.stateExecuting');
  if (phase === 'restarting' || phase === 'pending') return t('nodes.upgrade.stateRestarting');
  return null;
}

export function isUpgradeBusy(phase: NodeUpgradePhase): boolean {
  return phase !== 'idle' && phase !== 'done' && phase !== 'failed';
}

export function useNodeUpgrade(
  rows: NodeRow[],
  onChanged: () => void,
  io: UpgradeIo = defaultUpgradeIo
): NodeUpgradeController {
  const { t } = useTranslation();
  const [latest, setLatest] = useState<NodeUpgradeLatest | null>(null);
  const [entries, setEntries] = useState<Record<string, NodeUpgradeEntry>>({});
  const [batch, setBatch] = useState<NodeUpgradeBatchState>(IDLE_UPGRADE_BATCH);
  // ref 负责同一 tick 内的同步互斥判定，state 负责让工具栏按钮跟着变灰——两者必须一起改。
  const [runningCount, setRunningCount] = useState(0);
  const [restoringCount, setRestoringCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const nodeAbortsRef = useRef<NodeAbortRegistry>(createNodeAbortRegistry());
  const runningRef = useRef<Set<string>>(new Set());
  const batchRunningRef = useRef(false);
  /** 已经回读过状态的节点：列表每次刷新都会换引用，靠它保证只查新出现的行。 */
  const restoredRef = useRef<Set<string>>(new Set());
  const latestRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    const nodeAborts = nodeAbortsRef.current;
    return () => {
      controller.abort();
      nodeAborts.stopAll();
      if (abortRef.current === controller) abortRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchUpgradeLatest()
      .then((value) => {
        if (!cancelled && value) setLatest(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    latestRef.current = latest?.latestVersion ?? null;
  }, [latest]);

  /** 组件已卸载就不再改状态：升级流程比页面活得久，patch 到死组件上只会报 warning。 */
  const alive = useCallback(() => abortRef.current?.signal.aborted === false, []);

  const patch = useCallback(
    (nodeId: string, entry: Partial<NodeUpgradeEntry>) => {
      if (!alive()) return;
      setEntries((prev) => ({
        ...prev,
        [nodeId]: { ...(prev[nodeId] ?? IDLE_UPGRADE_ENTRY), ...entry },
      }));
    },
    [alive]
  );

  /**
   * 同一个节点只能有一次升级在跑：行内按钮、批量与刷新恢复共用这把锁，
   * 并在这里给它领一把自己的 `AbortController`——「停止升级」只掐这一行。
   */
  const runExclusive = useCallback(
    (row: NodeRow, runner: (signal: AbortSignal) => Promise<UpgradeRunOutcome>) => {
      if (runningRef.current.has(row.id)) return Promise.resolve<UpgradeRunOutcome>('cancelled');
      const controller = nodeAbortsRef.current.open(row.id);
      runningRef.current.add(row.id);
      if (alive()) setRunningCount(runningRef.current.size);
      return runner(controller.signal).finally(() => {
        runningRef.current.delete(row.id);
        nodeAbortsRef.current.release(row.id, controller);
        if (alive()) setRunningCount(runningRef.current.size);
      });
    },
    [alive]
  );

  const runOnce = useCallback(
    (row: NodeRow, version: string | null, toasts: UpgradeToasts) =>
      runExclusive(row, (signal) =>
        runNodeUpgrade({
          row,
          targetVersion: version,
          io,
          signal,
          t,
          toasts,
          patch: (entry) => patch(row.id, entry),
          onChanged,
        })
      ),
    [io, onChanged, patch, runExclusive, t]
  );

  const resumeOnce = useCallback(
    (row: NodeRow, status: UpgradeStatus) =>
      runExclusive(row, (signal) =>
        resumeNodeUpgrade({
          row,
          status,
          targetVersion: latestRef.current,
          io,
          signal,
          t,
          toasts: toast,
          patch: (entry) => patch(row.id, entry),
          onChanged,
        })
      ),
    [io, onChanged, patch, runExclusive, t]
  );

  // 刷新页面后升级还在目标机上跑：回读一遍状态，非 idle 的行直接接上轮询。
  useEffect(() => {
    const signal = abortRef.current?.signal;
    if (!signal || signal.aborted) return;
    const pending = restorableRows(rows).filter((row) => !restoredRef.current.has(row.id));
    if (pending.length === 0) return;
    for (const row of pending) restoredRef.current.add(row.id);
    setRestoringCount((value) => value + 1);
    void restoreUpgradeStates({
      rows: pending,
      io,
      signal,
      skip: (nodeId) => runningRef.current.has(nodeId),
      onActive: (row, status) => {
        void resumeOnce(row, status);
      },
    }).finally(() => {
      if (alive()) setRestoringCount((value) => value - 1);
    });
  }, [alive, io, resumeOnce, rows]);

  const start = useCallback(
    (row: NodeRow) => {
      const signal = abortRef.current?.signal;
      if (!signal || signal.aborted) return;
      void launchRowUpgrade({
        row,
        latestVersion: latest?.latestVersion ?? null,
        batchRunning: batchRunningRef.current,
        nodeRunning: runningRef.current.has(row.id),
        t,
        confirm: (message) => globalThis.confirm?.(message) === true,
        runOne: (target, version) => runOnce(target, version, toast),
      });
    },
    [latest, runOnce, t]
  );

  const cancel = useCallback(
    (row: NodeRow) => {
      const signal = abortRef.current?.signal;
      if (!signal || signal.aborted) return;
      void cancelNodeUpgrade({
        row,
        io,
        // DELETE 走宿主级 signal：这一行的 controller 一取消成功就会被掐掉。
        signal,
        t,
        toasts: toast,
        patch: (entry) => patch(row.id, entry),
        stopWatch: () => nodeAbortsRef.current.stop(row.id),
        onChanged,
      });
    },
    [io, onChanged, patch, t]
  );

  const startAll = useCallback(
    (rows: NodeRow[]) => {
      const signal = abortRef.current?.signal;
      if (!signal || signal.aborted || batchRunningRef.current) return;
      const running = launchUpgradeBatch({
        rows,
        latestVersion: latest?.latestVersion ?? null,
        rowRunning: runningRef.current.size > 0,
        signal,
        t,
        toasts: toast,
        confirm: (message) => globalThis.confirm?.(message) === true,
        runOne: (row, version, toasts) => runOnce(row, version, toasts),
        onStart: (total) => {
          batchRunningRef.current = true;
          setBatch({ running: true, total, completed: 0 });
        },
        onProgress: (completed) => {
          if (alive()) setBatch((prev) => ({ ...prev, completed }));
        },
      });
      if (!running) return;
      void running.finally(() => {
        batchRunningRef.current = false;
        if (alive()) setBatch(IDLE_UPGRADE_BATCH);
      });
    },
    [alive, latest, runOnce, t]
  );

  const entryOf = useCallback((nodeId: string) => entries[nodeId] ?? IDLE_UPGRADE_ENTRY, [entries]);

  const eligibleCount = useCallback(
    (rows: NodeRow[]) => eligibleUpgradeRows(rows, latest?.latestVersion ?? null).length,
    [latest]
  );

  return {
    latest,
    entryOf,
    start,
    startAll,
    cancel,
    batch,
    eligibleCount,
    anyRunning: runningCount > 0,
    restoring: restoringCount > 0,
  };
}
