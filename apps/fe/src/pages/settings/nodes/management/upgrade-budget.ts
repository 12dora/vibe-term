// 远程升级的等待预算与推包进度记账。
//
// 升级跑在目标机器上，前端只能靠轮询判断「还在推进」还是「已经停摆」。预算就是这条判据：
// 超时不当失败，只提示「未确认」，但预算太短会把一次仍在正常传输的升级误判成停摆——所以按
// 后端的阶段超时给预算，而不是拿一个固定值一刀切。

import type { RemoteUpgradeProgress, UpgradeStatus } from '@tmex/shared';

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

export type PushProgress = { pushedBytes: number; totalBytes: number };

/** 只有真的在推包时才给进度：下载阶段总量未知，摆个 0 / 0 只会误导。 */
export function pushProgressOf(progress: RemoteUpgradeProgress | null): PushProgress | null {
  if (!progress || progress.phase !== 'push' || progress.totalBytes <= 0) return null;
  return { pushedBytes: progress.pushedBytes, totalBytes: progress.totalBytes };
}

/** 进度指纹：入口每换一个阶段、每多推一段字节都会变，据此判断这次升级还在推进。 */
export function upgradeProgressMark(status: UpgradeStatus): string {
  const progress = status.progress;
  if (!progress) return '';
  return `${progress.phase}:${progress.pushedBytes}:${progress.attempt}`;
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
 * 另外在推包字节变化时回调一次，免得每轮都往表格里塞同一份进度。
 */
export function createProgressTracker(p: {
  startedAt: number;
  now: () => number;
  onPush?: (push: PushProgress | null) => void;
}): ProgressTracker {
  const hardDeadline = p.startedAt + MAX_BUDGET_MS;
  let deadline = Math.min(p.startedAt + BUDGET_MS, hardDeadline);
  let progressMark = '';
  let pushMark = '';
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
      const push = pushProgressOf(progress);
      const nextPushMark = push ? `${push.pushedBytes}/${push.totalBytes}` : '';
      if (nextPushMark === pushMark) return;
      pushMark = nextPushMark;
      p.onPush?.(push);
    },
  };
}
