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

// 与状态机的 validateToken 同义：事件必须属于当前这笔事务。少了这一步，
// 一条过期 token 的 LIVE_RESUME 会「借用」后来那笔处于 HISTORY_APPLIED 的事务，
// 把还没补上的缺口清掉。
function currentTransaction(
  machine: SelectTransactionSource,
  deviceId: string,
  selectToken: Uint8Array
): SelectTransaction | null {
  const transaction = machine.getTransaction(deviceId);
  if (!transaction) return null;
  const expected = transaction.selectToken;
  if (expected.length !== selectToken.length) return null;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== selectToken[i]) return null;
  }
  return transaction;
}

export function observeSelectHistory(
  machine: SelectTransactionSource,
  gaps: PaneStreamGaps,
  deviceId: string,
  selectToken: Uint8Array
): void {
  const transaction = currentTransaction(machine, deviceId, selectToken);
  if (!transaction || transaction.state !== 'ACKED' || transaction.outputGapped) return;
  gaps.noteHistoryCommitted(deviceId, selectToken);
}

export function observeSelectLiveResume(
  machine: SelectTransactionSource,
  gaps: PaneStreamGaps,
  deviceId: string,
  selectToken: Uint8Array
): void {
  const transaction = currentTransaction(machine, deviceId, selectToken);
  if (!transaction || transaction.state !== 'HISTORY_APPLIED') return;
  if (transaction.outputGapped) {
    // 画面改由 rebase 重建，history 没落地：作废这笔补洞记录，缺口留着
    gaps.abortRepair(deviceId, selectToken);
    return;
  }
  gaps.completeRepair(deviceId, selectToken);
}
