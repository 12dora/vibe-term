// 批量升级的纯逻辑：可升级性判定、执行顺序与带并发上限的调度。
//
// 这里不碰网络、不碰 React：单次升级由调用方注入（`run`），便于单测断言调度顺序。
// 顺序是硬约束——hub 一重启，经中继到达的节点全部失联；本机一重启，当前页面直接断开。
// 因此：普通节点（并发 3）→ 远端 hub → 本机，前一组**完全收尾**后才开下一组。

import type { NodeRow } from '@/node/mesh-nodes';
import { compareSemver } from '@tmex/shared';
import type { UpgradeRunOutcome } from './types';

/** 首个网关暴露 `/api/system/upgrade` 与 `/api/system/info` 的版本；更早的版本只能在本机手动升级。 */
export const MIN_REMOTE_UPGRADE_VERSION = '1.1.0';

/** 普通节点的并发上限：再多也只是同时压满几台机器的下载带宽。 */
export const BATCH_CONCURRENCY = 3;

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
  /** 组件卸载 / 页面离开：结论不完整，不该弹汇总 toast。 */
  cancelled: boolean;
}

export interface UpgradeBatchParams {
  rows: NodeRow[];
  signal: AbortSignal;
  concurrency?: number;
  run: (row: NodeRow) => Promise<UpgradeRunOutcome>;
  onProgress: (completed: number) => void;
}

function tally(summary: UpgradeBatchSummary, row: NodeRow, outcome: UpgradeRunOutcome) {
  if (outcome === 'done' || outcome === 'alreadyLatest') {
    summary.succeeded += 1;
    return;
  }
  if (outcome === 'failed' || outcome === 'timeout') {
    summary.failed += 1;
    summary.failedNames.push(row.name);
  }
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
      tally(summary, row, await settleOne(p, row));
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

export async function runUpgradeBatch(p: UpgradeBatchParams): Promise<UpgradeBatchSummary> {
  const summary: UpgradeBatchSummary = {
    succeeded: 0,
    failed: 0,
    failedNames: [],
    cancelled: false,
  };
  const progress = { completed: 0 };
  for (const group of orderUpgradeGroups(p.rows)) {
    if (p.signal.aborted) break;
    await runGroup(group, p, summary, progress);
  }
  summary.cancelled = p.signal.aborted;
  return summary;
}
