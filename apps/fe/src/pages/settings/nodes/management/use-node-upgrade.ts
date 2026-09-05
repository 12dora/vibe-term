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
import { defaultApiClient, formatBytesPair } from '@tmex/api-client';
import {
  type RemoteUpgradeProgress,
  UPGRADE_CANCELLED,
  type UpgradeStatus,
  sleepOrAbort,
} from '@tmex/shared';
import type {
  NodeUpgradeEntry,
  NodeUpgradeLatest,
  NodeUpgradePhase,
  UpgradeRunOutcome,
} from './types';
import {
  MIN_REMOTE_UPGRADE_VERSION,
  SILENT_UPGRADE_TOASTS,
  type Translate,
  type UpgradeToasts,
  launchUpgradeBatch,
  reportBatchSummary,
} from './upgrade-batch';

export {
  MIN_REMOTE_UPGRADE_VERSION,
  SILENT_UPGRADE_TOASTS,
  launchUpgradeBatch,
  reportBatchSummary,
};
export type { Translate, UpgradeToasts };

const POLL_MS = 2000;
/** 没有任何进展时的等待预算：下载 + 解包 + 重启 + 版本回传。 */
const BUDGET_MS = 6 * 60_000;
/**
 * 入口每报一次新的推包进度就把预算重新计时——13 MB 的包过中继可能要十几分钟，
 * 按固定 6 分钟砍掉只会把一次正在推进的升级判成「未确认」。这是硬上限，
 * 覆盖后端 10 min 下载 + 15 min 推包 + 1 min 启动。
 */
const MAX_BUDGET_MS = 30 * 60_000;
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
  UPGRADE_OFFSET_MISMATCH: 'nodes.upgrade.pushFailed',
};

/**
 * 入口报回来的原始失败串（`push failed: …` / `download failed: …`）不适合直接摆给用户：
 * 按前缀与关键片段翻成一句人话。命中不了的保持原样，宁可露出英文也不谎报原因。
 */
const RAW_ERROR_PATTERNS: Array<{ match: RegExp; key: string }> = [
  { match: /link_lost/i, key: 'nodes.upgrade.linkLost' },
  { match: /^push failed: .*(push timeout)/i, key: 'nodes.upgrade.pushTimeout' },
  { match: /^push failed:/i, key: 'nodes.upgrade.pushFailed' },
  { match: /^download failed:/i, key: 'nodes.upgrade.downloadFailed' },
  { match: /^start failed:/i, key: 'nodes.upgrade.startFailed' },
];

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
  wait: sleepOrAbort,
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
  /** 入口代跑时的推包进度；本机升级与旧入口没有这一段，只在数值变化时回调。 */
  progress?: (push: NodeUpgradeEntry['push']) => void;
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
  if (status.error) return { kind: 'failed', error: ctx.describeError(status.error) };
  if (!sawActive) {
    // POST 结果未知：目标可能已经升完重启回来，版本对上就是成功。
    if (ctx.unconfirmedStart && (await versionConfirmed(ctx, true))) return { kind: 'done' };
    return elapsed > START_GRACE_MS ? { kind: 'timeout' } : null;
  }
  ctx.phase('restarting');
  return (await versionConfirmed(ctx, false)) ? { kind: 'done' } : null;
}

/** 只有真的在推包时才给进度：下载阶段总量未知，摆个 0 / 0 只会误导。 */
export function pushProgressOf(
  progress: RemoteUpgradeProgress | null
): { pushedBytes: number; totalBytes: number } | null {
  if (!progress || progress.phase !== 'push' || progress.totalBytes <= 0) return null;
  return { pushedBytes: progress.pushedBytes, totalBytes: progress.totalBytes };
}

/** 进度指纹：入口每换一个阶段、每多推一段字节都会变，据此判断这次升级还在推进。 */
export function upgradeProgressMark(status: UpgradeStatus): string {
  const progress = status.progress;
  if (!progress) return '';
  return `${progress.phase}:${progress.pushedBytes}:${progress.attempt}`;
}

/**
 * 进度记账：入口每报一次新的进度就把预算重新计时（封顶 `MAX_BUDGET_MS`），
 * 并在推包字节变化时回调一次，免得每轮都往表格里塞同一份进度。
 */
function createProgressTracker(ctx: UpgradeWatchContext, startedAt: number) {
  const hardDeadline = startedAt + MAX_BUDGET_MS;
  let deadline = startedAt + BUDGET_MS;
  let progressMark = '';
  let pushMark = '';
  return {
    deadline: () => deadline,
    observe(status: UpgradeStatus): void {
      const mark = upgradeProgressMark(status);
      if (mark && mark !== progressMark) {
        progressMark = mark;
        deadline = Math.min(ctx.io.now() + BUDGET_MS, hardDeadline);
      }
      const push = pushProgressOf(status.progress ?? null);
      const nextPushMark = push ? `${push.pushedBytes}/${push.totalBytes}` : '';
      if (nextPushMark === pushMark) return;
      pushMark = nextPushMark;
      ctx.progress?.(push);
    },
  };
}

export async function watchUpgrade(ctx: UpgradeWatchContext): Promise<UpgradeWatchResult> {
  const startedAt = ctx.io.now();
  const tracker = createProgressTracker(ctx, startedAt);
  let sawActive = ctx.sawActive;
  while (ctx.io.now() < tracker.deadline()) {
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
    tracker.observe(status);
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
  p.patch({ phase: 'pending', targetVersion: p.targetVersion, error: null, push: null });
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
    progress: (push) => p.patch({ push }),
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
    progress: (push) => p.patch({ push }),
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
  if (key) return t(key);
  const pattern = RAW_ERROR_PATTERNS.find((row) => row.match.test(code));
  return pattern ? t(pattern.key) : code;
}

/** 阶段 → 按钮上的进度文案；静止阶段没有文案。 */
export function upgradePhaseText(
  t: Translate,
  phase: NodeUpgradePhase,
  push?: NodeUpgradeEntry['push']
): string | null {
  if (phase === 'downloading') {
    // 入口正在把包推给目标：摆出「已传 / 总量」，比一个不动的「下载中」有信息量。
    if (push) {
      return t('nodes.upgrade.statePushing', {
        progress: formatBytesPair(push.pushedBytes, push.totalBytes),
      });
    }
    return t('nodes.upgrade.stateDownloading');
  }
  if (phase === 'executing') return t('nodes.upgrade.stateExecuting');
  if (phase === 'restarting' || phase === 'pending') return t('nodes.upgrade.stateRestarting');
  return null;
}

export function isUpgradeBusy(phase: NodeUpgradePhase): boolean {
  return phase !== 'idle' && phase !== 'done' && phase !== 'failed';
}
