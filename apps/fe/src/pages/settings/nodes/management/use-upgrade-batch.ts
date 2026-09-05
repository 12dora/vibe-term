// 节点升级的批量层与回读层。
//
// 批量计划落在入口节点（本机行）名下，换入口即换计划；同一份计划任一时刻只允许一个标签页推进，
// 靠 `updatedAt` 心跳与 `ownerTabId` 判定归属。刷新页面后：先回读每行的在途状态（`useUpgradeRestore`），
// 全部收尾之后才放行批量续跑（`useUpgradeBatchResume`），免得两条路径抢同一台机器。
//
// 这个「先后」靠 hook 的调用次序落实：`useUpgradeRestore` 必须排在 `useUpgradeBatch` 之前，
// 它的 effect 才会先把 `restoreActive` 抬起来。反过来的话，节点列表刚到的那一帧续跑先跑，
// 此时 `restoreActive` 为 0、`inFlight` 为空，仍在升级的节点会被重发一次 POST。

import type { NodeRow } from '@/node/mesh-nodes';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { IDLE_UPGRADE_BATCH, type NodeUpgradeBatchState, type NodeUpgradeLatest } from './types';
import {
  type Translate,
  type UpgradeBatchSummary,
  launchUpgradeBatch,
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
import { EMPTY_IDS, type UpgradeRefs, withId } from './upgrade-refs';
import {
  type UpgradeIo,
  restorableRows,
  restoreUpgradeStates,
  retainKnownIds,
} from './use-node-upgrade';
import type { UpgradeRuntime } from './use-upgrade-runtime';

type TrackBatch = (running: Promise<UpgradeBatchSummary>) => void;
export type ReadPlan = () => UpgradeBatchPlan | null;

export interface UpgradeBatchControl {
  batch: NodeUpgradeBatchState;
  startAll: (rows: NodeRow[]) => void;
}

export interface UpgradeBatchPlanControl {
  /** 批量计划挂在本机行名下：换入口即换计划。 */
  entryNodeId: string | null;
  readPlan: ReadPlan;
  openPlan: (order: string[][], targetVersion: string) => BatchPlanSink | null;
}

/**
 * 计划的读与写：读只发生一次（结果缓存在 ref 里），写会顶掉上一次留下的计划。
 * 单独成段是为了让调用方能把「登记回读」排在「批量续跑」前面——两者都要用 `readPlan`，
 * 但续跑的 effect 必须后注册。
 */
export function useUpgradeBatchPlan(
  refs: UpgradeRefs,
  rows: NodeRow[],
  io: UpgradeIo
): UpgradeBatchPlanControl {
  const entryNodeId = rows.find((row) => row.isSelf)?.id ?? null;
  /**
   * 本次挂载待续接的计划；只读一次。被别的标签页占着时按「没有」处理，之后也不再重试——
   * 那一页多半正跑着这批，抢过来只会两页对着同一批机器同时发 POST。
   */
  const readPlan = useCallback<ReadPlan>(() => {
    if (refs.plan.current !== undefined) return refs.plan.current;
    if (!entryNodeId) return null;
    const now = io.now();
    const stored = loadBatchPlan(entryNodeId, now);
    const plan = stored && canAdoptBatchPlan(stored, currentTabId(), now) ? stored : null;
    refs.plan.current = plan;
    refs.planIds.current = new Set(plan ? plan.order.flat() : []);
    return plan;
  }, [entryNodeId, io, refs]);

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
      refs.planSink.current = sink;
      refs.planIds.current = new Set(order.flat());
      // 用户亲手开的这一批顶掉上一次留下的计划：那份已经被覆盖，绝不能再去续跑。
      refs.plan.current = null;
      refs.resumed.current = true;
      return sink;
    },
    [entryNodeId, io, refs]
  );

  return { entryNodeId, readPlan, openPlan };
}

/**
 * 刷新后接上上一次的「全部升级」：回读收尾且 latest 已知时才动手，且只尝试一次——
 * 计划过期或被别的标签页占着时反复重试没有意义。
 */
function useUpgradeBatchResume(p: {
  refs: UpgradeRefs;
  rows: NodeRow[];
  io: UpgradeIo;
  t: Translate;
  latest: NodeUpgradeLatest | null;
  entryNodeId: string | null;
  readPlan: ReadPlan;
  runOnce: UpgradeRuntime['runOnce'];
  trackBatch: TrackBatch;
  setBatch: (next: NodeUpgradeBatchState) => void;
  onProgress: (completed: number) => void;
}): void {
  const { refs, rows, io, t, latest, entryNodeId, readPlan, runOnce, trackBatch } = p;
  const { setBatch, onProgress } = p;

  const tryResumeBatch = useCallback(() => {
    const signal = refs.abort.current?.signal;
    if (!signal || signal.aborted) return;
    if (refs.resumed.current || refs.batchRunning.current || refs.restoreActive.current > 0) return;
    const version = latest?.latestVersion;
    if (!version) return;
    const plan = readPlan();
    if (!plan) return;
    refs.resumed.current = true;
    if (plan.targetVersion !== version) {
      // latest 已经往前走了：照这份计划跑只会把机器升到旧版本。
      clearBatchPlan(plan.entryNodeId);
      refs.planIds.current = EMPTY_IDS;
      return;
    }
    // 接管这批：心跳换成本标签页，别的标签页从此不再抢。
    const sink = createBatchPlanSink({ ...plan, ownerTabId: currentTabId() }, io.now);
    refs.planSink.current = sink;
    refs.batchRunning.current = true;
    trackBatch(
      resumeUpgradeBatch({
        plan,
        rows,
        signal,
        t,
        toasts: toast,
        sink,
        joinRunning: (row) => refs.inFlight.get(row.id) ?? null,
        runOne: (row, target, toasts) => runOnce(row, target, toasts),
        onStart: (total, completed) => setBatch({ running: true, total, completed }),
        onProgress,
      })
    );
  }, [io, latest, onProgress, readPlan, refs, rows, runOnce, setBatch, t, trackBatch]);

  useEffect(() => {
    refs.tryResume.current = tryResumeBatch;
    tryResumeBatch();
  }, [refs, tryResumeBatch]);

  /**
   * 计划在别的标签页里被改写（持有者收尾删除、或换了持有者）时再判一次能不能接管：
   * 首次读到「别人占着」的标签页只缓存了一个 `null`，没有这一下它永远等不到接管的机会。
   */
  useEffect(() => {
    if (!entryNodeId) return;
    const onStorage = (event: StorageEvent) => {
      if (!isBatchPlanStorageEvent(entryNodeId, event.key)) return;
      refs.plan.current = undefined;
      refs.tryResume.current?.();
    };
    globalThis.addEventListener('storage', onStorage);
    return () => globalThis.removeEventListener('storage', onStorage);
  }, [entryNodeId, refs]);
}

export function useUpgradeBatch(p: {
  refs: UpgradeRefs;
  rows: NodeRow[];
  io: UpgradeIo;
  t: Translate;
  latest: NodeUpgradeLatest | null;
  alive: () => boolean;
  runOnce: UpgradeRuntime['runOnce'];
  /** 由调用方先建好并交给 `useUpgradeRestore`，保证回读的 effect 排在续跑之前。 */
  plan: UpgradeBatchPlanControl;
}): UpgradeBatchControl {
  const { refs, rows, io, t, latest, alive, runOnce } = p;
  const [batch, setBatch] = useState<NodeUpgradeBatchState>(IDLE_UPGRADE_BATCH);
  const { entryNodeId, readPlan, openPlan } = p.plan;

  /** 一批跑完的收尾记账：running 标记、进度条与心跳用的 sink 一起归位。 */
  const trackBatch = useCallback<TrackBatch>(
    (running) => {
      void running.finally(() => {
        refs.batchRunning.current = false;
        refs.planSink.current = null;
        if (alive()) setBatch(IDLE_UPGRADE_BATCH);
      });
    },
    [alive, refs]
  );

  const onProgress = useCallback(
    (completed: number) => {
      if (alive()) setBatch((prev) => ({ ...prev, completed }));
    },
    [alive]
  );

  const startAll = useCallback(
    (target: NodeRow[]) => {
      const signal = refs.abort.current?.signal;
      if (!signal || signal.aborted || refs.batchRunning.current) return;
      // 别的标签页正握着一份还在心跳的计划：另开一批只会两页对着同一堆机器互相覆盖。
      if (batchOwnedByOtherTab(entryNodeId, currentTabId(), io.now())) {
        toast.info(t('nodes.upgrade.allOtherTab'));
        return;
      }
      const running = launchUpgradeBatch({
        rows: target,
        latestVersion: latest?.latestVersion ?? null,
        rowRunning: refs.running.size > 0,
        restoring: refs.restoring.current.size > 0,
        signal,
        t,
        toasts: toast,
        confirm: (message) => globalThis.confirm?.(message) === true,
        runOne: (row, version, toasts) => runOnce(row, version, toasts),
        openPlan,
        onStart: (total, completed) => {
          refs.batchRunning.current = true;
          setBatch({ running: true, total, completed });
        },
        onProgress,
      });
      if (running) trackBatch(running);
    },
    [entryNodeId, io, latest, onProgress, openPlan, refs, runOnce, t, trackBatch]
  );

  useUpgradeBatchResume({
    refs,
    rows,
    io,
    t,
    latest,
    entryNodeId,
    readPlan,
    runOnce,
    trackBatch,
    setBatch,
    onProgress,
  });

  // 批量推进期间定时刷新计划的 `updatedAt`：别的标签页据此知道这批还有人在跑。
  useEffect(() => {
    if (!batch.running) return;
    const timer = setInterval(() => refs.planSink.current?.touch(), UPGRADE_BATCH_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [batch.running, refs]);

  return { batch, startAll };
}

/**
 * 刷新页面后升级还在目标机上跑：回读一遍状态，非 idle 的行直接接上轮询。
 * 回读中的行升级按钮先锁住，批量入口整体让路。
 */
export function useUpgradeRestore(p: {
  refs: UpgradeRefs;
  rows: NodeRow[];
  io: UpgradeIo;
  alive: () => boolean;
  readPlan: ReadPlan;
}): ReadonlySet<string> {
  const { refs, rows, io, alive, readPlan } = p;
  const [restoringIds, setRestoringIds] = useState<ReadonlySet<string>>(EMPTY_IDS);

  const track = useCallback(
    (next: ReadonlySet<string>) => {
      refs.restoring.current = next;
      return next;
    },
    [refs]
  );

  useEffect(() => {
    const signal = refs.abort.current?.signal;
    if (!signal || signal.aborted) return;
    // 先认出待续接的批量：属于它的行在回读接管时就该静音，结论留给最后那条汇总。
    readPlan();
    retainKnownIds(refs.restored, rows);
    const pending = restorableRows(rows).filter((row) => !refs.restored.has(row.id));
    if (pending.length === 0) return;
    for (const row of pending) refs.restored.add(row.id);
    refs.restoreActive.current += 1;
    setRestoringIds((prev) => {
      const next = new Set(prev);
      for (const row of pending) next.add(row.id);
      return track(next);
    });
    void restoreUpgradeStates({
      rows: pending,
      io,
      signal,
      gate: refs.restoreGate,
      skip: (nodeId) => refs.running.has(nodeId),
      onSettled: (nodeId) => {
        if (alive()) setRestoringIds((prev) => track(withId(prev, nodeId, false)));
      },
      onActive: (row, status) => {
        refs.resumeQueue.offer(row, status);
      },
    }).finally(() => {
      refs.restoreActive.current -= 1;
      // 回读收尾后才知道谁已被接管：这时开续跑不会与它抢同一台机器。
      refs.tryResume.current?.();
    });
  }, [alive, io, readPlan, refs, rows, track]);

  return restoringIds;
}
