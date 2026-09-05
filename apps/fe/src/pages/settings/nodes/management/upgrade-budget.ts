// 远程升级的等待预算与推包进度记账。
//
// 升级跑在目标机器上，前端只能靠轮询判断「还在推进」还是「已经停摆」。预算就是这条判据：
// 超时不当失败，只提示「未确认」，但预算太短会把一次仍在正常传输的升级误判成停摆——所以按
// 后端的阶段超时给预算，而不是拿一个固定值一刀切。

import type { RemoteUpgradeProgress, UpgradeStatus } from '@tmex/shared';
import type { NodeUpgradeTransfer } from './types';

/** 没有任何进展时的等待预算：下载 + 解包 + 重启 + 版本回传。旧入口不报阶段，只能用它。 */
export const BUDGET_MS = 6 * 60_000;
/** 阶段预算在后端阶段超时之上留的富余：够后端把自己的超时结论报出来，别抢在它前面判「未确认」。 */
const PHASE_GRACE_MS = 60_000;
/**
 * 按阶段给的等待预算，取值对齐后端 `REMOTE_UPGRADE_TIMEOUTS`（下载 10 min / 推包 15 min /
 * 启动 60 s）。后端在阶段内不一定持续报字节（慢链路上 `pushedBytes` 可以几分钟纹丝不动），
 * 所以「进度没动」不能按 6 分钟砍——那会把一次仍在正常推进的传输判成超时。
 * `start` 之后还有重启与版本回传，沿用 6 分钟基线而不是后端那 60 s。
 */
const PHASE_BUDGET_MS: Record<RemoteUpgradeProgress['phase'], number> = {
  download: 10 * 60_000 + PHASE_GRACE_MS,
  push: 15 * 60_000 + PHASE_GRACE_MS,
  start: BUDGET_MS,
};
/** 所有预算的硬上限：进度一直在动也不能无限等下去。 */
export const MAX_BUDGET_MS = 30 * 60_000;

/**
 * 入口报回来的字节进度。推包阶段总量已知才给（0 / 0 只会误导）；下载阶段总量可以为 0——
 * 发行源不一定给 `content-length`，此时只摆已下载量，仍比一个不动的「下载中」有信息量。
 * 旧入口不报 `downloadedBytes`，下载阶段照旧没有进度。
 */
export function transferProgressOf(
  progress: RemoteUpgradeProgress | null
): NodeUpgradeTransfer | null {
  if (!progress) return null;
  if (progress.phase === 'push') {
    if (progress.totalBytes <= 0) return null;
    return {
      kind: 'push',
      transferredBytes: progress.pushedBytes,
      totalBytes: progress.totalBytes,
    };
  }
  if (progress.phase !== 'download') return null;
  const downloaded = progress.downloadedBytes ?? 0;
  if (downloaded <= 0) return null;
  return {
    kind: 'download',
    transferredBytes: downloaded,
    totalBytes: progress.downloadTotalBytes ?? 0,
  };
}

/**
 * 进度指纹：入口每换一个阶段、每多下载或推送一段字节都会变，据此判断这次升级还在推进。
 * 下载字节与推包字节同等看待——慢但在动的下载不该被判成停摆。
 */
export function upgradeProgressMark(status: UpgradeStatus): string {
  const progress = status.progress;
  if (!progress) return '';
  const downloaded = progress.downloadedBytes ?? 0;
  return `${progress.phase}:${progress.pushedBytes}:${downloaded}:${progress.attempt}`;
}

export interface ProgressTracker {
  deadline(): number;
  observe(status: UpgradeStatus): void;
}

/**
 * 进度记账：
 *   - 入口每报一次新的进度就按当前阶段的预算重新计时；
 *   - 进度停着不动时，预算仍按「这个阶段第一次被看见」起算，覆盖后端的阶段超时；
 *   - 不报阶段的旧入口维持 6 分钟基线；
 *   - 一切封顶 `MAX_BUDGET_MS`，且 deadline 只前移不回退。
 * 另外在传输字节变化时回调一次，免得每轮都往表格里塞同一份进度。
 */
export function createProgressTracker(p: {
  startedAt: number;
  now: () => number;
  onTransfer?: (transfer: NodeUpgradeTransfer | null) => void;
}): ProgressTracker {
  const hardDeadline = p.startedAt + MAX_BUDGET_MS;
  let deadline = Math.min(p.startedAt + BUDGET_MS, hardDeadline);
  let progressMark = '';
  let transferMark = '';
  let phase: RemoteUpgradeProgress['phase'] | null = null;
  const extend = (budget: number): void => {
    deadline = Math.max(deadline, Math.min(p.now() + budget, hardDeadline));
  };
  return {
    deadline: () => deadline,
    observe(status: UpgradeStatus): void {
      const progress = status.progress ?? null;
      const mark = upgradeProgressMark(status);
      if (progress && (progress.phase !== phase || mark !== progressMark)) {
        phase = progress.phase;
        progressMark = mark;
        extend(PHASE_BUDGET_MS[progress.phase]);
      }
      const transfer = transferProgressOf(progress);
      const nextMark = transfer
        ? `${transfer.kind}:${transfer.transferredBytes}/${transfer.totalBytes}`
        : '';
      if (nextMark === transferMark) return;
      transferMark = nextMark;
      p.onTransfer?.(transfer);
    },
  };
}
