// 尺寸/视口域动作：终端 resize/sync 下发、可视区域声明、移动端拼接布局、窗内 pane 调整。
// 全部是纯下发（无本地状态写入），只需要 transport 与选择面的尺寸记账。

import type { RuntimeCore } from './runtime';
import { normalizeTerminalSize } from './select-pane-dispatch';
import type { TmuxState } from './tmux-state';

export type TmuxViewportActions = Pick<
  TmuxState,
  'resizePane' | 'syncPaneSize' | 'setPaneViewport' | 'resizePaneInWindow' | 'applyStackedLayout'
>;

export interface TmuxViewportActionsDeps {
  /** 记下本地权威尺寸，供远端回灌判定让位（见 tmux-selection-actions） */
  recordTerminalSize: (deviceId: string, cols: number, rows: number) => void;
}

export function createTmuxViewportActions(
  core: RuntimeCore,
  deps: TmuxViewportActionsDeps
): TmuxViewportActions {
  return {
    resizePane(deviceId, paneId, cols, rows) {
      if (!deviceId || !paneId) return;
      deps.recordTerminalSize(deviceId, cols, rows);
      core.transport.send({ type: 'terminal-resize', deviceId, paneId, cols, rows });
    },

    syncPaneSize(deviceId, paneId, cols, rows) {
      if (!deviceId || !paneId) return;
      deps.recordTerminalSize(deviceId, cols, rows);
      core.transport.send({ type: 'terminal-sync-size', deviceId, paneId, cols, rows });
    },

    setPaneViewport(deviceId, paneId, viewport) {
      if (!deviceId || !paneId) return;
      const normalized = normalizeTerminalSize(viewport.cols, viewport.rows);
      if (!normalized) return;
      core.transport.send({
        type: 'terminal-viewport',
        deviceId,
        paneId,
        cols: normalized.cols,
        rows: normalized.rows,
        visible: viewport.visible,
      });
    },

    resizePaneInWindow(deviceId, paneId, size) {
      if (!deviceId || !paneId) return;
      if (size.cols === undefined && size.rows === undefined) return;
      core.transport.send({ type: 'resize-pane-in-window', deviceId, paneId, ...size });
    },

    applyStackedLayout(deviceId, windowId, cols, rows) {
      if (!deviceId || !windowId) return;
      const normalized = normalizeTerminalSize(cols, rows);
      if (!normalized) return;
      core.transport.send({
        type: 'apply-stacked-layout',
        deviceId,
        windowId,
        cols: normalized.cols,
        rows: normalized.rows,
      });
    },
  };
}
