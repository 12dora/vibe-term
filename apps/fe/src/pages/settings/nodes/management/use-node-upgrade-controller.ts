// 节点升级的 React 编排层入口：把 `use-node-upgrade.ts` 里那套与框架无关的执行逻辑接到组件状态上。
//
// 四段各管一摊，`useNodeUpgrade` 只负责按顺序把它们串起来：
//   useUpgradeRuntime    —— 挂载生命周期、latest 查询、每行状态，以及单行互斥与执行入口
//   useUpgradeBatchPlan  —— 落盘的批量计划的读与写（无 effect）
//   useUpgradeRestore    —— 刷新页面后的在途升级回读
//   useUpgradeBatch      —— 批量计划的开启 / 续跑 / 心跳与批量进度
//   useUpgradeRowActions —— 行内「升级」「停止升级」两个按钮
//
// 次序不是随便排的：回读必须比批量续跑先注册 effect，否则节点列表刚到的那一帧续跑会抢在前面，
// 对仍在升级的节点重发 POST（撞 `UPGRADE_IN_PROGRESS`，还会提前去动下一组 hub）。
//
// 跨段共享的可变量集中在 `UpgradeRefs`（见 `upgrade-refs.ts`）。

import type { NodeRow } from '@/node/mesh-nodes';
import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { NodeUpgradeController, NodeUpgradeLatest } from './types';
import { type Translate, eligibleUpgradeRows } from './upgrade-batch';
import { type UpgradeRefs, createUpgradeRefs } from './upgrade-refs';
import { type UpgradeIo, defaultUpgradeIo, launchRowUpgrade } from './use-node-upgrade';
import { useUpgradeBatch, useUpgradeBatchPlan, useUpgradeRestore } from './use-upgrade-batch';
import { type UpgradeRuntime, useUpgradeRuntime } from './use-upgrade-runtime';

/** 行内两个按钮：「升级」走确认 + 单行执行，「停止升级」按闸门状态决定现在发还是等 POST 落地补发。 */
function useUpgradeRowActions(p: {
  refs: UpgradeRefs;
  t: Translate;
  latest: NodeUpgradeLatest | null;
  patch: UpgradeRuntime['patch'];
  runOnce: UpgradeRuntime['runOnce'];
  runCancel: UpgradeRuntime['runCancel'];
}): { start: (row: NodeRow) => void; cancel: (row: NodeRow) => void } {
  const { refs, t, latest, patch, runOnce, runCancel } = p;

  const start = useCallback(
    (row: NodeRow) => {
      const signal = refs.abort.current?.signal;
      if (!signal || signal.aborted) return;
      void launchRowUpgrade({
        row,
        latestVersion: latest?.latestVersion ?? null,
        batchRunning: refs.batchRunning.current,
        nodeRunning: refs.running.has(row.id),
        restoring: refs.restoring.current.has(row.id),
        t,
        confirm: (message) => globalThis.confirm?.(message) === true,
        runOne: (target, version) => runOnce(target, version, toast),
      });
    },
    [latest, refs, runOnce, t]
  );

  const cancel = useCallback(
    (row: NodeRow) => {
      const mode = refs.cancelGate.request(row.id);
      // 已经有一次取消在途：连点不再发第二条 DELETE。
      if (mode === 'busy') return;
      patch(row.id, { cancelling: true });
      // POST 还在途：DELETE 现在发出去只会扑空，等它落地由 `startHandoff` 补发。
      if (mode === 'defer') return;
      void runCancel(row);
    },
    [patch, refs, runCancel]
  );

  return { start, cancel };
}

export function useNodeUpgrade(
  rows: NodeRow[],
  onChanged: () => void,
  io: UpgradeIo = defaultUpgradeIo
): NodeUpgradeController {
  const { t } = useTranslation();
  const refsRef = useRef<UpgradeRefs | null>(null);
  refsRef.current ??= createUpgradeRefs();
  const refs = refsRef.current;

  const runtime = useUpgradeRuntime(refs, onChanged, io, t);
  const plan = useUpgradeBatchPlan(refs, rows, io);
  const restoringIds = useUpgradeRestore({
    refs,
    rows,
    io,
    alive: runtime.alive,
    readPlan: plan.readPlan,
  });
  const { batch, startAll } = useUpgradeBatch({
    refs,
    rows,
    io,
    t,
    latest: runtime.latest,
    alive: runtime.alive,
    runOnce: runtime.runOnce,
    plan,
  });
  const { start, cancel } = useUpgradeRowActions({
    refs,
    t,
    latest: runtime.latest,
    patch: runtime.patch,
    runOnce: runtime.runOnce,
    runCancel: runtime.runCancel,
  });

  const latestVersion = runtime.latest?.latestVersion ?? null;
  const eligibleCount = useCallback(
    (target: NodeRow[]) => eligibleUpgradeRows(target, latestVersion).length,
    [latestVersion]
  );

  return {
    latest: runtime.latest,
    entryOf: runtime.entryOf,
    start,
    startAll,
    cancel,
    batch,
    eligibleCount,
    anyRunning: runtime.anyRunning,
    restoring: restoringIds.size > 0,
    restoringIds,
  };
}
