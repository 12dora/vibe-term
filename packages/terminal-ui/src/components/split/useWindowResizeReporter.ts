// window 级尺寸上报（resize-window 语义）：容器尺寸 / cell 尺寸 → 整窗 cols/rows，
// ResizeObserver 防抖触发；cell 尺寸未就绪（实例仍在异步创建）时有限重试。

import type { TmuxLayoutNode } from '@tmex/shared';
import { type RefObject, useCallback, useEffect, useRef } from 'react';
import { computeSplitWindowGridSize } from '../splitLayoutGeometry';
import {
  CELL_SIZE_MAX_RETRIES,
  CELL_SIZE_RETRY_MS,
  PANE_H_OVERHEAD_PX,
  PANE_V_OVERHEAD_PX,
  WINDOW_RESIZE_DEBOUNCE_MS,
} from './constants';

export interface WindowResizeReporterInput {
  containerRef: RefObject<HTMLElement | null>;
  layoutRoot: TmuxLayoutNode | null;
  getCellSize: () => { width: number; height: number } | null;
  onWindowResize: (cols: number, rows: number) => void;
  onWindowResizeSettled?: (cols: number, rows: number) => void;
  titleBarStackDepth: number;
  horizontalStackDepth: number;
}

export interface WindowResizeReporter {
  /** 立即上报一次；容器/layout/cell 尺寸未就绪时返回 false */
  reportNow: () => boolean;
}

export function useWindowResizeReporter({
  containerRef,
  layoutRoot,
  getCellSize,
  onWindowResize,
  onWindowResizeSettled,
  titleBarStackDepth,
  horizontalStackDepth,
}: WindowResizeReporterInput): WindowResizeReporter {
  const reportWindowSize = useCallback(() => {
    const container = containerRef.current;
    if (!container || !layoutRoot) return false;
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const cell = getCellSize();
    if (!cell) return false;
    const { cols, rows } = computeSplitWindowGridSize(layoutRoot, {
      viewport: { width: rect.width, height: rect.height },
      cell,
      paneChrome: { width: PANE_H_OVERHEAD_PX, height: PANE_V_OVERHEAD_PX },
    });
    onWindowResize(cols, rows);
    onWindowResizeSettled?.(cols, rows);
    return true;
  }, [containerRef, getCellSize, layoutRoot, onWindowResize, onWindowResizeSettled]);

  const reportWindowSizeRef = useRef(reportWindowSize);
  useEffect(() => {
    reportWindowSizeRef.current = reportWindowSize;
  }, [reportWindowSize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retries = 0;

    const tryReport = () => {
      if (reportWindowSizeRef.current()) {
        retries = 0;
        return;
      }
      // cellSize 未就绪（实例仍在异步创建），有限重试
      if (retries < CELL_SIZE_MAX_RETRIES) {
        retries += 1;
        retryTimer = setTimeout(tryReport, CELL_SIZE_RETRY_MS);
      }
    };

    const observer = new ResizeObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(tryReport, WINDOW_RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [containerRef]);

  // 布局结构变化（split/move-pane 使垂直堆叠数变化）时容器尺寸不变、RO 不触发，
  // 但标题栏占用的总高变了，需要重报整窗 rows（如左右拖成上下后可用高度减一条标题栏）
  // biome-ignore lint/correctness/useExhaustiveDependencies: layout depth values intentionally trigger a ref-backed report
  useEffect(() => {
    const timer = setTimeout(() => {
      reportWindowSizeRef.current();
    }, WINDOW_RESIZE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [titleBarStackDepth, horizontalStackDepth]);

  return { reportNow: useCallback(() => reportWindowSizeRef.current(), []) };
}
