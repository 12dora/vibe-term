// 节点升级的执行层：挂载生命周期、latest 查询、每行状态，以及「一个节点同时只跑一次升级」。
// 行内按钮、批量与回读续跑三条入口全部经由 `runExclusive` 领锁，也在那里领各自的 `AbortController`。

import type { NodeRow } from '@/node/mesh-nodes';
import type { UpgradeStatus } from '@tmex/shared';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  IDLE_UPGRADE_ENTRY,
  type NodeUpgradeEntry,
  type NodeUpgradeLatest,
  type UpgradeRunOutcome,
} from './types';
import { SILENT_UPGRADE_TOASTS, type Translate, type UpgradeToasts } from './upgrade-batch';
import type { UpgradeRefs } from './upgrade-refs';
import {
  type UpgradeCancelResult,
  type UpgradeIo,
  type UpgradeStartHandoff,
  cancelNodeUpgrade,
  fetchUpgradeLatest,
  resumeNodeUpgrade,
  runNodeUpgrade,
} from './use-node-upgrade';

type Patch = (nodeId: string, entry: Partial<NodeUpgradeEntry>) => void;
type RunExclusive = (
  row: NodeRow,
  runner: (signal: AbortSignal) => Promise<UpgradeRunOutcome>
) => Promise<UpgradeRunOutcome>;

export interface UpgradeRuntime {
  latest: NodeUpgradeLatest | null;
  alive: () => boolean;
  entryOf: (nodeId: string) => NodeUpgradeEntry;
  anyRunning: boolean;
  patch: Patch;
  runOnce: (
    row: NodeRow,
    version: string | null,
    toasts: UpgradeToasts
  ) => Promise<UpgradeRunOutcome>;
  runCancel: (row: NodeRow) => Promise<UpgradeCancelResult>;
}

/** 挂载生命周期与 latest 版本查询：宿主 `AbortController` 在这里生灭，`alive` 是所有写状态的前置条件。 */
function useUpgradeLifecycle(refs: UpgradeRefs): {
  latest: NodeUpgradeLatest | null;
  alive: () => boolean;
} {
  const [latest, setLatest] = useState<NodeUpgradeLatest | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    refs.abort.current = controller;
    return () => {
      controller.abort();
      refs.nodeAborts.stopAll();
      if (refs.abort.current === controller) refs.abort.current = null;
    };
  }, [refs]);

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
    refs.latestVersion.current = latest?.latestVersion ?? null;
  }, [latest, refs]);

  /** 组件已卸载就不再改状态：升级流程比页面活得久，patch 到死组件上只会报 warning。 */
  const alive = useCallback(() => refs.abort.current?.signal.aborted === false, [refs]);

  return { latest, alive };
}

/**
 * 单行互斥：同一个节点只能有一次升级在跑，行内按钮、批量与刷新恢复共用这把锁。
 * ref 负责同一 tick 内的同步判定，`anyRunning` 负责让工具栏按钮跟着变灰——两者必须一起改。
 */
function useExclusiveRunner(
  refs: UpgradeRefs,
  alive: () => boolean
): { anyRunning: boolean; runExclusive: RunExclusive } {
  const [runningCount, setRunningCount] = useState(0);

  const runExclusive = useCallback<RunExclusive>(
    (row, runner) => {
      if (refs.running.has(row.id)) return Promise.resolve<UpgradeRunOutcome>('cancelled');
      const controller = refs.nodeAborts.open(row.id);
      refs.running.add(row.id);
      if (alive()) setRunningCount(refs.running.size);
      const settle = (outcome: UpgradeRunOutcome) => {
        refs.running.delete(row.id);
        refs.inFlight.delete(row.id);
        refs.nodeAborts.release(row.id, controller);
        if (alive()) setRunningCount(refs.running.size);
        // 回读到的在途升级要是被这次升级挡在门外，现在轮到它接手了。
        refs.resumeQueue.release(row.id, outcome);
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
      refs.inFlight.set(row.id, running);
      return running;
    },
    [alive, refs]
  );

  return { anyRunning: runningCount > 0, runExclusive };
}

/** 「停止升级」：DELETE 与它的收尾记账，以及 POST 在途时的补发交接（`startHandoff`）。 */
function useUpgradeCancel(p: {
  refs: UpgradeRefs;
  io: UpgradeIo;
  t: Translate;
  patch: Patch;
  onChanged: () => void;
}): {
  runCancel: (row: NodeRow) => Promise<UpgradeCancelResult>;
  startHandoff: (row: NodeRow) => UpgradeStartHandoff;
} {
  const { refs, io, t, patch, onChanged } = p;

  /** `deferred` 表示改由 POST 落地后补发，按钮保持「停止中」。 */
  const runCancel = useCallback(
    (row: NodeRow): Promise<UpgradeCancelResult> => {
      const gate = refs.cancelGate;
      const signal = refs.abort.current?.signal;
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
        stopWatch: () => refs.nodeAborts.stop(row.id),
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
    [io, onChanged, patch, refs, t]
  );

  const startHandoff = useCallback(
    (row: NodeRow): UpgradeStartHandoff => {
      const gate = refs.cancelGate;
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
    [patch, refs, runCancel]
  );

  return { runCancel, startHandoff };
}

/** 两条执行入口：`runOnce` 从 POST 起跑，`resumeOnce` 接管回读到的在途升级。 */
function useUpgradeRunners(p: {
  refs: UpgradeRefs;
  io: UpgradeIo;
  t: Translate;
  patch: Patch;
  onChanged: () => void;
  runExclusive: RunExclusive;
  startHandoff: (row: NodeRow) => UpgradeStartHandoff;
}): UpgradeRuntime['runOnce'] {
  const { refs, io, t, patch, onChanged, runExclusive, startHandoff } = p;

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
          targetVersion: refs.latestVersion.current,
          io,
          signal,
          t,
          // 属于待续接批量的行：每行的结论交给最后那条汇总，不逐台刷屏。
          toasts: refs.planIds.current.has(row.id) ? SILENT_UPGRADE_TOASTS : toast,
          patch: (entry) => patch(row.id, entry),
          onChanged,
        })
      ),
    [io, onChanged, patch, refs, runExclusive, t]
  );

  useEffect(() => {
    refs.resume.current = (row, status) => {
      void resumeOnce(row, status);
    };
  }, [refs, resumeOnce]);

  return runOnce;
}

export function useUpgradeRuntime(
  refs: UpgradeRefs,
  onChanged: () => void,
  io: UpgradeIo,
  t: Translate
): UpgradeRuntime {
  const [entries, setEntries] = useState<Record<string, NodeUpgradeEntry>>({});
  const { latest, alive } = useUpgradeLifecycle(refs);
  const { anyRunning, runExclusive } = useExclusiveRunner(refs, alive);

  const patch = useCallback<Patch>(
    (nodeId, entry) => {
      if (!alive()) return;
      setEntries((prev) => ({
        ...prev,
        [nodeId]: { ...(prev[nodeId] ?? IDLE_UPGRADE_ENTRY), ...entry },
      }));
    },
    [alive]
  );

  const { runCancel, startHandoff } = useUpgradeCancel({ refs, io, t, patch, onChanged });
  const runOnce = useUpgradeRunners({
    refs,
    io,
    t,
    patch,
    onChanged,
    runExclusive,
    startHandoff,
  });

  const entryOf = useCallback((nodeId: string) => entries[nodeId] ?? IDLE_UPGRADE_ENTRY, [entries]);

  return { latest, alive, entryOf, anyRunning, patch, runOnce, runCancel };
}
