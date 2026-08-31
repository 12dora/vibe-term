// Terminal 对外暴露的命令式句柄：宿主（快捷键、editor、尺寸同步、分屏几何）经它操作实例。

import type { CompatibleTerminalLike, FitAddon } from 'ghostty-terminal';
import { type RefObject, useImperativeHandle } from 'react';
import type { TerminalSurface } from '../TerminalSurface';
import type { TerminalRenderTarget } from '../terminal-snapshot';
import { computeContainerSize } from '../terminalMetrics';
import type { TerminalRef } from '../types';
import type { useTerminalResize } from '../useTerminalResize';

type ResizeActions = ReturnType<typeof useTerminalResize>;

export interface TerminalHandleOptions {
  ref: React.Ref<TerminalRef>;
  instance: CompatibleTerminalLike | null;
  containerRef: RefObject<HTMLDivElement | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  surfaceRef: RefObject<TerminalSurface<TerminalRenderTarget> | null>;
  authoritativeSizeRef: RefObject<{ cols: number; rows: number } | null>;
  pendingLocalSize: ResizeActions['pendingLocalSize'];
  clearPendingLocalSize: ResizeActions['clearPendingLocalSize'];
  runPostSelectResize: ResizeActions['runPostSelectResize'];
  scheduleResize: ResizeActions['scheduleResize'];
}

export function useTerminalHandle({
  ref,
  instance,
  containerRef,
  fitAddonRef,
  surfaceRef,
  authoritativeSizeRef,
  pendingLocalSize,
  clearPendingLocalSize,
  runPostSelectResize,
  scheduleResize,
}: TerminalHandleOptions): void {
  useImperativeHandle(
    ref,
    () => ({
      write: (data) => instance?.write(data),
      reset: () => {
        instance?.reset();
        const target = surfaceRef.current?.getVisibleTarget();
        if (target) target.liveOutputEndedWithCR = false;
      },
      scrollToBottom: () => instance?.scrollToBottom(),
      resize: (cols, rows) => {
        authoritativeSizeRef.current = { cols, rows };
        instance?.resize(cols, rows);
      },
      getTerminal: () => instance ?? null,
      getSize: () => {
        if (!instance) return null;
        return { cols: Math.max(2, instance.cols), rows: Math.max(2, instance.rows) };
      },
      runPostSelectResize: () => runPostSelectResize(),
      scheduleResize: (kind, options) => scheduleResize(kind, options),
      calculateSizeFromContainer: () => {
        const container = containerRef.current;
        const term = instance;
        const fitAddon = fitAddonRef.current;
        if (!container || !term) return null;

        const rect = container.getBoundingClientRect();
        return computeContainerSize({
          rect: { width: rect.width, height: rect.height },
          cell: term._core?._renderService?.dimensions?.css?.cell,
          proposeDimensions: fitAddon ? () => fitAddon.proposeDimensions() : null,
        });
      },
      getPendingLocalSize: () => pendingLocalSize.current,
      clearPendingLocalSize,
      getCellSize: () => {
        const cell = instance?._core?._renderService?.dimensions?.css?.cell;
        if (!cell?.width || !cell?.height) return null;
        return { width: cell.width, height: cell.height };
      },
    }),
    [
      authoritativeSizeRef,
      clearPendingLocalSize,
      containerRef,
      fitAddonRef,
      instance,
      pendingLocalSize,
      runPostSelectResize,
      scheduleResize,
      surfaceRef,
    ]
  );
}
