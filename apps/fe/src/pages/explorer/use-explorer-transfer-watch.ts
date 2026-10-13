// 文件管理器发起的节点间复制没有进度 Toast：任务落在共享的传输 store 里，这里盯着它们收尾——
// 到终态时刷新目标目录的列表并只弹一次结果，然后把登记项摘掉。

import { nodeQueryClient } from '@/node/node-runtimes';
import { getTransferJobView, subscribeTransferJobsStore } from '@vibeterm/panels/files/transfers';
import type { TFunction } from 'i18next';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { transferErrorKey } from '../devices/transfer/send-transfer';
import { type TransferEnd, classifyTransferEnd } from './explorer-transfer-plan';

export interface ExplorerTransferRecord {
  destNodeId: string;
  destRootId: string;
  destDir: string;
  /** 发起时选中的顶层项目数（结果文案用，不是展开后的文件数）。 */
  count: number;
}

// 模块级登记表：发起方（Provider）与收尾方（页头按钮里的 watcher）不在同一棵子树上。
const registry = new Map<string, ExplorerTransferRecord>();
const listeners = new Set<() => void>();

/** `jobKey` 即 `transferJobKey(sourceNodeId, jobId)`。 */
export function registerExplorerTransfer(jobKey: string, record: ExplorerTransferRecord): void {
  registry.set(jobKey, record);
  // 建单返回的快照可能已经是终态（本机小文件），store 那次通知早于登记，得自己再叫一次
  for (const listener of listeners) listener();
}

export function pendingExplorerTransferCount(): number {
  return registry.size;
}

export function resetExplorerTransfersForTest(): void {
  registry.clear();
}

function announce(t: TFunction, record: ExplorerTransferRecord, end: TransferEnd): void {
  if (end.kind === 'done') {
    toast.success(t('explorer.transfer.done', { count: record.count }));
  } else if (end.kind === 'failed') {
    toast.error(t('explorer.transfer.failed'), { description: t(transferErrorKey(end.error)) });
  } else if (end.kind === 'skipped') {
    toast.error(t('explorer.transfer.failed'), {
      description: t(transferErrorKey('dest_exists')),
    });
  }
}

/** 把已到终态的登记项逐个收尾；仍在跑的留着。 */
export function settleExplorerTransfers(t: TFunction): void {
  for (const [jobKey, record] of [...registry]) {
    const view = getTransferJobView(jobKey);
    if (!view) {
      // 行被「清除已结束」或 store 重置收走了，没有结果可报
      registry.delete(jobKey);
      continue;
    }
    const end = classifyTransferEnd(view);
    if (end.kind === 'pending') continue;
    registry.delete(jobKey);
    void nodeQueryClient(record.destNodeId).invalidateQueries({
      queryKey: ['files', 'list', record.destRootId, record.destDir],
    });
    announce(t, record, end);
  }
}

export function useExplorerTransferWatch(): void {
  const { t } = useTranslation();

  useEffect(() => {
    const check = () => settleExplorerTransfers(t);
    check();
    const offStore = subscribeTransferJobsStore(check);
    listeners.add(check);
    return () => {
      offStore();
      listeners.delete(check);
    };
  }, [t]);
}
