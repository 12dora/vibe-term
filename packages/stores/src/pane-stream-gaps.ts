// pane 流缺口账本 + 一次 select 下发的取舍。
//
// 「缺口」= 该 pane 的 live 字节被丢弃过（选择事务被作废时它的输出门控缓冲会被整体丢掉）。
// 终端还挂着但画面已经不权威，因此不能再当 warm 目标，必须靠一次落定的冷 select
// （reset + history）重建。缺口只有在补洞的那笔冷 select **真正落定**后才清除：
// ACK 超时、被拒、或还没落定就切走，缺口都要留着。

export interface SelectPaneDecisionInput {
  paneId: string;
  /** 调用方（保活池）认为目标是热的 */
  warmRequested: boolean;
  /** 目标 pane 的 live 流已知有缺口 */
  targetGapped: boolean;
  /** 客户端仍未落定的 select 事务针对的 pane；无事务（或链路走整屏原子下发）为 null */
  inFlightPaneId: string | null;
}

export interface SelectPaneDecision {
  wantHistory: boolean;
  /** 需要显式作废的在途事务的 pane；null 表示无需作废 */
  abandonPaneId: string | null;
  /** 门控缓冲被丢弃、之后不能再当 warm 目标的 pane；null 表示无 */
  gapPaneId: string | null;
}

/**
 * 网关对**每次** select 都会开新事务并取消上一笔，所以客户端这边任何未落定的旧事务
 * 都拿不到它那个 token 的 history/resume 了：旧事务连同它的输出门控必须在本次下发前
 * 清掉，否则那个 pane 的 live 会被永久缓冲在孤儿门控里（每帧还会续上 progress 期限），
 * 表现为画面冻结。
 *
 * - 目标自己就是那笔在途事务的 pane：只能走冷路径，让新 token 接管门控；
 * - 在途事务属于别的 pane：作废它并记缺口，目标该 warm 就 warm。
 */
export function resolveSelectPaneDecision({
  paneId,
  warmRequested,
  targetGapped,
  inFlightPaneId,
}: SelectPaneDecisionInput): SelectPaneDecision {
  const staleTransactionPaneId =
    inFlightPaneId !== null && inFlightPaneId !== paneId ? inFlightPaneId : null;
  const warm = warmRequested && !targetGapped && inFlightPaneId !== paneId;

  return {
    wantHistory: !warm,
    abandonPaneId: staleTransactionPaneId,
    gapPaneId: staleTransactionPaneId,
  };
}

interface RepairRecord {
  paneId: string;
  selectToken: Uint8Array;
  /** 观察到 history 确实会被写进终端（token 命中、状态 ACKED、门控未溢出） */
  historyCommitted: boolean;
}

export interface PaneStreamGaps {
  isGapped(deviceId: string, paneId: string): boolean;
  markGapped(deviceId: string, paneId: string): void;
  /** 该设备所有已知 pane 一并记缺口（流整体中断时用） */
  markDeviceGapped(deviceId: string, paneIds: Iterable<string>): void;
  /** 为补洞下发了冷 select；只有观察到「history 落地 + live 恢复」才算补上 */
  beginRepair(deviceId: string, paneId: string, selectToken: Uint8Array): void;
  /** 观察到该 token 的 history 会被真正应用 */
  noteHistoryCommitted(deviceId: string, selectToken: Uint8Array): void;
  /** 观察到该 token 的事务干净地恢复了 live：缺口才算补上 */
  completeRepair(deviceId: string, selectToken: Uint8Array): void;
  /**
   * 补洞的 select 失败/被作废：丢掉补洞记录，缺口保留。
   * 带 selectToken 时只作废该 token 的记录（避免误伤后来那笔事务的补洞）。
   */
  abortRepair(deviceId: string, selectToken?: Uint8Array): void;
  /** 快照更新：丢掉快照里已经不存在的 pane */
  retainLivePanes(deviceId: string, livePaneIds: ReadonlySet<string>): void;
  /** 设备流整体中断（断线/重连）：补洞记录作废 */
  resetDevice(deviceId: string): void;
  clear(): void;
}

function sameToken(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export function createPaneStreamGaps(): PaneStreamGaps {
  const gapped = new Map<string, Set<string>>();
  const repairs = new Map<string, RepairRecord>();

  function dropRepairFor(deviceId: string, paneId: string): void {
    if (repairs.get(deviceId)?.paneId === paneId) repairs.delete(deviceId);
  }

  function matchingRepair(deviceId: string, selectToken: Uint8Array): RepairRecord | null {
    const repair = repairs.get(deviceId);
    if (!repair || !sameToken(repair.selectToken, selectToken)) return null;
    return repair;
  }

  return {
    isGapped(deviceId, paneId) {
      return gapped.get(deviceId)?.has(paneId) === true;
    },

    markGapped(deviceId, paneId) {
      const panes = gapped.get(deviceId) ?? new Set<string>();
      panes.add(paneId);
      gapped.set(deviceId, panes);
      dropRepairFor(deviceId, paneId);
    },

    markDeviceGapped(deviceId, paneIds) {
      const panes = gapped.get(deviceId) ?? new Set<string>();
      for (const paneId of paneIds) panes.add(paneId);
      if (panes.size === 0) return;
      gapped.set(deviceId, panes);
      repairs.delete(deviceId);
    },

    beginRepair(deviceId, paneId, selectToken) {
      repairs.set(deviceId, { paneId, selectToken, historyCommitted: false });
    },

    noteHistoryCommitted(deviceId, selectToken) {
      const repair = matchingRepair(deviceId, selectToken);
      if (!repair) return;
      repair.historyCommitted = true;
    },

    completeRepair(deviceId, selectToken) {
      const repair = matchingRepair(deviceId, selectToken);
      if (!repair?.historyCommitted) return;
      repairs.delete(deviceId);
      const panes = gapped.get(deviceId);
      if (!panes?.delete(repair.paneId)) return;
      if (panes.size === 0) gapped.delete(deviceId);
    },

    abortRepair(deviceId, selectToken) {
      if (selectToken && !matchingRepair(deviceId, selectToken)) return;
      repairs.delete(deviceId);
    },

    retainLivePanes(deviceId, livePaneIds) {
      const panes = gapped.get(deviceId);
      if (!panes) return;
      for (const paneId of [...panes]) {
        if (!livePaneIds.has(paneId)) panes.delete(paneId);
      }
      if (panes.size === 0) gapped.delete(deviceId);
      const repairing = repairs.get(deviceId);
      if (repairing && !livePaneIds.has(repairing.paneId)) repairs.delete(deviceId);
    },

    resetDevice(deviceId) {
      gapped.delete(deviceId);
      repairs.delete(deviceId);
    },

    clear() {
      gapped.clear();
      repairs.clear();
    },
  };
}
