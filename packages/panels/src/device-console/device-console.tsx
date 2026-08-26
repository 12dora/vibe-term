// 设备终端控制台主体：单屏/分屏终端渲染、快捷键栏、编辑器输入的组合根。
// pane 选择与 URL 同步见 ./use-device-pane-selection，editor 输入见 ./use-editor-input。
// 路由参数由宿主显式传入（paneId 为路由段原值，React Router 已 decode 一次，
// 包内经 decodePaneIdFromUrlParam 归一，宿主不要再 decode）；包内构造的应用内
// 路径一律经 hostAppPath 映射宿主路由形状。

import { useQuery } from '@tanstack/react-query';
import { devicesQueryKey as defaultDevicesQueryKey, fetchDevices } from '@tmex/api-client';
import { useBellStore } from '@tmex/notifications';
import type { TerminalShortcutItem } from '@tmex/shared';
import { buildBrowserTitle, buildTerminalLabel, decodePaneIdFromUrlParam } from '@tmex/stores';
import { useRuntime, useSiteStore, useTmuxStore, useUIStore } from '@tmex/stores/react';
import {
  SplitTerminalArea,
  Terminal as TerminalComponent,
  type TerminalRef,
  XTERM_THEME_DARK,
  XTERM_THEME_LIGHT,
  isIOSMobileBrowser,
} from '@tmex/terminal-ui';
import { Button } from '@tmex/ui/button';
import { Switch } from '@tmex/ui/switch';
import { Loader2, SearchX, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { DeviceStatusBadge } from '../device-status-badge';
import { ShortcutsBar, TerminalShortcutsSlot } from './terminal-shortcuts-slot';
import { useDevicePaneSelection } from './use-device-pane-selection';
import { useEditorInput } from './use-editor-input';

export interface DeviceConsoleProps {
  deviceId?: string;
  windowId?: string;
  /** 路由段原值（React Router 已 decode 一次），包内做归一，宿主不要再 decode */
  paneId?: string;
  /** devices 列表查询 key（与其他消费方共享缓存时保持一致），缺省 ['devices'] */
  devicesQueryKey?: readonly unknown[];
  /** 自定义浏览器标签页标题：入参为当前终端标签（未选中窗格时为 null），
   *  返回完整 document.title；卸载时以 formatBrowserTitle(null) 复原。
   *  缺省沿用 buildBrowserTitle（`[siteName]label`）与 siteName 复原。 */
  formatBrowserTitle?: (label: string | null) => string;
  prepareTerminalResources?: (fontId: string, fontSize: number) => Promise<void>;
}

export function DeviceConsole({
  deviceId,
  windowId,
  paneId,
  devicesQueryKey = defaultDevicesQueryKey,
  formatBrowserTitle,
  prepareTerminalResources,
}: DeviceConsoleProps) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<TerminalRef>(null);
  const iosAddressBarCollapseTried = useRef(false);

  const snapshot = useTmuxStore((state) => (deviceId ? state.snapshots[deviceId] : undefined));
  const deviceError = useTmuxStore((state) =>
    deviceId ? state.deviceErrors?.[deviceId] : undefined
  );
  const deviceConnected = useTmuxStore((state) =>
    deviceId ? (state.deviceConnected?.[deviceId] ?? false) : false
  );
  const deviceReconnecting = useTmuxStore((state) =>
    deviceId ? state.deviceReconnecting?.[deviceId] : undefined
  );
  const isReconnecting = Boolean(deviceReconnecting);
  const siteName = useSiteStore((state) => state.settings?.siteName ?? 'tmex');

  const resolvedPaneId = useMemo(() => decodePaneIdFromUrlParam(paneId), [paneId]);
  const draftKey = useMemo(
    () => (deviceId && resolvedPaneId ? `${deviceId}:${resolvedPaneId}` : null),
    [deviceId, resolvedPaneId]
  );

  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && (window.innerWidth < 768 || 'ontouchstart' in window)
  );
  const isIOSBrowser = useMemo(() => isIOSMobileBrowser(), []);

  // Mobile detection
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768 || 'ontouchstart' in window);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // iOS address bar collapse
  useEffect(() => {
    if (!isMobile || !isIOSBrowser || iosAddressBarCollapseTried.current) {
      return;
    }

    iosAddressBarCollapseTried.current = true;
    const collapseAddressBar = () => {
      window.scrollTo(0, 1);
    };

    const rafId = window.requestAnimationFrame(collapseAddressBar);
    const timerA = window.setTimeout(collapseAddressBar, 120);
    const timerB = window.setTimeout(collapseAddressBar, 420);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timerA);
      window.clearTimeout(timerB);
    };
  }, [isIOSBrowser, isMobile]);

  const inputMode = useUIStore((state) => state.inputMode);
  const uiTheme = useUIStore((state) => state.theme);
  const terminalFontId = useUIStore((state) => state.terminalFontId);
  const terminalFontSize = useUIStore((state) => state.terminalFontSize);
  const editorSendWithEnter = useUIStore((state) => state.editorSendWithEnter);
  const setEditorSendWithEnter = useUIStore((state) => state.setEditorSendWithEnter);

  const windows = snapshot?.session?.windows;
  const terminalTheme = uiTheme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME_DARK;
  const prepareResources = useCallback(
    () => prepareTerminalResources?.(terminalFontId, terminalFontSize) ?? Promise.resolve(),
    [prepareTerminalResources, terminalFontId, terminalFontSize]
  );

  const { data: devicesData } = useQuery({
    queryKey: devicesQueryKey,
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
  });

  const currentDevice = useMemo(() => {
    if (!deviceId) {
      return undefined;
    }
    return devicesData?.devices.find((device) => device.id === deviceId);
  }, [deviceId, devicesData?.devices]);

  const selectedWindow = useMemo(() => {
    if (!windowId || !windows) return undefined;
    return windows.find((win) => win.id === windowId);
  }, [windowId, windows]);

  const selectedPane = useMemo(() => {
    if (!resolvedPaneId || !selectedWindow) return undefined;
    return selectedWindow.panes.find((pane) => pane.id === resolvedPaneId);
  }, [resolvedPaneId, selectedWindow]);

  const {
    isWindowMissing,
    isPaneMissing,
    isSelectionInvalid,
    isSplitView,
    canInteractWithPane,
    handleResize,
    handleSync,
    handleResizeSettled,
    handleUserSelectPane,
  } = useDevicePaneSelection({
    deviceId,
    windowId,
    resolvedPaneId,
    windows,
    selectedWindow,
    selectedPane,
    deviceConnected,
    isMobile,
    terminalRef,
    terminalContainerRef,
  });

  const invalidSelectionMessage = !isSelectionInvalid
    ? null
    : isWindowMissing
      ? t('terminal.windowClosed')
      : isPaneMissing
        ? t('terminal.paneClosed')
        : null;

  const ringingPanes = useBellStore((state) => state.ringingPanes);
  const terminalTopbarLabel = useMemo(() => {
    if (!selectedWindow || !selectedPane) {
      return null;
    }
    const deviceName = currentDevice?.name ?? deviceId;
    const label = buildTerminalLabel({
      paneCustomName: selectedPane.customName,
      paneTitle: selectedPane.title,
      windowName: selectedWindow.name,
      windowCustomName: selectedWindow.customName,
      deviceName,
    });
    return ringingPanes[selectedPane.id] ? `🔔 ${label}` : label;
  }, [currentDevice?.name, deviceId, selectedPane, selectedWindow, ringingPanes]);

  const {
    editorText,
    editorTextareaRef,
    isSending,
    focusEditor,
    handleEditorChange,
    handleEditorSend,
    handleEditorSendLineByLine,
    handleEditorClear,
  } = useEditorInput({
    deviceId,
    paneId: resolvedPaneId,
    draftKey,
    canInteractWithPane,
    isMobile,
  });

  // 分屏中把焦点 pane 的 TerminalRef 转接到控制台的 terminalRef（快捷键/editor 等共用）
  const bindFocusedTerminalRef = useCallback((ref: TerminalRef | null) => {
    terminalRef.current = ref;
  }, []);

  // Scroll to bottom on input mode change
  useEffect(() => {
    void inputMode;
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
  }, [inputMode]);

  // Device error toast
  useEffect(() => {
    if (!deviceError?.message) {
      return;
    }

    toast.error(deviceError.message);
  }, [deviceError?.message]);

  // Page title
  useEffect(() => {
    document.title = formatBrowserTitle
      ? formatBrowserTitle(terminalTopbarLabel ?? null)
      : buildBrowserTitle(terminalTopbarLabel);
    return () => {
      document.title = formatBrowserTitle ? formatBrowserTitle(null) : siteName;
    };
  }, [siteName, terminalTopbarLabel, formatBrowserTitle]);

  // Jump to latest event
  useEffect(() => {
    const handler = () => {
      terminalRef.current?.scrollToBottom();
    };

    window.addEventListener('tmex:jump-to-latest', handler as EventListener);
    return () => {
      window.removeEventListener('tmex:jump-to-latest', handler as EventListener);
    };
  }, []);

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

  const handleActivateShortcut = useCallback(
    (item: TerminalShortcutItem) => {
      // 纯前端 UI 动作：不依赖后端连接 / 有效 pane，先于 canInteractWithPane 守卫处理
      if (item.type === 'action') {
        if (item.action === 'toggleKeyboard') {
          runtime.stores.ui.getState().setInputMode(inputMode === 'direct' ? 'editor' : 'direct');
          return;
        }
        if (item.action === 'scrollToBottom') {
          terminalRef.current?.scrollToBottom();
          return;
        }
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
      switch (item.action) {
        case 'paste': {
          // 非安全上下文 / 宿主 clipboard 不可用时给出明确错误而非静默
          void runtime.host
            .readClipboardText()
            .then((text) => {
              if (text) {
                runtime.stores.tmux.getState().paste(deviceId, resolvedPaneId, text);
              }
            })
            .catch(() => toast.error(t('terminal.pasteFailed')));
          break;
        }
        case 'newAgentSession':
          // agent UI 关闭时按钮已在渲染前过滤，这里再兜底一次
          if (!runtime.features.agentUi) {
            break;
          }
          runtime.stores.agent.getState().startDraft(deviceId, resolvedPaneId, null);
          runtime.stores.ui.getState().setSidebarCollapsed(false);
          runtime.stores.ui.getState().expandSidebarSection('agent');
          break;
        default:
          break;
      }
    },
    [canInteractWithPane, deviceId, handleSendShortcut, inputMode, resolvedPaneId, runtime, t]
  );

  if (!deviceId) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          {t('device.noDevices')}
        </div>
      </div>
    );
  }

  // 重连期间保持 Terminal 挂载，避免 xterm 卸载导致已有内容消失（issue: 重连要看得清已有内容）。
  const showTerminal =
    Boolean(resolvedPaneId) && !isSelectionInvalid && (deviceConnected || isReconnecting);
  // 已连接、URL 指定了 pane，但 snapshot 尚未解析出它（且不是 not-found）→ 仍在加载，内容本就空白。
  const isResolvingSnapshot =
    deviceConnected && Boolean(resolvedPaneId) && !isSelectionInvalid && !selectedPane;

  const loadingPlaceholder = (
    <>
      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
        <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
      </div>
      <h3 className="text-lg font-medium">{t('common.loading')}</h3>
    </>
  );

  const shortcutsSlot = (
    <TerminalShortcutsSlot
      visible={inputMode === 'direct'}
      background={terminalTheme.background}
      onActivate={handleActivateShortcut}
      disabled={!canInteractWithPane}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="device-page">
      <div
        className={`flex-1 relative overflow-hidden min-h-0 min-w-0 ${
          isMobile && inputMode === 'editor' ? 'pb-1' : ''
        }`}
      >
        <div
          className="h-full px-3 py-1 min-h-0 min-w-0 w-full relative flex rounded-xl"
          style={{ backgroundColor: terminalTheme.background }}
        >
          {isSelectionInvalid ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
              <div className="max-w-sm space-y-4">
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                  <SearchX className="h-6 w-6 text-muted-foreground" />
                </div>
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="terminal-selection-invalid"
                >
                  {invalidSelectionMessage}
                </p>
              </div>
            </div>
          ) : showTerminal && resolvedPaneId ? (
            isSplitView && selectedWindow ? (
              <div
                className="flex h-full min-h-0 w-full flex-1 flex-col"
                data-virtual-keyboard-avoid
              >
                <div ref={terminalContainerRef} className="relative min-h-0 flex-1">
                  <SplitTerminalArea
                    key={`${deviceId}:${selectedWindow.id}`}
                    deviceId={deviceId}
                    window={selectedWindow}
                    focusedPaneId={resolvedPaneId}
                    theme={uiTheme}
                    inputMode={inputMode}
                    deviceConnected={deviceConnected}
                    focusedTerminalRef={bindFocusedTerminalRef}
                    onUserSelectPane={handleUserSelectPane}
                    onWindowResize={handleResize}
                    onWindowResizeSettled={handleResizeSettled}
                    prepareResources={prepareResources}
                  />
                </div>
                {shortcutsSlot}
              </div>
            ) : (
              <div
                ref={terminalContainerRef}
                className="flex-1 h-full min-h-0 w-full"
                data-virtual-keyboard-avoid
              >
                <TerminalComponent
                  key={`${deviceId}:${resolvedPaneId}`}
                  ref={terminalRef}
                  deviceId={deviceId}
                  paneId={resolvedPaneId}
                  theme={uiTheme}
                  inputMode={inputMode}
                  deviceConnected={deviceConnected}
                  isSelectionInvalid={isSelectionInvalid}
                  prepareResources={prepareResources}
                  onResize={handleResize}
                  onSync={handleSync}
                  onResizeSettled={handleResizeSettled}
                >
                  {shortcutsSlot}
                </TerminalComponent>
              </div>
            )
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
              <div className="max-w-sm space-y-4">
                {!deviceConnected || isReconnecting ? (
                  loadingPlaceholder
                ) : !windowId ? (
                  <>
                    <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                      <span className="text-2xl text-muted-foreground">📋</span>
                    </div>
                    <h3 className="text-lg font-medium">{t('window.noWindowSelected')}</h3>
                    <p className="text-sm text-muted-foreground">
                      {t('window.selectWindowToStart')}
                    </p>
                  </>
                ) : (
                  loadingPlaceholder
                )}
              </div>
            </div>
          )}
          {/* 重连指示：非遮挡、置顶居中，保持已有终端内容可见 */}
          {isReconnecting && (
            <div
              className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center"
              data-testid="terminal-reconnecting-indicator"
            >
              <DeviceStatusBadge deviceId={deviceId} className="shadow-sm" />
            </div>
          )}

          {/* loading：已连接但 snapshot 尚未解析出该 pane（内容本就空白，用遮罩 spinner） */}
          {isResolvingSnapshot && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-background/85 backdrop-blur-sm"
              data-testid="terminal-status-overlay"
            >
              <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card/90 px-4 py-3 shadow-sm">
                <div className="h-7 w-7 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                <span className="text-xs text-muted-foreground" data-testid="terminal-status-text">
                  {t('terminal.connecting')}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {inputMode === 'editor' && (
        <div
          ref={editorContainerRef}
          data-virtual-keyboard-avoid
          className="editor-mode-input bg-card/85 backdrop-blur-sm"
        >
          {/* 移动端 editor 模式：快捷键栏在编辑器上方 */}
          {isMobile && (
            <ShortcutsBar
              onActivate={(item) => {
                handleActivateShortcut(item);
                if (item.type === 'send') {
                  focusEditor();
                }
              }}
              disabled={!canInteractWithPane}
            />
          )}
          <textarea
            ref={editorTextareaRef}
            data-testid="editor-input"
            className="min-h-[88px] max-h-[28vh] w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-colors focus:border-ring"
            value={editorText}
            onChange={(e) => handleEditorChange(e.target.value)}
            placeholder={t('terminal.inputPlaceholder')}
          />
          <div className="actions mt-2">
            <div
              className="send-row flex flex-wrap items-center justify-end gap-2"
              data-testid="editor-send-row"
            >
              <div
                className="send-with-enter-toggle mr-auto flex items-center gap-2 text-xs text-muted-foreground"
                data-testid="editor-send-with-enter-toggle"
              >
                <Switch
                  size="sm"
                  checked={editorSendWithEnter}
                  onCheckedChange={(checked) => setEditorSendWithEnter(Boolean(checked))}
                />
                <span>{t('terminal.editorSendWithEnter')}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                data-testid="editor-clear"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleEditorClear}
                title={t('terminal.clear')}
              >
                <Trash2 className="h-4 w-4" />
                {t('terminal.clear')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                data-testid="editor-send-line-by-line"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleEditorSendLineByLine}
                disabled={!canInteractWithPane || isSending}
              >
                {isSending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {t('terminal.editorSendLineByLine')}
              </Button>
              <Button
                variant="default"
                size="sm"
                data-testid="editor-send"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleEditorSend}
                disabled={!canInteractWithPane || isSending}
              >
                {isSending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {t('common.send')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
