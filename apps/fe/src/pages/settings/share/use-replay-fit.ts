// 回放外框的自适应字号：量外框 + 当前录像网格 → 算字号，交给只读终端重建。
// 字号一变终端要重开一次（ghostty 的字号只在建面时生效），所以要防抖，
// 免得拖窗口或录像里连着几条 resize 时反复重建。

import { useUIStore } from '@vibeterm/stores/react';
import { schedulePostPaintRefit } from '@vibeterm/terminal-ui/components/hooks/read-only-terminal-session';
import { ensureTerminalFonts } from '@vibeterm/terminal-ui/components/hooks/terminal-fonts-cache';
import { resolveFontStack } from '@vibeterm/theme';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ReplayFitGrid,
  clearCellWidthRatioCache,
  computeReplayFitFontSize,
  measureCellWidthRatio,
  sameReplayFitGrid,
} from './replay-fit';

const FONT_DEBOUNCE_MS = 120;

interface FrameSize {
  width: number;
  height: number;
}

export interface ReplayFitState {
  /** 挂到回放外框上：字号按这个元素的内尺寸算。 */
  frameRef: RefObject<HTMLDivElement | null>;
  fontSize: number;
  /** 录像网格变了就告诉它；同尺寸不会引起重渲染。 */
  setGrid: (grid: ReplayFitGrid | null) => void;
}

/** 外框内尺寸：用 clientWidth/Height，dialog 的 `zoom-in-95` 期间 bounding rect 会偏小。 */
function useFrameSize(ref: RefObject<HTMLElement | null>): FrameSize {
  const [size, setSize] = useState<FrameSize>({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const read = () => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    // 开窗动画结束后再量一次：动画期间外框还没到最终尺寸。
    const cancelRefit = schedulePostPaintRefit(el, read);
    return () => {
      observer.disconnect();
      cancelRefit();
    };
  }, [ref]);
  return size;
}

/**
 * 字体栈的 advance 比例。终端字体是按需加载的，没到货时量到的是系统等宽回退（比例偏大），
 * 算出来的字号会比终端实际能放下的小一档。所以等终端那套字体加载完再量一次。
 */
function useCellWidthRatio(fontId: string, fontSize: number): number {
  const fontStack = useMemo(() => resolveFontStack(fontId), [fontId]);
  const [ratio, setRatio] = useState(() => measureCellWidthRatio(fontStack));
  useEffect(() => {
    setRatio(measureCellWidthRatio(fontStack));
    let cancelled = false;
    const remeasure = () => {
      if (cancelled) return;
      clearCellWidthRatioCache();
      setRatio(measureCellWidthRatio(fontStack));
    };
    const pending = ensureTerminalFonts(fontId, fontSize);
    if (pending) void pending.then(remeasure, remeasure);
    else remeasure();
    return () => {
      cancelled = true;
    };
  }, [fontStack, fontId, fontSize]);
  return ratio;
}

function useDebouncedFontSize(target: number, initial: number): number {
  const [fontSize, setFontSize] = useState(initial);
  useEffect(() => {
    if (!(target > 0) || target === fontSize) return;
    const timer = setTimeout(() => setFontSize(target), FONT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [target, fontSize]);
  return fontSize;
}

export function useReplayFit(): ReplayFitState {
  const frameRef = useRef<HTMLDivElement>(null);
  const baseFontSize = useUIStore((state) => state.terminalFontSize);
  const lineHeight = useUIStore((state) => state.terminalLineHeight);
  const fontId = useUIStore((state) => state.terminalFontId);
  const cellWidthRatio = useCellWidthRatio(fontId, baseFontSize);
  const frame = useFrameSize(frameRef);
  const [grid, setGridState] = useState<ReplayFitGrid | null>(null);

  const setGrid = useCallback((next: ReplayFitGrid | null) => {
    setGridState((prev) => {
      // 拖回第一个 checkpoint 之前时录像网格会暂时为 null；这时留住上一次的尺寸，
      // 否则字号会在 基准值 ↔ 适配值 之间来回跳，每跳一次终端就重建一次。
      if (next === null || sameReplayFitGrid(prev, next)) return prev;
      return { cols: next.cols, rows: next.rows };
    });
  }, []);

  const target = useMemo(
    () =>
      computeReplayFitFontSize({
        grid,
        frame,
        baseFontSize,
        metrics: {
          cellWidthRatio,
          lineHeight,
          devicePixelRatio: globalThis.devicePixelRatio ?? 1,
        },
      }),
    [grid, frame, baseFontSize, cellWidthRatio, lineHeight]
  );

  return { frameRef, fontSize: useDebouncedFontSize(target, baseFontSize), setGrid };
}
