// 批量升级的编排：可升级性判定、执行顺序、带并发上限的调度，以及刷新后的续跑。
//
// 这里不碰网络、不碰 React：单次升级由调用方注入（`run`），便于单测断言调度顺序。
// 顺序是硬约束——hub 一重启，经中继到达的节点全部失联；本机一重启，当前页面直接断开。
// 因此：普通节点（并发 3）→ 远端 hub → 本机，前一组**完全收尾**后才开下一组。
//
// 本机重启必然带来一次页面刷新，编排却只活在页面里：所以每台机器落定都把结论写进持久化的
// 计划（`upgrade-batch-storage`），刷新后按同一份 `order` 接着跑，最后仍然只弹一条汇总。

import type { NodeRow } from '@/node/mesh-nodes';
import { compareSemver } from '@tmex/shared';
import type { UpgradeRunOutcome } from './types';
import { type BatchPlanSink, type UpgradeBatchPlan, planRemaining } from './upgrade-batch-storage';

/** 首个网关暴露 `/api/system/upgrade` 与 `/api/system/info` 的版本；更早的版本只能在本机手动升级。 */
export const MIN_REMOTE_UPGRADE_VERSION = '1.1.0';

/** 普通节点的并发上限：再多也只是同时压满几台机器的下载带宽。 */
export const BATCH_CONCURRENCY = 3;

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** sonner 的最小子集：单测注入 spy，避免真的弹 toast。 */
export interface UpgradeToasts {
  success: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
}

/** 批量升级期间用它顶掉每节点 toast：进度仍然逐行落到表格上，只是不再刷屏。 */
export const SILENT_UPGRADE_TOASTS: UpgradeToasts = {
  success: () => undefined,
  info: () => undefined,
  warning: () => undefined,
  error: () => undefined,
};

/** 行内升级按钮被禁用的原因；`null` 表示可以点。 */
export type UpgradeBlockReason = 'offline' | 'loginRequired' | 'tooOld' | 'atLatest';

/** 版本能解析且低于 `MIN_REMOTE_UPGRADE_VERSION`。无法解析（如 `1.1.0_dev`）不算，交给后端裁决。 */
export function isTooOldForRemoteUpgrade(version: string | null): boolean {
  if (!version) return false;
  return compareSemver(version, MIN_REMOTE_UPGRADE_VERSION) === -1;
}

/** latest 未知或版本无法解析时一律返回 `false`：不拿猜测去禁用按钮。 */
export function isAtLatest(version: string | null, latestVersion: string | null): boolean {
  if (!version || !latestVersion) return false;
  const cmp = compareSemver(version, latestVersion);
  return cmp !== null && cmp >= 0;
}

export function upgradeBlockReason(
  row: Pick<NodeRow, 'online' | 'loggedIn' | 'isSelf' | 'version'>,
  latestVersion: string | null
): UpgradeBlockReason | null {
  if (!row.online) return 'offline';
  if (!row.isSelf && !row.loggedIn) return 'loginRequired';
  if (isTooOldForRemoteUpgrade(row.version)) return 'tooOld';
  if (isAtLatest(row.version, latestVersion)) return 'atLatest';
  return null;
}

/** 批量升级的候选：可点 + 版本可解析且**严格低于** latest。版本未知的节点不进批量。 */
export function isBatchEligible(row: NodeRow, latestVersion: string | null): boolean {
  if (!latestVersion || !row.version) return false;
  if (upgradeBlockReason(row, latestVersion) !== null) return false;
  return compareSemver(row.version, latestVersion) === -1;
}

export function eligibleUpgradeRows(rows: NodeRow[], latestVersion: string | null): NodeRow[] {
  return rows.filter((row) => isBatchEligible(row, latestVersion));
}

/** 按「普通节点 → 远端 hub → 本机」切成三组；空组会被去掉。 */
export function orderUpgradeGroups(rows: NodeRow[]): NodeRow[][] {
  const others: NodeRow[] = [];
  const hub: NodeRow[] = [];
  const self: NodeRow[] = [];
  for (const row of rows) {
    if (row.isSelf) self.push(row);
    else if (row.isHub) hub.push(row);
    else others.push(row);
  }
  return [others, hub, self].filter((group) => group.length > 0);
}

export interface UpgradeBatchSummary {
  succeeded: number;
  failed: number;
  failedNames: string[];
  /** 用户中途按「停止升级」打断的节点数：既不算成功也不算失败，单独报一档。 */
  cancelledCount: number;
  /** 组件卸载 / 页面离开：结论不完整，不该弹汇总 toast。 */
  cancelled: boolean;
}

/** 续跑时带进来的既有结论：来自持久化计划里已经收尾的那些机器。 */
export interface SettledUpgrade {
  name: string;
  outcome: UpgradeRunOutcome;
}

export interface UpgradeBatchParams {
  rows: NodeRow[];
  /** 续跑时按持久化的分组顺序推进；缺省按 `orderUpgradeGroups(rows)` 现排。 */
  groups?: NodeRow[][];
  signal: AbortSignal;
  concurrency?: number;
  run: (row: NodeRow) => Promise<UpgradeRunOutcome>;
  onProgress: (completed: number) => void;
  /** 每台机器落定：调用方据此把结论写进持久化的计划。 */
  onSettled?: (row: NodeRow, outcome: UpgradeRunOutcome) => void;
  /** 上一次会话已经跑完的机器：直接进汇总与进度，不再发 POST。 */
  settled?: SettledUpgrade[];
}

function tally(summary: UpgradeBatchSummary, row: { name: string }, outcome: UpgradeRunOutcome) {
  if (outcome === 'done' || outcome === 'alreadyLatest') {
    summary.succeeded += 1;
    return;
  }
  if (outcome === 'failed' || outcome === 'timeout') {
    summary.failed += 1;
    summary.failedNames.push(row.name);
    return;
  }
  summary.cancelledCount += 1;
}

async function runGroup(
  group: NodeRow[],
  p: UpgradeBatchParams,
  summary: UpgradeBatchSummary,
  progress: { completed: number }
): Promise<void> {
  let next = 0;
  const limit = Math.min(p.concurrency ?? BATCH_CONCURRENCY, group.length);
  const worker = async () => {
    while (!p.signal.aborted) {
      const row = group[next++];
      if (!row) return;
      const outcome = await settleOne(p, row);
      tally(summary, row, outcome);
      p.onSettled?.(row, outcome);
      progress.completed += 1;
      p.onProgress(progress.completed);
    }
  };
  // allSettled：任何一条 worker 意外抛出都不能中断兄弟 worker，更不能让下一组提前开跑。
  await Promise.allSettled(Array.from({ length: limit }, worker));
}

/** 单节点的异常边界：一台机器抛错只算它自己失败，绝不带塌整批。 */
async function settleOne(p: UpgradeBatchParams, row: NodeRow): Promise<UpgradeRunOutcome> {
  try {
    return await p.run(row);
  } catch {
    return 'failed';
  }
}

function emptySummary(): UpgradeBatchSummary {
  return { succeeded: 0, failed: 0, failedNames: [], cancelledCount: 0, cancelled: false };
}

export async function runUpgradeBatch(p: UpgradeBatchParams): Promise<UpgradeBatchSummary> {
  const summary = emptySummary();
  for (const item of p.settled ?? []) tally(summary, item, item.outcome);
  const progress = { completed: p.settled?.length ?? 0 };
  for (const group of p.groups ?? orderUpgradeGroups(p.rows)) {
    if (p.signal.aborted) break;
    await runGroup(group, p, summary, progress);
  }
  summary.cancelled = p.signal.aborted;
  return summary;
}

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

export interface UpgradeBatchLaunch {
  rows: NodeRow[];
  latestVersion: string | null;
  /** 已有行内升级在跑：批量必须让路，否则它会把那台机器当成「跳过」并打乱 hub → self 的次序。 */
  rowRunning: boolean;
  /** 还在回读各节点的升级状态：这会儿还不知道谁在升级，批量整体让路。 */
  restoring: boolean;
  signal: AbortSignal;
  t: Translate;
  toasts: UpgradeToasts;
  confirm: (message: string) => boolean;
  runOne: (row: NodeRow, version: string, toasts: UpgradeToasts) => Promise<UpgradeRunOutcome>;
  onStart: (total: number, completed: number) => void;
  onProgress: (completed: number) => void;
  /** 计划落盘口；不给（或返回 `null`，如入口 id 未知）时退化成刷新即丢，升级本身不受影响。 */
  openPlan?: (order: string[][], targetVersion: string) => BatchPlanSink | null;
}

/**
 * 「全部升级」的完整决策链：无行内任务 → 回读已收尾 → latest 已知 → 筛候选 → 一次确认 →
 * 计划落盘 → 按序执行 → 一条汇总 toast。没启动（有行内任务 / 正在回读 / latest 未知 /
 * 没有候选 / 用户取消）返回 `null`，调用方据此不进入 running 态。
 */
export function launchUpgradeBatch(p: UpgradeBatchLaunch): Promise<UpgradeBatchSummary> | null {
  if (p.rowRunning) {
    p.toasts.info(p.t('nodes.upgrade.allBusy'));
    return null;
  }
  if (p.restoring) {
    // 回读还没收尾：这时开批量会与回读到的在途升级抢同一台机器。
    p.toasts.info(p.t('nodes.upgrade.restoring'));
    return null;
  }
  const version = p.latestVersion;
  if (!version) return null;
  const targets = eligibleUpgradeRows(p.rows, version);
  if (targets.length === 0) return null;
  if (!p.confirm(p.t('nodes.upgrade.confirmAll', { count: targets.length, version }))) return null;
  const groups = orderUpgradeGroups(targets);
  p.onStart(targets.length, 0);
  const sink = p.openPlan?.(
    groups.map((group) => group.map((row) => row.id)),
    version
  );
  return runUpgradeBatch({
    rows: targets,
    groups,
    signal: p.signal,
    // 批量期间每节点的 toast 全部吞掉，只保留行内阶段与最后那条汇总。
    run: (row) => p.runOne(row, version, SILENT_UPGRADE_TOASTS),
    onProgress: p.onProgress,
    onSettled: (row, outcome) => recordSettled(sink ?? null, p.signal, row.id, outcome),
  }).then((summary) => finishBatch(p.t, p.toasts, summary, sink ?? null));
}

/**
 * 把一台机器的结论记进计划。卸载打断的那台不记账：它多半还在目标机上跑，
 * 记成 `cancelled` 会让下次挂载直接跳过它，反倒把一次成功的升级报成「已取消」。
 */
function recordSettled(
  sink: BatchPlanSink | null,
  signal: AbortSignal,
  nodeId: string,
  outcome: UpgradeRunOutcome
): void {
  if (outcome === 'cancelled' && signal.aborted) return;
  sink?.settled(nodeId, outcome);
}

/** 卸载打断时计划原样留着（下次挂载接着跑）；正常收尾才作废。 */
function finishBatch(
  t: Translate,
  toasts: UpgradeToasts,
  summary: UpgradeBatchSummary,
  sink: BatchPlanSink | null
): UpgradeBatchSummary {
  reportBatchSummary(t, toasts, summary);
  if (!summary.cancelled) sink?.finish();
  return summary;
}

export interface UpgradeBatchResume {
  plan: UpgradeBatchPlan;
  rows: NodeRow[];
  signal: AbortSignal;
  t: Translate;
  toasts: UpgradeToasts;
  sink: BatchPlanSink;
  /** 这一行的升级已经被刷新回读接管：等它的结论，不重发 POST。没有则返回 `null`。 */
  joinRunning: (row: NodeRow) => Promise<UpgradeRunOutcome> | null;
  runOne: (row: NodeRow, version: string, toasts: UpgradeToasts) => Promise<UpgradeRunOutcome>;
  onStart: (total: number, completed: number) => void;
  onProgress: (completed: number) => void;
}

function resumeOne(
  p: UpgradeBatchResume,
  row: NodeRow,
  version: string
): Promise<UpgradeRunOutcome> {
  const joined = p.joinRunning(row);
  if (joined) return joined;
  // 刷新前就升完的机器（本机自己必然走这条）：版本已经对上，不必再发一次 POST。
  if (isAtLatest(row.version, version)) return Promise.resolve<UpgradeRunOutcome>('alreadyLatest');
  return p.runOne(row, version, SILENT_UPGRADE_TOASTS);
}

/**
 * 刷新后接着跑上一次的「全部升级」：按持久化的 `order` 推进剩下的分组，已收尾的机器只计入汇总。
 * 名字与版本一律取自新拉到的节点列表；已经离开列表的节点不再计入——这次批量对它已经没有意义。
 */
export function resumeUpgradeBatch(p: UpgradeBatchResume): Promise<UpgradeBatchSummary> {
  const byId = new Map(p.rows.map((row) => [row.id, row]));
  const version = p.plan.targetVersion;
  const groups = planRemaining(p.plan)
    .map((group) => group.flatMap((nodeId) => byId.get(nodeId) ?? []))
    .filter((group) => group.length > 0);
  const settled: SettledUpgrade[] = p.plan.done.map((item) => ({
    name: byId.get(item.nodeId)?.name ?? item.nodeId,
    outcome: item.outcome,
  }));
  const pending = groups.reduce((count, group) => count + group.length, 0);
  if (settled.length === 0 && pending === 0) {
    // 计划里的机器一台都不在列表里了：静默作废，没什么可汇报的。
    p.sink.finish();
    return Promise.resolve(emptySummary());
  }
  p.onStart(settled.length + pending, settled.length);
  p.toasts.info(p.t('nodes.upgrade.allResumed'));
  return runUpgradeBatch({
    rows: groups.flat(),
    groups,
    signal: p.signal,
    settled,
    run: (row) => resumeOne(p, row, version),
    onProgress: p.onProgress,
    onSettled: (row, outcome) => recordSettled(p.sink, p.signal, row.id, outcome),
  }).then((summary) => finishBatch(p.t, p.toasts, summary, p.sink));
}
