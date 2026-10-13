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
  /** 任务所在的源节点（运行时 id）：离开页面再回来时要靠它把进度流续上。 */
  sourceNodeId: string;
  destNodeId: string;
  destRootId: string;
  destDir: string;
  /** 发起时选中的顶层项目数（结果文案用，不是展开后的文件数）。 */
  count: number;
}

// 模块级登记表：发起方（Provider）与收尾方（页头按钮里的 watcher）不在同一棵子树上。
const registry = new Map<string, ExplorerTransferRecord>();
const listeners = new Set<() => void>();
let nodeKey = '';

function notify(): void {
  nodeKey = [...new Set([...registry.values()].map((record) => record.sourceNodeId))]
    .sort()
    .join(',');
  for (const listener of [...listeners]) listener();
}

export function subscribeExplorerTransfers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 登记表里还没收尾的任务所在的源节点，逗号拼接（稳定的串，可直接喂 `useSyncExternalStore`）。 */
export function pendingExplorerTransferNodeKey(): string {
  return nodeKey;
}

/** `jobKey` 即 `transferJobKey(sourceNodeId, jobId)`。 */
export function registerExplorerTransfer(jobKey: string, record: ExplorerTransferRecord): void {
  registry.set(jobKey, record);
  // 建单返回的快照可能已经是终态（本机小文件），store 那次通知早于登记，得自己再叫一次
  notify();
}

export function pendingExplorerTransferCount(): number {
  return registry.size;
}

export function resetExplorerTransfersForTest(): void {
  registry.clear();
  listeners.clear();
  nodeKey = '';
}

function announce(t: TFunction, record: ExplorerTransferRecord, end: TransferEnd): void {
  const destExists = () => t(transferErrorKey('dest_exists'));
  switch (end.kind) {
    case 'done':
      toast.success(t('explorer.transfer.done', { count: end.count ?? record.count }));
      return;
    case 'partial':
      toast.warning(t('explorer.transfer.done', { count: end.count }), {
        description: end.rest === 'skipped' ? destExists() : t('explorer.transfer.failed'),
      });
      return;
    case 'skipped':
      toast.error(t('explorer.transfer.failed'), { description: destExists() });
      return;
    case 'failed':
      toast.error(t('explorer.transfer.failed'), { description: t(transferErrorKey(end.error)) });
      return;
    default:
      return;
  }
}

/** 把已到终态的登记项逐个收尾；仍在跑的留着。 */
export function settleExplorerTransfers(t: TFunction): void {
  let removed = false;
  for (const [jobKey, record] of [...registry]) {
    const view = getTransferJobView(jobKey);
    const end = view ? classifyTransferEnd(view) : null;
    if (end?.kind === 'pending') continue;
    registry.delete(jobKey);
    removed = true;
    // 行被「清除已结束」或 store 重置收走了（end 为 null）：没有结果可报
    if (!end) continue;
    void nodeQueryClient(record.destNodeId).invalidateQueries({
      queryKey: ['files', 'list', record.destRootId, record.destDir],
    });
    announce(t, record, end);
  }
  // 摘除发生在通知之前，重入的那次 settle 看不到已处理的项，不会重复弹
  if (removed) notify();
}

export function useExplorerTransferWatch(): void {
  const { t } = useTranslation();

  useEffect(() => {
    const check = () => settleExplorerTransfers(t);
    check();
    const offStore = subscribeTransferJobsStore(check);
    const offRegistry = subscribeExplorerTransfers(check);
    return () => {
      offStore();
      offRegistry();
    };
  }, [t]);
}
