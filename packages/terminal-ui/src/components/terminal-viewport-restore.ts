import { type TerminalSizeSnapshot, shouldSyncOnViewportRestore } from '../utils/resizeSyncGuards';

export type ViewportRestoreOutcome = 'skipped' | 'repainted' | 'synced';

/** 挂起标记由 hook 侧持有，控制器随监听器 effect 重建时状态不丢 */
export interface ViewportRestorePendingState {
  current: boolean;
}

export interface ViewportRestoreDeps {
  pending: ViewportRestorePendingState;
  getCurrentSize: () => TerminalSizeSnapshot | null;
  measureContainerSize: () => TerminalSizeSnapshot | null;
  forceFullRepaint: () => void;
  requestSync: () => void;
}

export interface ViewportRestoreController {
  restore: () => ViewportRestoreOutcome;
  handleVisibilityChange: (visible: boolean) => void;
  handleWindowBlur: () => void;
  handleWindowFocus: () => void;
}

export function createViewportRestoreController(
  deps: ViewportRestoreDeps
): ViewportRestoreController {
  const restore = (): ViewportRestoreOutcome => {
    const currentSize = deps.getCurrentSize();
    const containerSize = deps.measureContainerSize();
    if (!currentSize || !containerSize) {
      return 'skipped';
    }

    if (!shouldSyncOnViewportRestore({ currentSize, containerSize })) {
      // canvas 位图可能在容器尺寸变化 / DOM 重插入中被 resize 清空，但 ghostty 内核
      // 仍报 dirty='clean'。强制 renderer 全画以避免空白（issue #45 bug 3）。
      deps.forceFullRepaint();
      return 'repainted';
    }

    deps.requestSync();
    return 'synced';
  };

  const consumePending = (): void => {
    if (!deps.pending.current) {
      return;
    }
    deps.pending.current = false;
    restore();
  };

  return {
    restore,
    handleVisibilityChange: (visible) => {
      if (!visible) {
        deps.pending.current = true;
        return;
      }
      consumePending();
    },
    handleWindowBlur: () => {
      deps.pending.current = true;
    },
    handleWindowFocus: consumePending,
  };
}
