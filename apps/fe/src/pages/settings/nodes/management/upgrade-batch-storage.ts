// 批量升级的断点续跑：把「分组顺序 + 已收尾的结论」写进 localStorage，刷新页面后据此接着跑。
//
// 升级跑在目标机器上，而「全部升级」的编排只活在这一个页面里：一次刷新（本机升级必然带来一次）
// 就会把「还没开始的组」「hub → 本机的次序」「最后那条汇总」全部丢掉。计划落盘正是为了补上这段。
//
// 只存节点 id 与结论，不存节点快照——刷新后节点列表会重新拉一遍，名字与版本一律以新列表为准。
// 每次写入都刷新 `updatedAt`：它同时是 TTL 基准与「持有者还活着」的心跳。
//
// 多标签页只做最弱的一层保护：`ownerTabId` 存在 sessionStorage 里，刷新同一标签页不变，
// 因此原标签页刷新后立刻认得自己的计划；别的标签页要等心跳停摆 30 秒才接管。两个页面同时开着
// 并且同时开批量仍会互相干扰——真正的互斥要靠后端，这里只避免「刷新即丢」与「另一页抢跑」。
//
// localStorage 在隐私模式 / 配额耗尽时会抛：所有读写都吞掉异常，最坏结果是退化成刷新即丢，
// 绝不能让存储问题把升级本身带塌。

import type { UpgradeRunOutcome } from './types';

export const UPGRADE_BATCH_SCHEMA = 1;
/** 超过这个时长的计划一律作废：机器早该升完了，续跑只会拿一份过时的名单去打扰用户。 */
export const UPGRADE_BATCH_TTL_MS = 2 * 60 * 60_000;
/** 心跳停摆多久算持有者已经走了。 */
export const UPGRADE_BATCH_OWNER_STALE_MS = 30_000;
/** 批量推进期间的心跳间隔；必须明显小于 `UPGRADE_BATCH_OWNER_STALE_MS`。 */
export const UPGRADE_BATCH_HEARTBEAT_MS = 10_000;

const KEY_PREFIX = 'tmex.nodes.upgrade-batch.';
const TAB_KEY = `${KEY_PREFIX}tab`;

const OUTCOMES = new Set<string>(['done', 'failed', 'timeout', 'alreadyLatest', 'cancelled']);

/** 一台机器在这次批量里的最终结论。 */
export interface UpgradeBatchDone {
  nodeId: string;
  outcome: UpgradeRunOutcome;
}

export interface UpgradeBatchPlan {
  schema: number;
  batchId: string;
  /** 发起这次批量的入口节点（本机行的 id）：换入口即换计划。 */
  entryNodeId: string;
  targetVersion: string;
  /** 执行顺序：普通节点 → 远端 hub → 本机，组内可并发，组间严格串行。 */
  order: string[][];
  done: UpgradeBatchDone[];
  startedAt: number;
  updatedAt: number;
  /** 汇总 toast 已经弹过：这份计划到此作废，续跑只会重复报一遍。 */
  summaryEmitted: boolean;
  /** 发起这次批量的标签页；跨刷新不变（sessionStorage）。 */
  ownerTabId: string;
}

type StorageKind = 'localStorage' | 'sessionStorage';

function storageOf(kind: StorageKind): Storage | null {
  try {
    // 隐私模式下取值本身就会抛，不能只包 getItem。
    return (globalThis as Partial<Record<StorageKind, Storage>>)[kind] ?? null;
  } catch {
    return null;
  }
}

function randomId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    // 非安全上下文没有 randomUUID：退到时间戳 + 随机数，够用来区分标签页。
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let fallbackTabId: string | null = null;

/** 本标签页的 id：跨刷新不变，因此刷新后能立刻认出自己发起的批量。 */
export function currentTabId(): string {
  const store = storageOf('sessionStorage');
  if (store) {
    try {
      const existing = store.getItem(TAB_KEY);
      if (existing) return existing;
      const created = randomId();
      store.setItem(TAB_KEY, created);
      return created;
    } catch {
      // 落到内存兜底：这一轮内至少自洽。
    }
  }
  fallbackTabId ??= randomId();
  return fallbackTabId;
}

function isStringMatrix(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every((group) => Array.isArray(group) && group.every((id) => typeof id === 'string'))
  );
}

function parseDone(value: unknown): UpgradeBatchDone[] | null {
  if (!Array.isArray(value)) return null;
  const done: UpgradeBatchDone[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const entry = item as Partial<UpgradeBatchDone>;
    if (typeof entry.nodeId !== 'string') return null;
    if (typeof entry.outcome !== 'string' || !OUTCOMES.has(entry.outcome)) return null;
    done.push({ nodeId: entry.nodeId, outcome: entry.outcome });
  }
  return done;
}

type PlanStrings = Pick<
  UpgradeBatchPlan,
  'batchId' | 'entryNodeId' | 'targetVersion' | 'ownerTabId'
>;

function hasPlanStrings(
  plan: Partial<UpgradeBatchPlan>
): plan is Partial<UpgradeBatchPlan> & PlanStrings {
  return (
    typeof plan.batchId === 'string' &&
    typeof plan.entryNodeId === 'string' &&
    typeof plan.targetVersion === 'string' &&
    typeof plan.ownerTabId === 'string'
  );
}

/** 存储里的东西一律当成不可信输入：字段缺一不可，形状不对就整份丢掉。 */
function parsePlan(raw: string): UpgradeBatchPlan | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const plan = value as Partial<UpgradeBatchPlan>;
  const done = parseDone(plan.done);
  if (plan.schema !== UPGRADE_BATCH_SCHEMA || !done || !hasPlanStrings(plan)) return null;
  if (!isStringMatrix(plan.order)) return null;
  if (typeof plan.startedAt !== 'number' || typeof plan.updatedAt !== 'number') return null;
  return {
    schema: UPGRADE_BATCH_SCHEMA,
    batchId: plan.batchId,
    entryNodeId: plan.entryNodeId,
    targetVersion: plan.targetVersion,
    order: plan.order,
    done,
    startedAt: plan.startedAt,
    updatedAt: plan.updatedAt,
    summaryEmitted: plan.summaryEmitted === true,
    ownerTabId: plan.ownerTabId,
  };
}

export function createBatchPlan(p: {
  entryNodeId: string;
  targetVersion: string;
  order: string[][];
  now: number;
  tabId: string;
}): UpgradeBatchPlan {
  return {
    schema: UPGRADE_BATCH_SCHEMA,
    batchId: randomId(),
    entryNodeId: p.entryNodeId,
    targetVersion: p.targetVersion,
    order: p.order,
    done: [],
    startedAt: p.now,
    updatedAt: p.now,
    summaryEmitted: false,
    ownerTabId: p.tabId,
  };
}

export function saveBatchPlan(plan: UpgradeBatchPlan): void {
  const store = storageOf('localStorage');
  if (!store) return;
  try {
    store.setItem(KEY_PREFIX + plan.entryNodeId, JSON.stringify(plan));
  } catch {
    // 配额满 / 隐私模式：续跑能力可以没有，升级本身不能受影响。
  }
}

export function clearBatchPlan(entryNodeId: string): void {
  const store = storageOf('localStorage');
  if (!store) return;
  try {
    store.removeItem(KEY_PREFIX + entryNodeId);
  } catch {
    // 同上：删不掉也只是下次加载多读一次，`summaryEmitted` 会兜住。
  }
}

/** 读取这个入口节点的计划；schema / TTL / 已汇总的一律作废并顺手清掉。 */
export function loadBatchPlan(entryNodeId: string, now: number): UpgradeBatchPlan | null {
  const store = storageOf('localStorage');
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(KEY_PREFIX + entryNodeId);
  } catch {
    return null;
  }
  if (!raw) return null;
  const plan = parsePlan(raw);
  if (!plan) {
    clearBatchPlan(entryNodeId);
    return null;
  }
  const expired = now - plan.updatedAt > UPGRADE_BATCH_TTL_MS;
  if (plan.entryNodeId !== entryNodeId || plan.summaryEmitted || expired) {
    clearBatchPlan(entryNodeId);
    return null;
  }
  return plan;
}

/** 还没收尾的分组（保持原顺序，空组去掉）。 */
export function planRemaining(plan: UpgradeBatchPlan): string[][] {
  const done = new Set(plan.done.map((item) => item.nodeId));
  return plan.order
    .map((group) => group.filter((nodeId) => !done.has(nodeId)))
    .filter((group) => group.length > 0);
}

/** 别的标签页正在推进这批（心跳还新鲜）时不抢；自己的计划永远认。 */
export function canAdoptBatchPlan(plan: UpgradeBatchPlan, tabId: string, now: number): boolean {
  return plan.ownerTabId === tabId || now - plan.updatedAt > UPGRADE_BATCH_OWNER_STALE_MS;
}

/** 批量推进过程中对计划的写入口；实现全部吞掉存储异常。 */
export interface BatchPlanSink {
  /** 一台机器落定。 */
  settled(nodeId: string, outcome: UpgradeRunOutcome): void;
  /** 心跳：告诉别的标签页这批还有人在跑。 */
  touch(): void;
  /** 汇总 toast 已弹：先记下 `summaryEmitted` 再删，删不掉时下次加载也不会重跑。 */
  finish(): void;
  plan(): UpgradeBatchPlan;
}

export function createBatchPlanSink(plan: UpgradeBatchPlan, now: () => number): BatchPlanSink {
  let current = plan;
  const write = () => {
    current = { ...current, updatedAt: now() };
    saveBatchPlan(current);
  };
  write();
  return {
    settled(nodeId, outcome) {
      if (current.done.some((item) => item.nodeId === nodeId)) return;
      current = { ...current, done: [...current.done, { nodeId, outcome }] };
      write();
    },
    touch: write,
    finish() {
      current = { ...current, summaryEmitted: true };
      write();
      clearBatchPlan(current.entryNodeId);
    },
    plan: () => current,
  };
}
