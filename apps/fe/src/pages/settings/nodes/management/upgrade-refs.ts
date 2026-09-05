// 节点升级编排层跨段共享的可变量。
//
// 这些量要么用于同一 tick 内的同步互斥判定（等 state 落地就晚了），要么活得比某一次渲染长
// （升级比页面活得久），放进 state 只会引入无谓的重挂与竞态。整包只在挂载时建一次，
// `useUpgradeRuntime` / `useUpgradeBatch` / `useUpgradeRestore` / `useUpgradeRowActions` 共用同一份。

import type { NodeRow } from '@/node/mesh-nodes';
import type { UpgradeStatus } from '@tmex/shared';
import type { UpgradeRunOutcome } from './types';
import type { BatchPlanSink, UpgradeBatchPlan } from './upgrade-batch-storage';
import {
  type NodeAbortRegistry,
  RESTORE_CONCURRENCY,
  type ResumeQueue,
  type Semaphore,
  type UpgradeCancelGate,
  createNodeAbortRegistry,
  createResumeQueue,
  createSemaphore,
  createUpgradeCancelGate,
} from './use-node-upgrade';

export const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

export function withId(
  ids: ReadonlySet<string>,
  nodeId: string,
  present: boolean
): ReadonlySet<string> {
  if (ids.has(nodeId) === present) return ids;
  const next = new Set(ids);
  if (present) next.add(nodeId);
  else next.delete(nodeId);
  return next;
}

type Cell<T> = { current: T };

export interface UpgradeRefs {
  /** 宿主级取消：组件卸载后所有分支都据此止步。 */
  abort: Cell<AbortController | null>;
  /** 每行一把 `AbortController`：「停止升级」只掐这一行的轮询。 */
  nodeAborts: NodeAbortRegistry;
  cancelGate: UpgradeCancelGate;
  /** 一把闸管所有回读轮次：列表连着新增几批节点也不会同时压出十几个 GET。 */
  restoreGate: Semaphore;
  /** 同一 tick 内判定「这行已经在跑」用；对应的 state 只负责让工具栏按钮跟着变灰。 */
  running: Set<string>;
  /** 每行在途的那次升级：续跑的批量靠它等结论，不重发 POST。 */
  inFlight: Map<string, Promise<UpgradeRunOutcome>>;
  resumeQueue: ResumeQueue;
  resume: Cell<((row: NodeRow, status: UpgradeStatus) => void) | null>;
  latestVersion: Cell<string | null>;
  batchRunning: Cell<boolean>;
  /** 正在推进的批量的计划写入口；心跳与收尾都用它。 */
  planSink: Cell<BatchPlanSink | null>;
  /** 本次挂载待续接的计划；`undefined` 表示还没读过（入口 id 未知时不缓存）。 */
  plan: Cell<UpgradeBatchPlan | null | undefined>;
  /** 计划里的节点：它们的回读续跑属于这一批，每行的 toast 交给最后那条汇总。 */
  planIds: Cell<ReadonlySet<string>>;
  /** 续跑只尝试一次：判定为过期 / 被别的标签页占着之后不再反复重试。 */
  resumed: Cell<boolean>;
  /** 还没收尾的回读轮次数：大于零时不开续跑，免得与回读抢同一台机器。 */
  restoreActive: Cell<number>;
  /** 已经回读过状态的节点；节点离开列表就忘掉，再出现时重新回读一次。 */
  restored: Set<string>;
  /** 回读中的行，供批量与行内按钮同步判定（对应的 state 只用于渲染）。 */
  restoring: Cell<ReadonlySet<string>>;
  tryResume: Cell<(() => void) | null>;
}

export function createUpgradeRefs(): UpgradeRefs {
  const running = new Set<string>();
  const resume: Cell<((row: NodeRow, status: UpgradeStatus) => void) | null> = { current: null };
  return {
    abort: { current: null },
    nodeAborts: createNodeAbortRegistry(),
    cancelGate: createUpgradeCancelGate(),
    restoreGate: createSemaphore(RESTORE_CONCURRENCY),
    running,
    inFlight: new Map(),
    resumeQueue: createResumeQueue({
      busy: (nodeId) => running.has(nodeId),
      resume: (row, status) => resume.current?.(row, status),
    }),
    resume,
    latestVersion: { current: null },
    batchRunning: { current: false },
    planSink: { current: null },
    plan: { current: undefined },
    planIds: { current: EMPTY_IDS },
    resumed: { current: false },
    restoreActive: { current: 0 },
    restored: new Set(),
    restoring: { current: EMPTY_IDS },
    tryResume: { current: null },
  };
}
