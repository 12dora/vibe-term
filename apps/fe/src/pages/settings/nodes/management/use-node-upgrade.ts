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
//
// 「停止升级」在 POST 在途时按下不能立刻发 DELETE——目标还没登记这次升级，只会扑空，随后 POST
// 照样把升级跑起来。因此由 `createUpgradeCancelGate` 记账，等 POST 落地再补发（`UpgradeStartHandoff`）。

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
  SILENT_UPGRADE_TOASTS,
  type Translate,
  type UpgradeBatchSummary,
  type UpgradeToasts,
  eligibleUpgradeRows,
  launchUpgradeBatch,
  reportBatchSummary,
  resumeUpgradeBatch,
} from './upgrade-batch';
import {
  type BatchPlanSink,
  UPGRADE_BATCH_HEARTBEAT_MS,
  type UpgradeBatchPlan,
  batchOwnedByOtherTab,
  canAdoptBatchPlan,
  clearBatchPlan,
  createBatchPlan,
  createBatchPlanSink,
  currentTabId,
  isBatchPlanStorageEvent,
  loadBatchPlan,
} from './upgrade-batch-storage';

export {
  MIN_REMOTE_UPGRADE_VERSION,
  SILENT_UPGRADE_TOASTS,
  launchUpgradeBatch,
  reportBatchSummary,
};
export type { Translate, UpgradeToasts };

const POLL_MS = 2000;
/** 下载 + 解包 + 重启 + 版本回传的总预算。 */
const BUDGET_MS = 6 * 60_000;
/** POST 之后目标迟迟不进入非 idle：判定没真正开始，不要空等满预算。 */
const START_GRACE_MS = 30_000;
/** 刷新后回读各节点升级状态的并发上限。 */
export const RESTORE_CONCURRENCY = 3;

/** 后端取消升级后留在 idle 状态上的标记；FE 必须按「已取消」而不是失败处理。 */
export const UPGRADE_CANCELLED_ERROR: string = UPGRADE_CANCELLED;

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

/**
 * POST 在途时按下的「停止升级」：目标还没登记这次升级，DELETE 只会扑空，
 * 只能等 POST 落地再补发。由 hook 用 `UpgradeCancelGate` 接线。
 */
export interface UpgradeStartHandoff {
  begin(): void;
  /** POST 期间按过「停止升级」，还等着补发。 */
  pending(): boolean;
  /** POST 落地结账：`live` 为假表示升级压根没跑起来，只清账不补发。 */
  settle(live: boolean): Promise<'cancelled' | 'rejected' | 'none'>;
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
  handoff?: UpgradeStartHandoff;
}

/** POST 的四种结论；只有「已开始」与「结果未知」要继续轮询。 */
function reportStart(
  p: UpgradeRunParams,
  started: Exclude<UpgradeStartOutcome, { kind: 'cancelled' }>,
  /** 用户已经按了停止：这次升级马上要被撤掉，「已开始」之类的提示只会添乱。 */
  quiet: boolean
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
    if (!quiet) p.toasts.warning(p.t('nodes.upgrade.startUnconfirmed', { name: p.row.name }));
    return null;
  }
  const version = started.status.targetVersion ?? p.targetVersion;
  p.patch({ phase: started.status.state, targetVersion: version });
  if (!quiet) p.toasts.success(p.t('nodes.upgrade.started', { version: version ?? '' }));
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
  p.handoff?.begin();
  let started: UpgradeStartOutcome;
  try {
    started = await p.io.start(p.row.id, p.signal);
  } catch (error) {
    await p.handoff?.settle(false);
    throw error;
  }
  if (started.kind === 'cancelled' || p.signal.aborted) {
    await p.handoff?.settle(false);
    return 'cancelled';
  }
  const status = reportStart(p, started, p.handoff?.pending() === true);
  if (!status && started.kind !== 'unconfirmed') {
    await p.handoff?.settle(false);
    return started.kind === 'alreadyLatest' ? 'alreadyLatest' : 'failed';
  }
  // 目标已经登记了这次升级，DELETE 现在才有对象：把 POST 在途期间按下的停止补发出去。
  if ((await p.handoff?.settle(true)) === 'cancelled') return 'cancelled';
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

/** 刷新后需要回读升级状态的行：在线，且是本机或已登录（否则 GET 只会吃一条 401）。 */
export function restorableRows(rows: NodeRow[]): NodeRow[] {
  return rows.filter((row) => row.online && (row.isSelf || row.loggedIn));
}

/** 名额用完就排队的并发闸；一把闸管所有回读轮次，多轮叠加也不会突破上限。 */
export interface Semaphore {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createSemaphore(limit: number): Semaphore {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> | undefined => {
    // 有人在排队时新来的一律排队，先到先得。
    if (active < limit && waiters.length === 0) {
      active += 1;
      return undefined;
    }
    return new Promise<void>((resolve) => waiters.push(resolve));
  };
  const release = () => {
    const next = waiters.shift();
    // 名额直接交棒给下一个，中途不还回池子，免得插队冲破上限。
    if (next) next();
    else active -= 1;
  };
  return {
    async run(task) {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/** 只留还在列表里的记账：节点消失过又回来时要重新回读一次。 */
export function retainKnownIds(seen: Set<string>, rows: NodeRow[]): void {
  const ids = new Set(rows.map((row) => row.id));
  for (const id of seen) if (!ids.has(id)) seen.delete(id);
}

export interface UpgradeRestoreParams {
  rows: NodeRow[];
  io: UpgradeIo;
  signal: AbortSignal;
  /** hook 级共用的并发闸；不给时按 `concurrency` 现开一把。 */
  gate?: Semaphore;
  concurrency?: number;
  /** 本会话已经有升级在跑的行：跳过，别把自己的状态机覆盖一遍。 */
  skip: (nodeId: string) => boolean;
  /** 这一行回读收尾（无论结果如何）：调用方据此解禁行内升级按钮。 */
  onSettled?: (nodeId: string) => void;
  /** 目标仍在升级：由调用方写回表格并接上轮询。 */
  onActive: (row: NodeRow, status: UpgradeStatus) => void;
}

/**
 * 刷新后按行回读 `GET /api/mesh/nodes/:id/upgrade`，把还在跑的升级交回调用方接管。
 * idle 的行一律不复活：`UPGRADE_CANCELLED` 是良性结论，旧的失败也没必要在刷新后再报一次。
 */
export async function restoreUpgradeStates(p: UpgradeRestoreParams): Promise<void> {
  const gate = p.gate ?? createSemaphore(p.concurrency ?? RESTORE_CONCURRENCY);
  await Promise.allSettled(
    restorableRows(p.rows).map((row) =>
      gate.run(async () => {
        try {
          if (p.signal.aborted || p.skip(row.id)) return;
          const outcome = await p.io.poll(row.id, p.signal);
          if (p.signal.aborted || outcome.kind !== 'status') return;
          if (outcome.status.state === 'idle') return;
          p.onActive(row, outcome.status);
        } finally {
          p.onSettled?.(row.id);
        }
      })
    )
  );
}

/** 回读到的在途升级；行内 / 批量正占着这一行时先排队，等它让开再接手。 */
export interface ResumeQueue {
  /** 交给状态机；被排队时返回 `false`。 */
  offer(row: NodeRow, status: UpgradeStatus): boolean;
  /** 一次升级收尾：放出排队的接手。刚升成功的行直接丢弃——回读到的状态已经过时。 */
  release(nodeId: string, outcome: UpgradeRunOutcome): void;
}

export function createResumeQueue(p: {
  busy: (nodeId: string) => boolean;
  resume: (row: NodeRow, status: UpgradeStatus) => void;
}): ResumeQueue {
  const queued = new Map<string, { row: NodeRow; status: UpgradeStatus }>();
  return {
    offer(row, status) {
      if (!p.busy(row.id)) {
        p.resume(row, status);
        return true;
      }
      queued.set(row.id, { row, status });
      return false;
    },
    release(nodeId, outcome) {
      const pending = queued.get(nodeId);
      if (!pending) return;
      queued.delete(nodeId);
      if (outcome === 'done' || outcome === 'alreadyLatest') return;
      p.resume(pending.row, pending.status);
    },
  };
}

/** 「停止升级」被后端拒绝时的良性结论：说清原因即可，轮询照常继续。 */
const CANCEL_REJECT_KEYS: Record<string, string> = {
  UPGRADE_NOT_CANCELLABLE: 'nodes.upgrade.cancelNotAllowed',
  UPGRADE_CANCEL_UNSUPPORTED: 'nodes.upgrade.cancelUnsupported',
};

/**
 * 旧版本没有中断能力时 DELETE 的几种回法：旧入口压根没有这条路由（404 / 405），
 * 新入口遇上没有 `upgrade-cancel` 能力的目标则回 501。对用户都是同一句话。
 */
const CANCEL_UNSUPPORTED_STATUS = new Set([404, 405, 501]);

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
  /** DELETE 扑空而这一行的 POST 还在途：升级还没登记，等 POST 落地再补一次；返回是否排上队。 */
  retry?: () => boolean;
}

/** `deferred`：这次取消改由 POST 落地后补发，按钮保持「停止中」，不能当结论。 */
export type UpgradeCancelResult = 'cancelled' | 'rejected' | 'deferred';

/** `DELETE /api/mesh/nodes/:id/upgrade`：成功即回到静止态，被拒绝时只说明原因、不动状态。 */
export async function cancelNodeUpgrade(p: UpgradeCancelParams): Promise<UpgradeCancelResult> {
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
    if (p.retry?.()) return 'deferred';
    p.toasts.info(p.t('nodes.upgrade.cancelNotRunning'));
    return 'rejected';
  }
  const key = CANCEL_REJECT_KEYS[outcome.code] ?? unsupportedKey(outcome.httpStatus);
  if (key) p.toasts.warning(p.t(key));
  else
    p.toasts.error(
      p.t('nodes.upgrade.cancelFailed', { error: upgradeErrorText(p.t, outcome.code) })
    );
  return 'rejected';
}

function unsupportedKey(httpStatus: number): string | undefined {
  return CANCEL_UNSUPPORTED_STATUS.has(httpStatus) ? 'nodes.upgrade.cancelUnsupported' : undefined;
}

/**
 * 「停止升级」的记账。POST 在途时按下停止不能立刻发 DELETE——目标还没登记这次升级，
 * 只会扑空；先记下来，等 POST 落地再补发。同一行同时只允许一次取消在途。
 */
export interface UpgradeCancelGate {
  /** `send` 立刻发 DELETE，`defer` 等 POST 落地补发，`busy` 已有一次在途。 */
  request(nodeId: string): 'send' | 'defer' | 'busy';
  /** POST 发出前登记。 */
  beginStart(nodeId: string): void;
  /** POST 落地：清掉在途登记，返回期间是否按过停止（只返回一次）。 */
  endStart(nodeId: string): boolean;
  /** POST 期间按过停止，还等着补发。 */
  pending(nodeId: string): boolean;
  /** DELETE 扑空但 POST 还在途：改成等 POST 落地再补一次。 */
  deferIfStarting(nodeId: string): boolean;
  /** 一次取消收尾。 */
  finish(nodeId: string): void;
  /** 这一行有取消在途（含排队等补发）。 */
  cancelling(nodeId: string): boolean;
}

export function createUpgradeCancelGate(): UpgradeCancelGate {
  const inFlight = new Set<string>();
  const starting = new Set<string>();
  const deferred = new Set<string>();
  return {
    request(nodeId) {
      if (inFlight.has(nodeId)) return 'busy';
      inFlight.add(nodeId);
      if (!starting.has(nodeId)) return 'send';
      deferred.add(nodeId);
      return 'defer';
    },
    beginStart(nodeId) {
      starting.add(nodeId);
    },
    endStart(nodeId) {
      starting.delete(nodeId);
      return deferred.delete(nodeId);
    },
    pending(nodeId) {
      return deferred.has(nodeId);
    },
    deferIfStarting(nodeId) {
      if (!starting.has(nodeId)) return false;
      deferred.add(nodeId);
      return true;
    },
    finish(nodeId) {
      inFlight.delete(nodeId);
      deferred.delete(nodeId);
    },
    cancelling(nodeId) {
      return inFlight.has(nodeId);
    },
  };
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
  /** 这一行的升级状态还在回读：先不受理，免得与回读到的在途升级抢同一台机器。 */
  restoring: boolean;
  t: Translate;
  confirm: (message: string) => boolean;
  runOne: (row: NodeRow, version: string | null) => Promise<UpgradeRunOutcome>;
}

/** 行内「升级」的准入与确认；没启动返回 `null`。与 `launchUpgradeBatch` 互斥。 */
export function launchRowUpgrade(p: UpgradeRowLaunch): Promise<UpgradeRunOutcome> | null {
  if (p.batchRunning || p.nodeRunning || p.restoring) return null;
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

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

function withId(ids: ReadonlySet<string>, nodeId: string, present: boolean): ReadonlySet<string> {
  if (ids.has(nodeId) === present) return ids;
  const next = new Set(ids);
  if (present) next.add(nodeId);
  else next.delete(nodeId);
  return next;
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
  /** 回读还没收尾的行：这些行的升级按钮先锁住，批量入口整体让路。 */
  const [restoringIds, setRestoringIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const abortRef = useRef<AbortController | null>(null);
  const nodeAbortsRef = useRef<NodeAbortRegistry>(createNodeAbortRegistry());
  const cancelGateRef = useRef<UpgradeCancelGate>(createUpgradeCancelGate());
  /** 一把闸管所有回读轮次：列表连着新增几批节点也不会同时压出十几个 GET。 */
  const restoreGateRef = useRef<Semaphore>(createSemaphore(RESTORE_CONCURRENCY));
  const runningRef = useRef<Set<string>>(new Set());
  /** 每行在途的那次升级：续跑的批量靠它等结论，不重发 POST。 */
  const inFlightRef = useRef<Map<string, Promise<UpgradeRunOutcome>>>(new Map());
  const batchRunningRef = useRef(false);
  /** 正在推进的批量的计划写入口；心跳与收尾都用它。 */
  const planSinkRef = useRef<BatchPlanSink | null>(null);
  /** 本次挂载待续接的计划；`undefined` 表示还没读过（入口 id 未知时不缓存）。 */
  const planRef = useRef<UpgradeBatchPlan | null | undefined>(undefined);
  /** 计划里的节点：它们的回读续跑属于这一批，每行的 toast 交给最后那条汇总。 */
  const planIdsRef = useRef<ReadonlySet<string>>(EMPTY_IDS);
  /** 续跑只尝试一次：判定为过期 / 被别的标签页占着之后不再反复重试。 */
  const resumedRef = useRef(false);
  /** 还没收尾的回读轮次数：大于零时不开续跑，免得与回读抢同一台机器。 */
  const restoreActiveRef = useRef(0);
  /** 已经回读过状态的节点；节点离开列表就忘掉，再出现时重新回读一次。 */
  const restoredRef = useRef<Set<string>>(new Set());
  const latestRef = useRef<string | null>(null);
  const resumeRef = useRef<((row: NodeRow, status: UpgradeStatus) => void) | null>(null);
  const resumeQueueRef = useRef<ResumeQueue>(
    createResumeQueue({
      busy: (nodeId) => runningRef.current.has(nodeId),
      resume: (row, status) => resumeRef.current?.(row, status),
    })
  );

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
      const settle = (outcome: UpgradeRunOutcome) => {
        runningRef.current.delete(row.id);
        inFlightRef.current.delete(row.id);
        nodeAbortsRef.current.release(row.id, controller);
        if (alive()) setRunningCount(runningRef.current.size);
        // 回读到的在途升级要是被这次升级挡在门外，现在轮到它接手了。
        resumeQueueRef.current.release(row.id, outcome);
      };
      const running = runner(controller.signal).then(
        (outcome) => {
          settle(outcome);
          return outcome;
        },
        (error: unknown) => {
          settle('failed');
          throw error;
        }
      );
      inFlightRef.current.set(row.id, running);
      return running;
    },
    [alive]
  );

  /** DELETE 与它的收尾记账；`deferred` 表示改由 POST 落地后补发，按钮保持「停止中」。 */
  const runCancel = useCallback(
    (row: NodeRow): Promise<UpgradeCancelResult> => {
      const gate = cancelGateRef.current;
      const signal = abortRef.current?.signal;
      if (!signal || signal.aborted) {
        gate.finish(row.id);
        return Promise.resolve<UpgradeCancelResult>('rejected');
      }
      return cancelNodeUpgrade({
        row,
        io,
        // DELETE 走宿主级 signal：这一行的 controller 一取消成功就会被掐掉。
        signal,
        t,
        toasts: toast,
        patch: (entry) => patch(row.id, entry),
        stopWatch: () => nodeAbortsRef.current.stop(row.id),
        onChanged,
        retry: () => gate.deferIfStarting(row.id),
      }).then((result) => {
        if (result !== 'deferred') {
          gate.finish(row.id);
          patch(row.id, { cancelling: false });
        }
        return result;
      });
    },
    [io, onChanged, patch, t]
  );

  const startHandoff = useCallback(
    (row: NodeRow): UpgradeStartHandoff => {
      const gate = cancelGateRef.current;
      return {
        begin: () => gate.beginStart(row.id),
        pending: () => gate.pending(row.id),
        settle: async (live) => {
          if (!gate.endStart(row.id)) return 'none';
          if (!live) {
            gate.finish(row.id);
            patch(row.id, { cancelling: false });
            return 'none';
          }
          return (await runCancel(row)) === 'cancelled' ? 'cancelled' : 'rejected';
        },
      };
    },
    [patch, runCancel]
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
          handoff: startHandoff(row),
        })
      ),
    [io, onChanged, patch, runExclusive, startHandoff, t]
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
          // 属于待续接批量的行：每行的结论交给最后那条汇总，不逐台刷屏。
          toasts: planIdsRef.current.has(row.id) ? SILENT_UPGRADE_TOASTS : toast,
          patch: (entry) => patch(row.id, entry),
          onChanged,
        })
      ),
    [io, onChanged, patch, runExclusive, t]
  );

  useEffect(() => {
    resumeRef.current = (row, status) => {
      void resumeOnce(row, status);
    };
  }, [resumeOnce]);

  /** 入口节点（本机行）：批量计划按它落盘，换入口即换计划。 */
  const entryNodeId = rows.find((row) => row.isSelf)?.id ?? null;

  /**
   * 本次挂载待续接的计划；只读一次。被别的标签页占着时按「没有」处理，之后也不再重试——
   * 那一页多半正跑着这批，抢过来只会两页对着同一批机器同时发 POST。
   */
  const readPlan = useCallback((): UpgradeBatchPlan | null => {
    if (planRef.current !== undefined) return planRef.current;
    if (!entryNodeId) return null;
    const now = io.now();
    const stored = loadBatchPlan(entryNodeId, now);
    const plan = stored && canAdoptBatchPlan(stored, currentTabId(), now) ? stored : null;
    planRef.current = plan;
    planIdsRef.current = new Set(plan ? plan.order.flat() : []);
    return plan;
  }, [entryNodeId, io]);

  const openPlan = useCallback(
    (order: string[][], targetVersion: string): BatchPlanSink | null => {
      if (!entryNodeId) return null;
      const created = createBatchPlan({
        entryNodeId,
        targetVersion,
        order,
        now: io.now(),
        tabId: currentTabId(),
      });
      const sink = createBatchPlanSink(created, io.now);
      planSinkRef.current = sink;
      planIdsRef.current = new Set(order.flat());
      // 用户亲手开的这一批顶掉上一次留下的计划：那份已经被覆盖，绝不能再去续跑。
      planRef.current = null;
      resumedRef.current = true;
      return sink;
    },
    [entryNodeId, io]
  );

  /** 一批跑完的收尾记账：running 标记、进度条与心跳用的 sink 一起归位。 */
  const trackBatch = useCallback(
    (running: Promise<UpgradeBatchSummary>) => {
      void running.finally(() => {
        batchRunningRef.current = false;
        planSinkRef.current = null;
        if (alive()) setBatch(IDLE_UPGRADE_BATCH);
      });
    },
    [alive]
  );

  const tryResumeRef = useRef<(() => void) | null>(null);

  // 刷新页面后升级还在目标机上跑：回读一遍状态，非 idle 的行直接接上轮询。
  useEffect(() => {
    const signal = abortRef.current?.signal;
    if (!signal || signal.aborted) return;
    // 先认出待续接的批量：属于它的行在回读接管时就该静音，结论留给最后那条汇总。
    readPlan();
    retainKnownIds(restoredRef.current, rows);
    const pending = restorableRows(rows).filter((row) => !restoredRef.current.has(row.id));
    if (pending.length === 0) return;
    for (const row of pending) restoredRef.current.add(row.id);
    restoreActiveRef.current += 1;
    setRestoringIds((prev) => {
      const next = new Set(prev);
      for (const row of pending) next.add(row.id);
      return next;
    });
    void restoreUpgradeStates({
      rows: pending,
      io,
      signal,
      gate: restoreGateRef.current,
      skip: (nodeId) => runningRef.current.has(nodeId),
      onSettled: (nodeId) => {
        if (alive()) setRestoringIds((prev) => withId(prev, nodeId, false));
      },
      onActive: (row, status) => {
        resumeQueueRef.current.offer(row, status);
      },
    }).finally(() => {
      restoreActiveRef.current -= 1;
      // 回读收尾后才知道谁已被接管：这时开续跑不会与它抢同一台机器。
      tryResumeRef.current?.();
    });
  }, [alive, io, readPlan, rows]);

  const start = useCallback(
    (row: NodeRow) => {
      const signal = abortRef.current?.signal;
      if (!signal || signal.aborted) return;
      void launchRowUpgrade({
        row,
        latestVersion: latest?.latestVersion ?? null,
        batchRunning: batchRunningRef.current,
        nodeRunning: runningRef.current.has(row.id),
        restoring: restoringIds.has(row.id),
        t,
        confirm: (message) => globalThis.confirm?.(message) === true,
        runOne: (target, version) => runOnce(target, version, toast),
      });
    },
    [latest, restoringIds, runOnce, t]
  );

  const cancel = useCallback(
    (row: NodeRow) => {
      const mode = cancelGateRef.current.request(row.id);
      // 已经有一次取消在途：连点不再发第二条 DELETE。
      if (mode === 'busy') return;
      patch(row.id, { cancelling: true });
      // POST 还在途：DELETE 现在发出去只会扑空，等它落地由 `startHandoff` 补发。
      if (mode === 'defer') return;
      void runCancel(row);
    },
    [patch, runCancel]
  );

  const startAll = useCallback(
    (rows: NodeRow[]) => {
      const signal = abortRef.current?.signal;
      if (!signal || signal.aborted || batchRunningRef.current) return;
      // 别的标签页正握着一份还在心跳的计划：另开一批只会两页对着同一堆机器互相覆盖。
      if (batchOwnedByOtherTab(entryNodeId, currentTabId(), io.now())) {
        toast.info(t('nodes.upgrade.allOtherTab'));
        return;
      }
      const running = launchUpgradeBatch({
        rows,
        latestVersion: latest?.latestVersion ?? null,
        rowRunning: runningRef.current.size > 0,
        restoring: restoringIds.size > 0,
        signal,
        t,
        toasts: toast,
        confirm: (message) => globalThis.confirm?.(message) === true,
        runOne: (row, version, toasts) => runOnce(row, version, toasts),
        openPlan,
        onStart: (total, completed) => {
          batchRunningRef.current = true;
          setBatch({ running: true, total, completed });
        },
        onProgress: (completed) => {
          if (alive()) setBatch((prev) => ({ ...prev, completed }));
        },
      });
      if (!running) return;
      trackBatch(running);
    },
    [alive, entryNodeId, io, latest, openPlan, restoringIds, runOnce, t, trackBatch]
  );

  /**
   * 刷新后接上上一次的「全部升级」：回读收尾且 latest 已知时才动手，且只尝试一次——
   * 计划过期或被别的标签页占着时反复重试没有意义。
   */
  const tryResumeBatch = useCallback(() => {
    const signal = abortRef.current?.signal;
    if (!signal || signal.aborted) return;
    if (resumedRef.current || batchRunningRef.current || restoreActiveRef.current > 0) return;
    const version = latest?.latestVersion;
    if (!version) return;
    const plan = readPlan();
    if (!plan) return;
    resumedRef.current = true;
    if (plan.targetVersion !== version) {
      // latest 已经往前走了：照这份计划跑只会把机器升到旧版本。
      clearBatchPlan(plan.entryNodeId);
      planIdsRef.current = EMPTY_IDS;
      return;
    }
    // 接管这批：心跳换成本标签页，别的标签页从此不再抢。
    const sink = createBatchPlanSink({ ...plan, ownerTabId: currentTabId() }, io.now);
    planSinkRef.current = sink;
    batchRunningRef.current = true;
    trackBatch(
      resumeUpgradeBatch({
        plan,
        rows,
        signal,
        t,
        toasts: toast,
        sink,
        joinRunning: (row) => inFlightRef.current.get(row.id) ?? null,
        runOne: (row, target, toasts) => runOnce(row, target, toasts),
        onStart: (total, completed) => setBatch({ running: true, total, completed }),
        onProgress: (completed) => {
          if (alive()) setBatch((prev) => ({ ...prev, completed }));
        },
      })
    );
  }, [alive, io, latest, readPlan, rows, runOnce, t, trackBatch]);

  useEffect(() => {
    tryResumeRef.current = tryResumeBatch;
    tryResumeBatch();
  }, [tryResumeBatch]);

  /**
   * 计划在别的标签页里被改写（持有者收尾删除、或换了持有者）时再判一次能不能接管：
   * 首次读到「别人占着」的标签页只缓存了一个 `null`，没有这一下它永远等不到接管的机会。
   */
  useEffect(() => {
    if (!entryNodeId) return;
    const onStorage = (event: StorageEvent) => {
      if (!isBatchPlanStorageEvent(entryNodeId, event.key)) return;
      planRef.current = undefined;
      tryResumeRef.current?.();
    };
    globalThis.addEventListener('storage', onStorage);
    return () => globalThis.removeEventListener('storage', onStorage);
  }, [entryNodeId]);

  // 批量推进期间定时刷新计划的 `updatedAt`：别的标签页据此知道这批还有人在跑。
  useEffect(() => {
    if (!batch.running) return;
    const timer = setInterval(() => planSinkRef.current?.touch(), UPGRADE_BATCH_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [batch.running]);

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
    restoring: restoringIds.size > 0,
    restoringIds,
  };
}
