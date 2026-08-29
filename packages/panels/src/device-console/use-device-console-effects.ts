// 控制台的副作用集合：输入模式切换/跳转事件的回到底部、设备错误提示、浏览器标题。

import { useBellStore } from '@tmex/notifications';
import { PRODUCT_NAME, type TmuxPane, type TmuxWindow } from '@tmex/shared';
import { buildBrowserTitle, buildTerminalLabel } from '@tmex/stores';
import { useSiteStore } from '@tmex/stores/react';
import type { TerminalRef } from '@tmex/terminal-ui';
import { type RefObject, useEffect, useMemo } from 'react';
import { toast } from 'sonner';

export interface UseDeviceConsoleEffectsOptions {
  deviceId?: string;
  deviceName?: string;
  deviceErrorMessage?: string;
  selectedWindow?: TmuxWindow;
  selectedPane?: TmuxPane;
  inputMode: 'direct' | 'editor';
  terminalRef: RefObject<TerminalRef | null>;
  formatBrowserTitle?: (label: string | null) => string;
}

/** 终端标签：未选中窗格时为 null；铃响的窗格前缀 🔔。 */
function useTerminalLabel({
  deviceId,
  deviceName,
  selectedWindow,
  selectedPane,
}: Pick<
  UseDeviceConsoleEffectsOptions,
  'deviceId' | 'deviceName' | 'selectedWindow' | 'selectedPane'
>): string | null {
  const ringingPanes = useBellStore((state) => state.ringingPanes);
  return useMemo(() => {
    if (!selectedWindow || !selectedPane) {
      return null;
    }
    const label = buildTerminalLabel({
      paneCustomName: selectedPane.customName,
      paneTitle: selectedPane.title,
      windowName: selectedWindow.name,
      windowCustomName: selectedWindow.customName,
      deviceName: deviceName ?? deviceId,
    });
    return ringingPanes[selectedPane.id] ? `🔔 ${label}` : label;
  }, [deviceName, deviceId, selectedPane, selectedWindow, ringingPanes]);
}

/** 下一帧 + 120ms 各滚一次：等布局/字体稳定后再兜底一次。 */
function scrollToBottomTwice(terminalRef: RefObject<TerminalRef | null>) {
  const rafId = window.requestAnimationFrame(() => {
    terminalRef.current?.scrollToBottom();
  });
  const timerId = window.setTimeout(() => {
    terminalRef.current?.scrollToBottom();
  }, 120);

  return () => {
    window.cancelAnimationFrame(rafId);
    window.clearTimeout(timerId);
  };
}

export function useDeviceConsoleEffects({
  deviceId,
  deviceName,
  deviceErrorMessage,
  selectedWindow,
  selectedPane,
  inputMode,
  terminalRef,
  formatBrowserTitle,
}: UseDeviceConsoleEffectsOptions) {
  const siteName = useSiteStore((state) => state.settings?.siteName ?? PRODUCT_NAME);
  const terminalLabel = useTerminalLabel({ deviceId, deviceName, selectedWindow, selectedPane });

  useEffect(() => {
    void inputMode;
    return scrollToBottomTwice(terminalRef);
  }, [inputMode, terminalRef]);

  useEffect(() => {
    if (!deviceErrorMessage) {
      return;
    }

    toast.error(deviceErrorMessage);
  }, [deviceErrorMessage]);

  useEffect(() => {
    document.title = formatBrowserTitle
      ? formatBrowserTitle(terminalLabel ?? null)
      : buildBrowserTitle(terminalLabel);
    return () => {
      document.title = formatBrowserTitle ? formatBrowserTitle(null) : siteName;
    };
  }, [siteName, terminalLabel, formatBrowserTitle]);

  useEffect(() => {
    const handler = () => {
      terminalRef.current?.scrollToBottom();
    };

    window.addEventListener('tmex:jump-to-latest', handler as EventListener);
    return () => {
      window.removeEventListener('tmex:jump-to-latest', handler as EventListener);
    };
  }, [terminalRef]);
}
