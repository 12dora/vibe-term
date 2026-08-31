// 终端显示区：按连接与 pane 选择状态在「主动断开 / 失效提示 / 分屏 / 单屏 / 占位」间切换，
// 并叠加重连指示与快照解析中的遮罩。DOM 结构被 e2e 依赖，改动需同步 apps/fe/tests。
//
// 单屏分支不是「一个 pane 一个 Terminal」，而是保活池（见 ./terminal-keep-alive）：
// 最近看过的 N 个 pane 同时挂载在同一个盒子里，只有路由点名的那个可见，
// 其余 visibility:hidden 继续吃 live 输出，切回时即时呈现。

import type { TerminalShortcutItem, TerminalThemeColors, TmuxPane, TmuxWindow } from '@tmex/shared';
import { useTmuxStore } from '@tmex/stores/react';
import {
  SplitTerminalArea,
  Terminal as TerminalComponent,
  type TerminalRef,
} from '@tmex/terminal-ui';
import { Loader2, SearchX } from 'lucide-react';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { useTranslation } from 'react-i18next';
import { DeviceStatusBadge } from '../device-status-badge';
import {
  type KeepAlivePool,
  applyKeepAliveStreamState,
  createKeepAlivePool,
  keepAlivePaneIds,
  keepAlivePaneKey,
  publishKeepAlivePool,
  retainKeepAlivePane,
  retainLiveKeepAlivePanes,
  unpublishKeepAlivePool,
} from './terminal-keep-alive';
import { TerminalShortcutsSlot } from './terminal-shortcuts-slot';
import type { DevicePaneSelection } from './use-device-pane-selection';

const noopResize = (): void => {};

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

/**
 * 可见实例的 TerminalRef 转接到控制台共用的 terminalRef。
 * 每个 pane 的回调引用恒定，避免 React 每次渲染 detach/attach。
 */
function usePaneTerminalBinder(
  terminalRef: RefObject<TerminalRef | null>,
  visiblePaneId: string,
  paneIds: readonly string[]
): (paneId: string) => (ref: TerminalRef | null) => void {
  const instances = useRef(new Map<string, TerminalRef | null>());
  const binders = useRef(new Map<string, (ref: TerminalRef | null) => void>());
  const visibleRef = useRef(visiblePaneId);
  visibleRef.current = visiblePaneId;

  const paneIdsKey = paneIds.join(',');
  useEffect(() => {
    const live = new Set(paneIdsKey ? paneIdsKey.split(',') : []);
    for (const paneId of binders.current.keys()) {
      if (!live.has(paneId)) {
        binders.current.delete(paneId);
        instances.current.delete(paneId);
      }
    }
  }, [paneIdsKey]);

  useEffect(() => {
    terminalRef.current = instances.current.get(visiblePaneId) ?? null;
  }, [visiblePaneId, terminalRef]);

  return useCallback(
    (paneId: string) => {
      const existing = binders.current.get(paneId);
      if (existing) return existing;
      const binder = (ref: TerminalRef | null): void => {
        if (ref) instances.current.set(paneId, ref);
        else instances.current.delete(paneId);
        if (visibleRef.current === paneId) terminalRef.current = ref;
      };
      binders.current.set(paneId, binder);
      return binder;
    },
    [terminalRef]
  );
}

/**
 * 池归本组件实例所有，只在提交阶段把快照发布出去：
 * useLayoutEffect 早于父组件的 select 派发（passive effect），同一次提交里读到的
 * 就是这一帧的 warm 判定；cleanup 按 owner 撤销，StrictMode 的
 * 「setup → cleanup → setup」结束时仍然是发布态。
 */
function useOwnedKeepAlivePool(
  deviceId: string,
  paneId: string,
  streamInterrupted: boolean,
  livePaneIds: ReadonlySet<string> | null
): KeepAlivePool {
  const ownerRef = useRef<symbol | null>(null);
  if (ownerRef.current === null) ownerRef.current = Symbol('keep-alive-pool');
  const owner = ownerRef.current;

  const poolRef = useRef<KeepAlivePool>(createKeepAlivePool());
  poolRef.current = applyKeepAliveStreamState(poolRef.current, streamInterrupted);
  if (livePaneIds) {
    poolRef.current = retainLiveKeepAlivePanes(poolRef.current, livePaneIds);
  }
  poolRef.current = retainKeepAlivePane(poolRef.current, deviceId, paneId);

  useLayoutEffect(() => {
    publishKeepAlivePool(owner, poolRef.current);
    return () => unpublishKeepAlivePool(owner);
  });

  return poolRef.current;
}

/** 快照里该设备当前存在的 pane：保活池据此卸载已被删除的隐藏实例 */
function useDeviceLivePaneIds(deviceId: string): ReadonlySet<string> | null {
  const snapshot = useTmuxStore((state) => state.snapshots[deviceId]);
  return useMemo(() => {
    if (!snapshot?.session) return null;
    const ids = new Set<string>();
    for (const window of snapshot.session.windows) {
      for (const pane of window.panes) ids.add(pane.id);
    }
    return ids;
  }, [snapshot]);
}

/** 保活槽：全部实例共用同一个盒子，隐藏的那些留布局但不可见、不吃事件、不参与无障碍树 */
export function KeepAlivePaneSlot({
  paneId,
  visible,
  children,
}: {
  paneId: string;
  visible: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="absolute inset-0 flex"
      data-testid="terminal-keep-alive-pane"
      data-pane-id={paneId}
      data-visible={visible || undefined}
      aria-hidden={visible ? undefined : true}
      style={visible ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
    >
      {children}
    </div>
  );
}

interface KeepAliveStackProps extends TerminalStageProps {
  resolvedPaneId: string;
  shortcutsSlot: ReactNode;
}

function KeepAliveTerminalStack(props: KeepAliveStackProps) {
  const {
    deviceId,
    resolvedPaneId,
    selection,
    deviceConnected,
    isReconnecting,
    inputMode,
    terminalTheme,
    terminalContainerRef,
    terminalRef,
    prepareResources,
    shortcutsSlot,
  } = props;

  // 断线/重连中：隐藏实例的 live 流已经断了，只留可见实例，并取消它的 warm 资格。
  // 自动重连只置 deviceReconnecting、deviceConnected 仍为 true，所以两个都要看。
  const livePaneIds = useDeviceLivePaneIds(deviceId);
  const pool = useOwnedKeepAlivePool(
    deviceId,
    resolvedPaneId,
    !deviceConnected || isReconnecting,
    livePaneIds
  );
  const paneIds = keepAlivePaneIds(pool);

  const bindTerminal = usePaneTerminalBinder(terminalRef, resolvedPaneId, paneIds);

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col" data-virtual-keyboard-avoid>
      <div ref={terminalContainerRef} className="relative min-h-0 flex-1">
        {paneIds.map((paneId) => {
          const visible = paneId === resolvedPaneId;
          return (
            <KeepAlivePaneSlot
              key={keepAlivePaneKey(pool, paneId)}
              paneId={paneId}
              visible={visible}
            >
              <TerminalComponent
                ref={bindTerminal(paneId)}
                deviceId={deviceId}
                paneId={paneId}
                theme={terminalTheme}
                inputMode={inputMode}
                deviceConnected={deviceConnected}
                isSelectionInvalid={visible ? selection.isSelectionInvalid : false}
                // 隐藏实例只跟随容器尺寸对齐本地行列，不上报——否则多实例互抢整窗尺寸
                sizingMode={visible ? 'report' : 'local'}
                autoFocus={visible}
                focused={visible}
                prepareResources={prepareResources}
                onResize={visible ? selection.handleResize : noopResize}
                onSync={visible ? selection.handleSync : noopResize}
                onResizeSettled={visible ? selection.handleResizeSettled : undefined}
              />
            </KeepAlivePaneSlot>
          );
        })}
      </div>
      {shortcutsSlot}
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
  prepareResources: () => Promise<void> | void;
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
    <KeepAliveTerminalStack
      {...props}
      resolvedPaneId={resolvedPaneId}
      shortcutsSlot={shortcutsSlot}
    />
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
