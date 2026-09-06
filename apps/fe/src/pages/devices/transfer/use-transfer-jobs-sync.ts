// 弹窗打开时把两侧节点上已有的任务拉回来并订阅进度；关闭时停掉所有订阅
// （任务本身跑在节点上，停的只是进度流）。

import { createNodeApiClient, listTransferJobs } from '@vibeterm/api-client';
import {
  isTerminalTransferState,
  stopAllTransferSubscriptions,
  subscribeTransferJob,
  upsertTransferJobSnapshot,
} from '@vibeterm/panels/files/transfers';
import { useEffect } from 'react';

export function useTransferJobsSync(open: boolean, nodeIds: readonly (string | null)[]): void {
  const key = nodeIds.filter((id): id is string => id !== null).join(',');

  useEffect(() => {
    if (!open) return;
    const ids = [...new Set(key.split(',').filter(Boolean))];
    const controller = new AbortController();

    for (const nodeId of ids) {
      const client = createNodeApiClient(nodeId);
      void listTransferJobs(client, controller.signal)
        .then((jobs) => {
          if (controller.signal.aborted) return;
          for (const job of jobs) {
            upsertTransferJobSnapshot(nodeId, job);
            if (!isTerminalTransferState(job.state)) {
              subscribeTransferJob({ nodeId, jobId: job.jobId, client });
            }
          }
        })
        .catch(() => undefined);
    }

    return () => {
      controller.abort();
    };
  }, [open, key]);

  // 弹窗一般是「关掉即卸载」，所以停订阅挂在卸载上；`open` 变 false 而组件仍在的场景一并覆盖。
  useEffect(() => {
    if (open) return;
    stopAllTransferSubscriptions();
  }, [open]);

  useEffect(() => () => stopAllTransferSubscriptions(), []);
}
