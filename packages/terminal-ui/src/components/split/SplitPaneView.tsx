// 单个 pane 的渲染单元：浮起式标题栏（名称 + 进程@路径 + 关闭）+ 终端实例 + 落点预览。

import { useBellStore } from '@tmex/notifications';
import type { TmuxPane } from '@tmex/shared';
import { usePaneAgentState } from '@tmex/stores/react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from '../Terminal';
import type { DropPosition, SplitPaneRect } from '../splitLayoutGeometry';
import type { TerminalRef, TerminalTheme } from '../types';
import { PANE_HEADER_PX, cellsToPercent } from './constants';
import { paneDisplayName, paneMetaText } from './paneLabels';

const DROP_PREVIEW_CLASS: Record<DropPosition, string> = {
  left: 'left-0 top-0 bottom-0 w-1/2',
  right: 'right-0 top-0 bottom-0 w-1/2',
  top: 'left-0 right-0 top-0 h-1/2',
  bottom: 'left-0 right-0 bottom-0 h-1/2',
};

function PaneBellIcon({ paneId }: { paneId: string }) {
  const ringing = useBellStore((state) => Boolean(state.ringingPanes[paneId]));
  if (!ringing) return null;
  return <span className="bell-blink shrink-0">🔔 </span>;
}

function PaneAgentBadge({ deviceId, paneId }: { deviceId: string; paneId: string }) {
  const { t } = useTranslation();
  const state = usePaneAgentState(deviceId, paneId);
  if (state === 'none') return null;
  if (state === 'generating') {
    return (
      <span
        className="shrink-0 select-none text-xs"
        title={t('agent.paneBadge.generating')}
        aria-label={t('agent.paneBadge.generating')}
      >
        🤖<span className="ml-0.5 text-[10px] motion-safe:animate-pulse">✨</span>
      </span>
    );
  }
  return (
    <span
      className="text-muted-foreground/60 shrink-0 select-none text-xs grayscale"
      title={t('agent.paneBadge.bound')}
      aria-label={t('agent.paneBadge.bound')}
    >
      🤖
    </span>
  );
}

export interface SplitPaneViewProps {
  deviceId: string;
  windowId: string;
  pane: SplitPaneRect;
  paneInfo: TmuxPane | undefined;
  rootCols: number;
  rootRows: number;
  isFocused: boolean;
  isDragSource: boolean;
  dropPreview: DropPosition | null;
  theme: TerminalTheme;
  inputMode: 'direct' | 'editor';
  deviceConnected: boolean;
  prepareResources?: () => Promise<void>;
  registerTerminal: (paneId: string, ref: TerminalRef | null) => void;
  onUserSelectPane: (windowId: string, paneId: string) => void;
  /** 关闭 pane 交给宿主：关掉 URL 点名的 pane 需要先回落路由再发命令 */
  onClosePane: (windowId: string, paneId: string) => void;
  onTitleBarPointerDown: (paneId: string, event: React.PointerEvent<HTMLDivElement>) => void;
}

export function SplitPaneView({
  deviceId,
  windowId,
  pane,
  paneInfo,
  rootCols,
  rootRows,
  isFocused,
  isDragSource,
  dropPreview,
  theme,
  inputMode,
  deviceConnected,
  prepareResources,
  registerTerminal,
  onUserSelectPane,
  onClosePane,
  onTitleBarPointerDown,
}: SplitPaneViewProps) {
  const { t } = useTranslation();
  const paneId = pane.paneId;
  const meta = paneMetaText(paneInfo);

  const bindTerminalRef = useCallback(
    (ref: TerminalRef | null) => registerTerminal(paneId, ref),
    [registerTerminal, paneId]
  );

  return (
    <div
      className={`absolute flex flex-col overflow-hidden ${isDragSource ? 'opacity-60' : ''}`}
      data-testid="split-pane"
      data-pane-id={paneId}
      data-focused={isFocused || undefined}
      style={{
        left: cellsToPercent(pane.rect.left, rootCols),
        top: cellsToPercent(pane.rect.top, rootRows),
        width: cellsToPercent(pane.rect.width, rootCols),
        height: cellsToPercent(pane.rect.height, rootRows),
      }}
      onPointerDownCapture={() => {
        if (!isFocused) {
          onUserSelectPane(windowId, paneId);
        }
      }}
    >
      {/* 浮起式标题栏：四角圆角、无边框无阴影的独立矩形，下方留 8px 视觉空间；
          active 以背景透明度区分 */}
      <div className="shrink-0 px-1.5 pt-1.5 pb-2" style={{ height: PANE_HEADER_PX }}>
        <div
          data-testid="split-pane-titlebar"
          data-active={isFocused || undefined}
          className={`group/pane-titlebar flex h-6 cursor-grab touch-none select-none items-center gap-1.5 rounded-md px-2.5 transition-colors duration-(--tmex-motion-standard) ease-out active:cursor-grabbing motion-reduce:transition-none ${
            isFocused ? 'bg-foreground/10' : 'bg-foreground/[0.04]'
          }`}
          onPointerDown={(event) => onTitleBarPointerDown(paneId, event)}
        >
          <PaneBellIcon paneId={paneId} />
          <PaneAgentBadge deviceId={deviceId} paneId={paneId} />
          <span
            className={`shrink-0 truncate font-mono text-[10.5px] leading-none transition-colors duration-(--tmex-motion-standard) ease-out motion-reduce:transition-none ${
              isFocused ? 'text-foreground/90' : 'text-foreground/50'
            }`}
          >
            {paneDisplayName(paneInfo)}
          </span>
          {meta && (
            <span
              className={`min-w-0 flex-1 truncate font-mono text-[10px] leading-none transition-colors duration-(--tmex-motion-standard) ease-out motion-reduce:transition-none ${
                isFocused ? 'text-muted-foreground' : 'text-muted-foreground/60'
              }`}
            >
              {meta}
            </span>
          )}
          <button
            type="button"
            data-testid={`split-pane-close-${paneId}`}
            aria-label={t('window.closePane')}
            title={t('window.closePane')}
            className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-70 transition-[opacity,color,background-color] duration-(--tmex-motion-fast) ease-out hover:bg-foreground/10 hover:text-foreground hover:opacity-100 group-hover/pane-titlebar:opacity-100 motion-reduce:transition-none"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onClosePane(windowId, paneId);
            }}
          >
            <span className="text-xs leading-none">×</span>
          </button>
        </div>
      </div>
      <div
        className="relative min-h-0 flex-1 overflow-hidden px-1.5 pb-2"
        data-pane-content-id={paneId}
      >
        <Terminal
          key={`${deviceId}:${paneId}`}
          ref={bindTerminalRef}
          deviceId={deviceId}
          paneId={paneId}
          theme={theme}
          inputMode={inputMode}
          deviceConnected={deviceConnected}
          isSelectionInvalid={false}
          sizingMode="follow"
          autoFocus={isFocused}
          focused={isFocused}
          prepareResources={prepareResources}
          onResize={() => {}}
          onSync={() => {}}
        />
      </div>
      {/* 拖拽重排的落点预览：目标 pane 的半区高亮 */}
      {dropPreview && (
        <div
          data-testid="split-pane-drop-preview"
          data-position={dropPreview}
          className={`pointer-events-none absolute z-30 rounded-sm bg-primary/20 ring-1 ring-inset ring-primary/60 ${DROP_PREVIEW_CLASS[dropPreview]}`}
        />
      )}
    </div>
  );
}
