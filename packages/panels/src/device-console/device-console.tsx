// 设备终端控制台的组合根：把选择域 / 输入域 / 副作用域接起来，渲染交给
// ./terminal-stage 与 ./editor-input-panel。
// pane 选择与 URL 同步见 ./use-device-pane-selection，editor 输入见 ./use-editor-input。
// 路由参数由宿主显式传入（paneId 为路由段原值，React Router 已 decode 一次，
// 包内经 decodePaneIdFromUrlParam 归一，宿主不要再 decode）；包内构造的应用内
// 路径一律经 hostAppPath 映射宿主路由形状。

import { devicesQueryKey as defaultDevicesQueryKey } from '@tmex/api-client';
import { decodePaneIdFromUrlParam } from '@tmex/stores';
import { useUIStore } from '@tmex/stores/react';
import type { TerminalRef } from '@tmex/terminal-ui';
import { resolveTerminalTheme } from '@tmex/theme';
import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type DeviceConnectionAdapter,
  useDeviceIntentionallyDisconnected,
} from '../device-connection';
import { CommandInputCollapse } from './command-input-collapse';
import { EditorInputPanel } from './editor-input-panel';
import { TerminalStage } from './terminal-stage';
import { useConsoleTargets } from './use-console-targets';
import { useDeviceConsoleEffects } from './use-device-console-effects';
import { useDevicePaneSelection } from './use-device-pane-selection';
import { useEditorInput } from './use-editor-input';
import { useMobileViewport } from './use-mobile-viewport';
import { useTerminalShortcutActions } from './use-terminal-shortcut-actions';

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
  /** 未提供时 prepareResources 返回 undefined，Terminal 启动路径据此免掉一次 await */
  prepareTerminalResources?: (fontId: string, fontSize: number) => Promise<void>;
  /** 宿主连接管理；未传时不显示主动断开占位 */
  connection?: DeviceConnectionAdapter;
}

function NoDeviceNotice() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="tmex-fade rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
        {t('device.noDevices')}
      </div>
    </div>
  );
}

export function DeviceConsole({
  deviceId,
  windowId,
  paneId,
  devicesQueryKey = defaultDevicesQueryKey,
  formatBrowserTitle,
  prepareTerminalResources,
  connection,
}: DeviceConsoleProps) {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<TerminalRef>(null);

  const resolvedPaneId = useMemo(() => decodePaneIdFromUrlParam(paneId), [paneId]);
  const draftKey = useMemo(
    () => (deviceId && resolvedPaneId ? `${deviceId}:${resolvedPaneId}` : null),
    [deviceId, resolvedPaneId]
  );

  const isMobile = useMobileViewport();
  const inputMode = useUIStore((state) => state.inputMode);
  const setInputMode = useUIStore((state) => state.setInputMode);
  const uiTheme = useUIStore((state) => state.theme);
  const themePreset = useUIStore((state) => state.themePreset);
  const terminalFontId = useUIStore((state) => state.terminalFontId);
  const terminalFontSize = useUIStore((state) => state.terminalFontSize);
  // 预设决定整套终端色板；无预设时回落到站点外观对应的 seoul256。
  // 引用要稳定：Terminal 内部按引用判定是否重新 setTheme。
  const terminalTheme = useMemo(
    () => resolveTerminalTheme(uiTheme, themePreset),
    [uiTheme, themePreset]
  );

  const targets = useConsoleTargets({ deviceId, windowId, resolvedPaneId, devicesQueryKey });
  const { windows, selectedWindow, selectedPane, deviceConnected, isReconnecting } = targets;

  const isIntentionallyDisconnected = useDeviceIntentionallyDisconnected(
    connection,
    deviceId ?? ''
  );

  const prepareResources = useCallback(
    () => prepareTerminalResources?.(terminalFontId, terminalFontSize),
    [prepareTerminalResources, terminalFontId, terminalFontSize]
  );

  const selection = useDevicePaneSelection({
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

  const editor = useEditorInput({
    deviceId,
    paneId: resolvedPaneId,
    draftKey,
    canInteractWithPane: selection.canInteractWithPane,
    isMobile,
  });

  const onActivateShortcut = useTerminalShortcutActions({
    deviceId,
    resolvedPaneId,
    canInteractWithPane: selection.canInteractWithPane,
    inputMode,
    terminalRef,
  });

  useDeviceConsoleEffects({
    deviceId,
    deviceName: targets.currentDevice?.name,
    deviceErrorMessage: targets.deviceErrorMessage,
    selectedWindow,
    selectedPane,
    inputMode,
    terminalRef,
    formatBrowserTitle,
  });

  // 分屏中把焦点 pane 的 TerminalRef 转接到控制台的 terminalRef（快捷键/editor 等共用）
  const bindFocusedTerminalRef = useCallback((ref: TerminalRef | null) => {
    terminalRef.current = ref;
  }, []);

  if (!deviceId) {
    return <NoDeviceNotice />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="device-page">
      <TerminalStage
        deviceId={deviceId}
        windowId={windowId}
        resolvedPaneId={resolvedPaneId}
        selectedWindow={selectedWindow}
        selectedPane={selectedPane}
        selection={selection}
        deviceConnected={deviceConnected}
        isReconnecting={isReconnecting}
        isIntentionallyDisconnected={isIntentionallyDisconnected}
        isMobile={isMobile}
        inputMode={inputMode}
        terminalTheme={terminalTheme}
        terminalContainerRef={terminalContainerRef}
        terminalRef={terminalRef}
        bindFocusedTerminalRef={bindFocusedTerminalRef}
        prepareResources={prepareResources}
        onActivateShortcut={onActivateShortcut}
      />

      <CommandInputCollapse open={inputMode === 'editor'}>
        <EditorInputPanel
          editor={editor}
          isMobile={isMobile}
          canInteractWithPane={selection.canInteractWithPane}
          onActivateShortcut={onActivateShortcut}
          onClose={() => setInputMode('direct')}
        />
      </CommandInputCollapse>
    </div>
  );
}
