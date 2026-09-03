// 窗口/pane 域动作：窗口与 pane 的结构增删改、终端输入下发、pane 数据订阅门面。
// 除 createWindow/clearPendingCreateWindow 记账 pendingCreateWindowAt 外，其余均为纯下发。

import type { PaneSubscriptionManager } from './pane-subscriptions';
import type { RuntimeCore } from './runtime';
import type { TmuxSetState, TmuxState } from './tmux-state';

export type TmuxWindowActions = Pick<
  TmuxState,
  | 'sendInput'
  | 'paste'
  | 'createWindow'
  | 'clearPendingCreateWindow'
  | 'closeWindow'
  | 'closePane'
  | 'renameWindow'
  | 'subscribePanes'
  | 'mountPane'
  | 'requestPaneScreen'
  | 'fetchPaneHistory'
  | 'splitPane'
  | 'renamePane'
  | 'movePane'
  | 'breakPane'
>;

export interface TmuxWindowActionsDeps {
  setState: TmuxSetState;
  paneSubscriptions: Pick<
    PaneSubscriptionManager,
    'setManualSubscriptions' | 'mountPane' | 'requestPaneScreen' | 'fetchPaneHistory'
  >;
}

export function createTmuxWindowActions(
  core: RuntimeCore,
  deps: TmuxWindowActionsDeps
): TmuxWindowActions {
  return {
    sendInput(deviceId, paneId, data, isComposing = false) {
      if (!deviceId || !paneId) return;
      core.transport.send({ type: 'terminal-input', deviceId, paneId, data, isComposing });
    },

    paste(deviceId, paneId, data) {
      if (!deviceId || !paneId) return;
      core.transport.send({ type: 'terminal-paste', deviceId, paneId, data });
    },

    createWindow(deviceId, name, cwd) {
      if (!deviceId) return;
      core.transport.send({ type: 'create-window', deviceId, name, cwd });
      deps.setState((prev) => ({
        pendingCreateWindowAt: { ...prev.pendingCreateWindowAt, [deviceId]: Date.now() },
      }));
    },

    clearPendingCreateWindow(deviceId) {
      if (!deviceId) return;
      deps.setState((prev) => {
        if (prev.pendingCreateWindowAt[deviceId] === undefined) return prev;
        const next = { ...prev.pendingCreateWindowAt };
        delete next[deviceId];
        return { pendingCreateWindowAt: next };
      });
    },

    closeWindow(deviceId, windowId) {
      if (!deviceId || !windowId) return;
      core.transport.send({ type: 'close-window', deviceId, windowId });
    },

    closePane(deviceId, paneId) {
      if (!deviceId || !paneId) return;
      core.transport.send({ type: 'close-pane', deviceId, paneId });
    },

    renameWindow(deviceId, windowId, name) {
      if (!deviceId || !windowId) return;
      core.transport.send({ type: 'rename-window', deviceId, windowId, name });
    },

    subscribePanes(deviceId, paneIds) {
      if (!deviceId) return;
      deps.paneSubscriptions.setManualSubscriptions(deviceId, paneIds);
    },

    mountPane(deviceId, paneId) {
      if (!deviceId || !paneId) return () => {};
      return deps.paneSubscriptions.mountPane(deviceId, paneId);
    },

    requestPaneScreen(deviceId, paneId) {
      if (!deviceId || !paneId) return;
      deps.paneSubscriptions.requestPaneScreen(deviceId, paneId);
    },

    fetchPaneHistory(deviceId, paneId, cursor = null) {
      if (!deviceId || !paneId) return;
      deps.paneSubscriptions.fetchPaneHistory(deviceId, paneId, cursor);
    },

    splitPane(deviceId, paneId, direction, cwd) {
      if (!deviceId || !paneId) return;
      core.transport.send({ type: 'split-pane', deviceId, paneId, direction, cwd });
    },

    renamePane(deviceId, paneId, name) {
      if (!deviceId || !paneId) return;
      core.transport.send({ type: 'rename-pane', deviceId, paneId, name });
    },

    movePane(deviceId, srcPaneId, dstPaneId, position) {
      if (!deviceId || !srcPaneId || !dstPaneId || srcPaneId === dstPaneId) return;
      core.transport.send({ type: 'move-pane', deviceId, srcPaneId, dstPaneId, position });
    },

    breakPane(deviceId, paneId) {
      if (!deviceId || !paneId) return;
      core.transport.send({ type: 'break-pane', deviceId, paneId });
    },
  };
}
