// 快捷键栏动作分发：纯 UI 动作（切键盘 / 回到底部）不依赖连接，
// send 与 paste / newAgentSession 才需要有效设备与 pane。

import type { TerminalShortcutAction, TerminalShortcutItem } from '@tmex/shared';
import type { AppRuntime } from '@tmex/stores';
import { useRuntime } from '@tmex/stores/react';
import type { TerminalRef } from '@tmex/terminal-ui';
import { type RefObject, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

/** 纯前端 UI 动作；认领了返回 true，交给 canInteractWithPane 守卫之后的分支返回 false。 */
function runUiAction(
  action: TerminalShortcutAction | undefined,
  runtime: AppRuntime,
  inputMode: 'direct' | 'editor',
  terminalRef: RefObject<TerminalRef | null>
): boolean {
  if (action === 'toggleKeyboard') {
    runtime.stores.ui.getState().setInputMode(inputMode === 'direct' ? 'editor' : 'direct');
    return true;
  }
  if (action === 'scrollToBottom') {
    terminalRef.current?.scrollToBottom();
    return true;
  }
  return false;
}

export interface UseTerminalShortcutActionsOptions {
  deviceId?: string;
  /** 已归一的 pane id（非路由段原值） */
  resolvedPaneId?: string;
  canInteractWithPane: boolean;
  inputMode: 'direct' | 'editor';
  terminalRef: RefObject<TerminalRef | null>;
}

export function useTerminalShortcutActions({
  deviceId,
  resolvedPaneId,
  canInteractWithPane,
  inputMode,
  terminalRef,
}: UseTerminalShortcutActionsOptions): (item: TerminalShortcutItem) => void {
  const { t } = useTranslation();
  const runtime = useRuntime();

  const handleSendShortcut = useCallback(
    (payload: string) => {
      if (!deviceId || !resolvedPaneId || !canInteractWithPane) {
        return;
      }

      // Send directly to the terminal's input handler
      const store = runtime.stores.tmux.getState();
      store.sendInput(deviceId, resolvedPaneId, payload, false);
    },
    [canInteractWithPane, deviceId, resolvedPaneId, runtime]
  );

  return useCallback(
    (item: TerminalShortcutItem) => {
      if (item.type === 'action' && runUiAction(item.action, runtime, inputMode, terminalRef)) {
        return;
      }
      if (item.type === 'send') {
        if (item.payload) {
          handleSendShortcut(item.payload);
        }
        return;
      }
      // 需要有效设备 / pane 的动作（paste / newAgentSession）
      if (!deviceId || !resolvedPaneId || !canInteractWithPane) {
        return;
      }
      if (item.action === 'paste') {
        // 非安全上下文 / 宿主 clipboard 不可用时给出明确错误而非静默
        void runtime.host
          .readClipboardText()
          .then((text) => {
            if (text) {
              runtime.stores.tmux.getState().paste(deviceId, resolvedPaneId, text);
            }
          })
          .catch(() => toast.error(t('terminal.pasteFailed')));
        return;
      }
      // agent UI 关闭时按钮已在渲染前过滤，这里再兜底一次
      if (item.action === 'newAgentSession' && runtime.features.agentUi) {
        runtime.stores.agent.getState().startDraft(deviceId, resolvedPaneId, null);
        runtime.stores.ui.getState().setSidebarCollapsed(false);
        runtime.stores.ui.getState().setSidebarTab('agent');
      }
    },
    [
      canInteractWithPane,
      deviceId,
      handleSendShortcut,
      inputMode,
      resolvedPaneId,
      runtime,
      t,
      terminalRef,
    ]
  );
}
