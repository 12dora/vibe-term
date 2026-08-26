import { useTmuxStore } from '@tmex/stores/react';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import { useCallback, useEffect } from 'react';
import {
  registerCursorRectGetter,
  unregisterCursorRectGetter,
} from '../../utils/keyboard-cursor-bridge';
import type { TerminalProps } from '../types';
import { useLatestRef } from './useLatestRef';

/** Shift+Enter：CSI u 编码的 Enter，交给 pane 内程序自行区分换行与提交 */
const SHIFT_ENTER_SEQUENCE = '\x1b[13;2u';

export interface UseTerminalInputOptions {
  deviceId: string;
  paneId: string;
  instance: CompatibleTerminalLike | null;
  inputMode: TerminalProps['inputMode'];
  deviceConnected: boolean;
  isSelectionInvalid: boolean;
  autoFocus: boolean;
  focused: boolean;
}

/**
 * 终端输入面：键盘/IME/鼠标数据回送 tmux、自定义快捷键拦截，以及焦点与光标矩形上报。
 */
export function useTerminalInput({
  deviceId,
  paneId,
  instance,
  inputMode,
  deviceConnected,
  isSelectionInvalid,
  autoFocus,
  focused,
}: UseTerminalInputOptions): void {
  const sendInput = useTmuxStore((state) => state.sendInput);
  const currentDeviceIdRef = useLatestRef(deviceId);
  const currentPaneIdRef = useLatestRef(paneId);
  const canWriteRef = useLatestRef(deviceConnected && !isSelectionInvalid);

  const sendTerminalInput = useCallback(
    (data: string) => {
      if (!data || inputMode !== 'direct') {
        return;
      }
      if (!canWriteRef.current) {
        return;
      }

      const activeDeviceId = currentDeviceIdRef.current;
      const activePaneId = currentPaneIdRef.current;
      if (!activeDeviceId || !activePaneId) {
        return;
      }

      sendInput(activeDeviceId, activePaneId, data, false);
    },
    [canWriteRef, currentDeviceIdRef, currentPaneIdRef, inputMode, sendInput]
  );

  useEffect(() => {
    instance?.setFocused?.(focused);
  }, [instance, focused]);

  useEffect(() => {
    if (!instance || !('setDisableStdin' in instance)) {
      return;
    }

    (instance as any).setDisableStdin(inputMode === 'editor');
  }, [instance, inputMode]);

  // 注册当前终端的光标矩形 getter，供 main.tsx 键盘避让（光标对齐模式）按需读取。
  // getter 内部按聚焦判定，编辑器模式/其他终端聚焦时返回 null，宿主自动回退整页上移。
  useEffect(() => {
    if (!instance?.getCursorViewportRect) {
      return;
    }
    const getter = () => instance.getCursorViewportRect?.() ?? null;
    registerCursorRectGetter(getter);
    return () => unregisterCursorRectGetter(getter);
  }, [instance]);

  // direct 模式下终端就绪（刷新、切换 pane 导致的重新挂载）或从 editor 切回时，
  // 焦点应回到终端；移动端跳过，避免自动弹出软键盘
  useEffect(() => {
    if (!instance || inputMode !== 'direct' || !autoFocus) {
      return;
    }
    const isMobileLike = window.innerWidth < 768 || 'ontouchstart' in window;
    if (isMobileLike) {
      return;
    }
    instance.focus();
  }, [instance, inputMode, autoFocus]);

  useEffect(() => {
    if (!instance || !deviceId || !paneId) return;

    const disposable = instance.onData((data) => {
      if (!deviceConnected || isSelectionInvalid) return;
      sendTerminalInput(data);
    });

    instance.attachCustomKeyEventHandler((domEvent) => {
      if (!deviceConnected || isSelectionInvalid) return true;
      if (domEvent.type !== 'keydown') return true;
      if (inputMode !== 'direct') return true;

      if (domEvent.shiftKey && domEvent.key === 'Enter') {
        domEvent.preventDefault();
        sendTerminalInput(SHIFT_ENTER_SEQUENCE);
        return false;
      }

      return true;
    });

    return () => {
      disposable.dispose();
      instance.attachCustomKeyEventHandler(() => true);
    };
  }, [
    instance,
    deviceConnected,
    isSelectionInvalid,
    inputMode,
    sendTerminalInput,
    deviceId,
    paneId,
  ]);
}
