// 选择事务的观察点：把状态机的内部判定「镜像」成缺口账本能用的显式信号。
//
// 不能从「事务消失了」反推补洞成功：门控缓冲溢出时状态机会置 outputGapped、
// 跳过 reset/apply 改由 rebase 重建画面，但事务照样正常摘除。因此这里在
// 派发 HISTORY / LIVE_RESUME **之前**读事务，用与状态机相同的条件判断这一步
// 到底会不会把权威画面写进终端。

import type { SelectTransaction } from '@tmex/ws-client';
import type { PaneStreamGaps } from './pane-stream-gaps';

export interface SelectTransactionSource {
  getTransaction(deviceId: string): SelectTransaction | undefined;
}

export function observeSelectHistory(
  machine: SelectTransactionSource,
  gaps: PaneStreamGaps,
  deviceId: string,
  selectToken: Uint8Array
): void {
  const transaction = machine.getTransaction(deviceId);
  if (!transaction || transaction.state !== 'ACKED' || transaction.outputGapped) return;
  gaps.noteHistoryCommitted(deviceId, selectToken);
}

export function observeSelectLiveResume(
  machine: SelectTransactionSource,
  gaps: PaneStreamGaps,
  deviceId: string,
  selectToken: Uint8Array
): void {
  const transaction = machine.getTransaction(deviceId);
  if (!transaction || transaction.state !== 'HISTORY_APPLIED' || transaction.outputGapped) return;
  gaps.completeRepair(deviceId, selectToken);
}
