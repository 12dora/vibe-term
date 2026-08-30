// 终端显示区：按连接与 pane 选择状态在「主动断开 / 失效提示 / 分屏 / 单屏 / 占位」间切换，
// 并叠加重连指示与快照解析中的遮罩。DOM 结构被 e2e 依赖，改动需同步 apps/fe/tests。

import type { TerminalShortcutItem, TerminalThemeColors, TmuxPane, TmuxWindow } from '@tmex/shared';
import {
  SplitTerminalArea,
  Terminal as TerminalComponent,
  type TerminalRef,
} from '@tmex/terminal-ui';
import { Loader2, SearchX } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { DeviceStatusBadge } from '../device-status-badge';
import { TerminalShortcutsSlot } from './terminal-shortcuts-slot';
import type { DevicePaneSelection } from './use-device-pane-selection';

function CenteredNotice({ children }: { children: ReactNode }) {
  return (
    <div className="tmex-fade absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
      <div className="max-w-sm space-y-4">{children}</div>
    </div>
  );
}

function LoadingPlaceholder() {
  const { t } = useTranslation();
  return (
    <>
      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
        <Loader2 className="h-6 w-6 text-muted-foreground animate-spin motion-reduce:animate-none" />
      </div>
      <h3 className="text-lg font-medium">{t('terminal.connecting')}</h3>
    </>
  );
}

function DisconnectedPlaceholder() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4" data-testid="device-disconnected-placeholder">
      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
        <span className="text-2xl text-muted-foreground">🔌</span>
      </div>
      <h3 className="text-lg font-medium">{t('device.disconnected')}</h3>
      <p className="text-sm text-muted-foreground">{t('device.connectToStart')}</p>
    </div>
  );
}

function IdlePlaceholder({ needsWindow }: { needsWindow: boolean }) {
  const { t } = useTranslation();
  if (!needsWindow) {
    return <LoadingPlaceholder />;
  }
  return (
    <>
      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
        <span className="text-2xl text-muted-foreground">📋</span>
      </div>
      <h3 className="text-lg font-medium">{t('window.noWindowSelected')}</h3>
      <p className="text-sm text-muted-foreground">{t('window.selectWindowToStart')}</p>
    </>
  );
}

function InvalidSelectionNotice({ isWindowMissing, isPaneMissing }: DevicePaneSelection) {
  const { t } = useTranslation();
  const message = isWindowMissing
    ? t('terminal.windowClosed')
    : isPaneMissing
      ? t('terminal.paneClosed')
      : null;
  return (
    <CenteredNotice>
      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
        <SearchX className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground" data-testid="terminal-selection-invalid">
        {message}
      </p>
    </CenteredNotice>
  );
}

/** 已连接但快照尚未解析出该 pane：内容本就空白，用遮罩 spinner 表达 loading。 */
function ResolvingOverlay() {
  const { t } = useTranslation();
  return (
    <div
      className="tmex-fade absolute inset-0 flex items-center justify-center bg-background/85 backdrop-blur-sm"
      data-testid="terminal-status-overlay"
    >
      <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card/90 px-4 py-3 shadow-sm">
        <div className="h-7 w-7 rounded-full border-2 border-primary border-t-transparent animate-spin motion-reduce:animate-none" />
        <span className="text-xs text-muted-foreground" data-testid="terminal-status-text">
          {t('terminal.connecting')}
        </span>
      </div>
    </div>
  );
}

export interface TerminalStageProps {
  deviceId: string;
  windowId?: string;
  /** 已归一的 pane id（非路由段原值） */
  resolvedPaneId?: string;
  selectedWindow?: TmuxWindow;
  selectedPane?: TmuxPane;
  selection: DevicePaneSelection;
  deviceConnected: boolean;
  isReconnecting: boolean;
  /** 用户主动断开（宿主未提供 connection 时恒为 false） */
  isIntentionallyDisconnected: boolean;
  isMobile: boolean;
  inputMode: 'direct' | 'editor';
  /** 已解析的终端色板（站点外观 + 主题预设） */
  terminalTheme: TerminalThemeColors;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<TerminalRef | null>;
  bindFocusedTerminalRef: (ref: TerminalRef | null) => void;
  prepareResources: () => Promise<void>;
  onActivateShortcut: (item: TerminalShortcutItem) => void;
}

function StageContent(props: TerminalStageProps) {
  const {
    deviceId,
    windowId,
    resolvedPaneId,
    selectedWindow,
    selection,
    deviceConnected,
    isReconnecting,
    isIntentionallyDisconnected,
    inputMode,
    terminalTheme,
    terminalContainerRef,
    terminalRef,
    bindFocusedTerminalRef,
    prepareResources,
    onActivateShortcut,
  } = props;
  const { isSelectionInvalid, isPaneConfirmedClosed, isSplitView, canInteractWithPane } = selection;

  const shortcutsSlot = (
    <TerminalShortcutsSlot
      visible={inputMode === 'direct'}
      background={terminalTheme.background}
      onActivate={onActivateShortcut}
      disabled={!canInteractWithPane}
    />
  );

  if (isIntentionallyDisconnected && !deviceConnected && !isReconnecting) {
    return (
      <CenteredNotice>
        <DisconnectedPlaceholder />
      </CenteredNotice>
    );
  }

  if (isSelectionInvalid) {
    return <InvalidSelectionNotice {...selection} />;
  }

  // 重连期间保持 Terminal 挂载，避免 xterm 卸载导致已有内容消失（issue: 重连要看得清已有内容）。
  const showTerminal = Boolean(resolvedPaneId) && (deviceConnected || isReconnecting);
  if (!showTerminal || !resolvedPaneId) {
    return (
      <CenteredNotice>
        <IdlePlaceholder needsWindow={deviceConnected && !isReconnecting && !windowId} />
      </CenteredNotice>
    );
  }

  if (isSplitView && selectedWindow) {
    return (
      <div className="flex h-full min-h-0 w-full flex-1 flex-col" data-virtual-keyboard-avoid>
        <div ref={terminalContainerRef} className="relative min-h-0 flex-1">
          <SplitTerminalArea
            key={`${deviceId}:${selectedWindow.id}`}
            deviceId={deviceId}
            window={selectedWindow}
            focusedPaneId={resolvedPaneId}
            theme={terminalTheme}
            inputMode={inputMode}
            deviceConnected={deviceConnected}
            focusedTerminalRef={bindFocusedTerminalRef}
            onUserSelectPane={selection.handleUserSelectPane}
            onClosePane={selection.handleClosePane}
            onWindowResize={selection.handleResize}
            onWindowResizeSettled={selection.handleResizeSettled}
            prepareResources={prepareResources}
          />
        </div>
        {shortcutsSlot}
      </div>
    );
  }

  // 快照已确认这个 pane 被关闭：不挂 Terminal（挂上只会对死 pane 订阅/select），
  // 也不显示「连接中」——路由对账会立刻回落到幸存 pane
  if (isPaneConfirmedClosed) {
    return null;
  }

  return (
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
        theme={terminalTheme}
        inputMode={inputMode}
        deviceConnected={deviceConnected}
        isSelectionInvalid={isSelectionInvalid}
        prepareResources={prepareResources}
        onResize={selection.handleResize}
        onSync={selection.handleSync}
        onResizeSettled={selection.handleResizeSettled}
      >
        {shortcutsSlot}
      </TerminalComponent>
    </div>
  );
}

export function TerminalStage(props: TerminalStageProps) {
  const { deviceId, isReconnecting, isMobile, inputMode } = props;
  // 已连接、URL 指定了 pane，但 snapshot 尚未解析出它（且不是 not-found）→ 仍在加载，内容本就空白。
  const isResolvingSnapshot =
    props.deviceConnected &&
    Boolean(props.resolvedPaneId) &&
    !props.selection.isSelectionInvalid &&
    !props.selection.isPaneConfirmedClosed &&
    !props.selectedPane;

  return (
    <div
      className={`flex-1 relative overflow-hidden min-h-0 min-w-0 ${
        isMobile && inputMode === 'editor' ? 'pb-1' : ''
      }`}
    >
      <div
        className="h-full px-3 py-1 min-h-0 min-w-0 w-full relative flex rounded-xl"
        style={{ backgroundColor: props.terminalTheme.background }}
      >
        <StageContent {...props} />
        {/* 重连指示：非遮挡、置顶居中，保持已有终端内容可见 */}
        {isReconnecting && (
          <div
            className="tmex-fade pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center"
            data-testid="terminal-reconnecting-indicator"
          >
            <DeviceStatusBadge deviceId={deviceId} className="shadow-sm" />
          </div>
        )}

        {isResolvingSnapshot && <ResolvingOverlay />}
      </div>
    </div>
  );
}
