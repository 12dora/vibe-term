// PC 分屏渲染区域：按 tmux window layout 同屏渲染 window 内全部 pane。
//
// - 布局真相源是 tmux layout：pane 容器按 layout 树的 cells 比例绝对定位，
//   每个 pane 挂一个 sizingMode="follow" 的 Terminal 实例并 resize 到精确 cols/rows；
// - 每个 pane 顶部有标题栏（名称 + 进程@路径），拖动标题栏到目标 pane 的
//   上/下/左/右四分区可重排布局（tmux move-pane），拖拽中显示半区预览；
// - 相邻 pane 间的 1 cell 间隙渲染 splitter，拖拽中只画参考线，
//   pointerup 一次性提交 resize-pane 绝对值，等 layout 经快照回流刷新（无回弹）；
// - 整个区域的容器尺寸经防抖上报为 window 尺寸（resize-window 语义），
//   高度按最深垂直堆叠扣除标题栏总高；
// - 焦点 pane 由 URL 决定，点击非焦点 pane 触发 onUserSelectPane（轻量 focus 路径）。
//
// 本文件是组合根：几何、尺寸上报、拖拽交互、单 pane 渲染分别在 ./split/ 下。

import type { TmuxWindow } from '@tmex/shared';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SplitPaneView } from './split/SplitPaneView';
import { cellsToPercent } from './split/constants';
import { paneDisplayName } from './split/paneLabels';
import { useSplitDragInteractions } from './split/useSplitDragInteractions';
import { useSplitGeometry } from './split/useSplitGeometry';
import { useSplitPaneTerminals } from './split/useSplitPaneTerminals';
import { useWindowResizeReporter } from './split/useWindowResizeReporter';
import type { TerminalRef, TerminalTheme } from './types';

export interface SplitTerminalAreaProps {
  deviceId: string;
  window: TmuxWindow;
  focusedPaneId: string;
  theme: TerminalTheme;
  inputMode: 'direct' | 'editor';
  deviceConnected: boolean;
  /** 焦点 pane 的 TerminalRef 会转发到这里（DevicePage 的 terminalRef） */
  focusedTerminalRef: (ref: TerminalRef | null) => void;
  onUserSelectPane: (windowId: string, paneId: string) => void;
  /** 关闭 pane：由宿主决定关闭前是否需要先回落路由 */
  onClosePane: (windowId: string, paneId: string) => void;
  /** window 级尺寸上报（resize-window 语义），复用单 pane 的 canonical ResizePaneV11 通道 */
  onWindowResize: (cols: number, rows: number) => void;
  onWindowResizeSettled?: (cols: number, rows: number) => void;
  prepareResources?: () => Promise<void> | void;
  /**
   * 结构性操作（关闭 pane、标题栏拖动重排）是否开放；缺省开放。
   * 被分享人只能输入 / 滚动 / 参与尺寸仲裁，splitter 拖拽（resize-pane）不受此开关影响。
   */
  structureActions?: boolean;
}

type PaneDragState = NonNullable<ReturnType<typeof useSplitDragInteractions>['paneDrag']>;

/** 拖拽中跟随指针的浮动标签：pane 名 + 落点动作。 */
function PaneDragLabel({ drag, name }: { drag: PaneDragState; name: string }) {
  const { t } = useTranslation();
  const action =
    drag.target?.type === 'window'
      ? t('window.moveToWindow')
      : drag.target?.type === 'break'
        ? t('window.breakToWindow')
        : null;
  return (
    <div
      className="pointer-events-none fixed z-50 rounded border border-primary/40 bg-popover/95 px-2 py-1 font-mono text-[10.5px] text-popover-foreground shadow-md"
      style={{ left: drag.pointerX + 12, top: drag.pointerY + 12 }}
    >
      <div>{name}</div>
      {action && <div className="text-[9.5px] text-muted-foreground">{action}</div>}
    </div>
  );
}

export function SplitTerminalArea({
  deviceId,
  window: tmuxWindow,
  focusedPaneId,
  theme,
  inputMode,
  deviceConnected,
  focusedTerminalRef,
  onUserSelectPane,
  onClosePane,
  onWindowResize,
  onWindowResizeSettled,
  prepareResources,
  structureActions = true,
}: SplitTerminalAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    layoutRoot,
    geometry,
    geometryRef,
    rootCols,
    rootRows,
    paneInfoById,
    paneSizes,
    titleBarStackDepth,
    horizontalStackDepth,
    knownPaneIdsKey,
  } = useSplitGeometry(tmuxWindow);

  const { registerTerminal, getFocusedCellSize } = useSplitPaneTerminals({
    deviceId,
    windowId: tmuxWindow.id,
    focusedPaneId,
    inputMode,
    knownPaneIdsKey,
    paneSizes,
    geometryRef,
    focusedTerminalRef,
  });

  const { reportNow } = useWindowResizeReporter({
    containerRef,
    layoutRoot,
    getCellSize: getFocusedCellSize,
    onWindowResize,
    onWindowResizeSettled,
    titleBarStackDepth,
    horizontalStackDepth,
  });

  const { dragState, paneDrag, handleGutterPointerDown, handleTitleBarPointerDown } =
    useSplitDragInteractions({
      containerRef,
      deviceId,
      windowId: tmuxWindow.id,
      geometry,
      rootCols,
      rootRows,
      getCellSize: getFocusedCellSize,
      reportWindowSize: reportNow,
    });

  if (!geometry) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full min-h-0 min-w-0"
      data-testid="split-terminal-area"
    >
      {geometry.panes.map((pane) => (
        <SplitPaneView
          key={pane.paneId}
          deviceId={deviceId}
          windowId={tmuxWindow.id}
          pane={pane}
          paneInfo={paneInfoById.get(pane.paneId)}
          rootCols={rootCols}
          rootRows={rootRows}
          isFocused={pane.paneId === focusedPaneId}
          isDragSource={Boolean(paneDrag?.active && paneDrag.srcPaneId === pane.paneId)}
          dropPreview={
            paneDrag?.active &&
            paneDrag.target?.type === 'pane' &&
            paneDrag.target.paneId === pane.paneId
              ? paneDrag.target.position
              : null
          }
          theme={theme}
          inputMode={inputMode}
          deviceConnected={deviceConnected}
          prepareResources={prepareResources}
          registerTerminal={registerTerminal}
          onUserSelectPane={onUserSelectPane}
          onClosePane={onClosePane}
          onTitleBarPointerDown={handleTitleBarPointerDown}
          structureActions={structureActions}
        />
      ))}

      {/* 拖拽（splitter / 标题栏）期间的事件隔离层：吞掉滑过终端的鼠标事件，
          避免触发 canvas 的文本选择等另一套事件体系（拖拽本身经 pointer capture 不受遮挡影响） */}
      {(dragState !== null || paneDrag?.active) && (
        <div
          data-testid="split-drag-shield"
          className={`absolute inset-0 z-30 ${
            dragState !== null
              ? geometry.gutters[dragState.gutterIndex]?.axis === 'x'
                ? 'cursor-col-resize'
                : 'cursor-row-resize'
              : 'cursor-grabbing'
          }`}
        />
      )}

      {/* 侧栏落点高亮：移入其他窗口 / 拆为独立窗口 */}
      {paneDrag?.active && paneDrag.target && paneDrag.target.type !== 'pane' && (
        <div
          data-testid="split-pane-sidebar-drop"
          data-drop-type={paneDrag.target.type}
          className="pointer-events-none fixed z-40 rounded-lg bg-primary/15 ring-1 ring-inset ring-primary/50"
          style={{
            left: paneDrag.target.rect.left,
            top: paneDrag.target.rect.top,
            width: paneDrag.target.rect.width,
            height: paneDrag.target.rect.height,
          }}
        />
      )}

      {/* 拖拽中的浮动标签：跟随指针提示正在移动的 pane 与动作 */}
      {paneDrag?.active && (
        <PaneDragLabel
          drag={paneDrag}
          name={paneDisplayName(paneInfoById.get(paneDrag.srcPaneId))}
        />
      )}

      {geometry.gutters.map((gutter, index) => {
        const isVertical = gutter.axis === 'x';
        const isDragging = dragState?.gutterIndex === index;
        return (
          <div
            key={`${tmuxWindow.layout ?? ''}:${index}`}
            className="absolute z-20"
            style={{
              left: cellsToPercent(gutter.rect.left, rootCols),
              top: cellsToPercent(gutter.rect.top, rootRows),
              width: isVertical
                ? cellsToPercent(1, rootCols)
                : cellsToPercent(gutter.rect.width, rootCols),
              height: isVertical
                ? cellsToPercent(gutter.rect.height, rootRows)
                : cellsToPercent(1, rootRows),
            }}
          >
            <div
              data-testid="split-gutter"
              data-axis={gutter.axis}
              className={`absolute touch-none select-none ${
                isVertical
                  ? '-inset-x-1 inset-y-0 cursor-col-resize'
                  : 'inset-x-0 -inset-y-1 cursor-row-resize'
              }`}
              onPointerDown={(event) => handleGutterPointerDown(index, gutter, event)}
            >
              <div
                className={`absolute bg-foreground/[0.08] transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none ${
                  isVertical
                    ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
                    : 'inset-x-0 top-1/2 h-px -translate-y-1/2'
                } ${isDragging ? 'bg-primary/60' : 'hover:bg-primary/50'}`}
              />
            </div>
            {/* 拖拽参考线 */}
            {isDragging && dragState && (
              <div
                className="pointer-events-none absolute bg-primary/45"
                style={
                  isVertical
                    ? {
                        top: 0,
                        bottom: 0,
                        width: 2,
                        left: `calc(50% + ${dragState.deltaPx}px)`,
                      }
                    : {
                        left: 0,
                        right: 0,
                        height: 2,
                        top: `calc(50% + ${dragState.deltaPx}px)`,
                      }
                }
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
