// 批量内存限额的状态机：分拣 → 一份草稿 → 并发写入 → 逐台成败。
//
// 「自定义限额」是把同一份记录写到所选节点上，不逐台 GET 再合并：用户说不清自己到底改了什么。
// 「不限制」例外：它不带任何数字，逐台读出现值只翻开关，免得把各节点的采样周期一并改掉。

import type { NodeRow } from '@/node/mesh-nodes';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { MemoryLimitsBatchWrite } from '../memory-limits-form';
import {
  type MemoryLimitsFailure,
  type MemoryLimitsIo,
  type MemoryLimitsPlan,
  defaultMemoryLimitsIo,
  memoryLimitsSummaryText,
  planMemoryLimits,
  runMemoryLimitsBatch,
} from './node-memory-limits';

export interface MemoryLimitsBatchController {
  /** 当前待确认 / 正在写入的分拣结果；没有时为 `null`。 */
  plan: MemoryLimitsPlan | null;
  running: boolean;
  /** 上一批写失败的节点；成功收尾时清空。 */
  failures: MemoryLimitsFailure[];
  request: (rows: NodeRow[]) => void;
  dismiss: () => void;
  /** 把这份写入落到 `plan.targets` 上。 */
  run: (write: MemoryLimitsBatchWrite) => void;
}

export function useMemoryLimitsBatch(io: MemoryLimitsIo = defaultMemoryLimitsIo) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<MemoryLimitsPlan | null>(null);
  const [running, setRunning] = useState(false);
  const [failures, setFailures] = useState<MemoryLimitsFailure[]>([]);

  const request = useCallback((rows: NodeRow[]) => {
    setFailures([]);
    setPlan(planMemoryLimits(rows));
  }, []);

  const dismiss = useCallback(() => {
    setPlan(null);
    setFailures([]);
  }, []);

  const run = useCallback(
    (write: MemoryLimitsBatchWrite) => {
      const targets = plan?.targets ?? [];
      if (targets.length === 0 || running) return;
      setRunning(true);
      setFailures([]);
      void (async () => {
        try {
          const summary = await runMemoryLimitsBatch({ targets, write, io, t });
          const { level, text } = memoryLimitsSummaryText(t, summary);
          if (level === 'success') toast.success(text);
          else toast.error(text);
          // 全成功才关框：还有失败的节点时把它们留在框里，用户改完能就地重试。
          setFailures(summary.failed);
          if (summary.failed.length === 0) setPlan(null);
        } finally {
          setRunning(false);
        }
      })();
    },
    [io, plan, running, t]
  );

  return useMemo<MemoryLimitsBatchController>(
    () => ({ plan, running, failures, request, dismiss, run }),
    [dismiss, failures, plan, request, run, running]
  );
}
