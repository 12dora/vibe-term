// 回放的字号与录像包络：量外框 + 录像包络 → 定字号，交给只读终端按这个字号开面。
//
// 字号默认就是设置里的终端字号；只有包络在该字号下塞不进外框才往下缩（见 replay-fit.ts）。
// ghostty 的字号只在建面时生效，改字号 = 重建实例（清屏 + 从 checkpoint 重放，选区也会没）。
// 所以开面本身要等齐两件事：外框量到了（且开窗动画已结束，否则 ghostty 量 cell 时会被
// `zoom-in-95` 的 transform 缩小约 5%），以及录像包络已知（或确认整份日志都没有尺寸）。
// 齐了之后第一个字号同步落地、不防抖——用户从头到尾只会看到一台终端、一个尺寸。
// 之后外框或包络再变才走 120 ms 防抖，避免连续重建。

import { useUIStore } from '@vibeterm/stores/react';
import { schedulePostPaintRefit } from '@vibeterm/terminal-ui/components/hooks/read-only-terminal-session';
import { ensureTerminalFonts } from '@vibeterm/terminal-ui/components/hooks/terminal-fonts-cache';
import { resolveFontStack } from '@vibeterm/theme';
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type ReplayFitGrid,
  clearCellWidthRatioCache,
  computeReplayFitFontSize,
  measureCellWidthRatio,
  replayFitCanMount,
  sameReplayFitGrid,
} from './replay-fit';

const FONT_DEBOUNCE_MS = 120;
/** 等开窗动画的兜底：拿不到 animationend / rAF 时也得让终端开起来。 */
const FRAME_SETTLE_FALLBACK_MS = 300;

interface FrameSize {
  width: number;
  height: number;
  /** 首帧绘制（含开窗动画）之后量过了：此前不开面。 */
  settled: boolean;
}

export interface ReplayFitOptions {
  /** 录像包络（默认 pane 的最大行列）；日志还没到时为 null。 */
  initialGrid: ReplayFitGrid | null;
  /** 日志已经拉完：到这一步还没有网格，就按设置里的字号开面。 */
  logSettled: boolean;
}

export interface ReplayFitState {
  /** 挂到回放外框上：字号按这个元素的内尺寸算。 */
  frameRef: RefObject<HTMLDivElement | null>;
  /** 开面用的字号；外框或包络还没齐时为 null，这时先别挂终端。 */
  fontSize: number | null;
  /** 仿真网格的下界（录像包络）：窗口更大时终端照样铺满窗口。 */
  minGrid: ReplayFitGrid | null;
  /** 适配后的第一台终端还没定下来：加载遮罩要一直盖到那时候。 */
  pending: boolean;
  /** 录像包络变了就告诉它；同尺寸不会引起重渲染。 */
  setGrid: (grid: ReplayFitGrid | null) => void;
}

/** 外框内尺寸：用 clientWidth/Height，dialog 的 `zoom-in-95` 期间 bounding rect 会偏小。 */
function useFrameSize(ref: RefObject<HTMLElement | null>): FrameSize {
  const [size, setSize] = useState<FrameSize>({ width: 0, height: 0, settled: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (settled: boolean) => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setSize((prev) => {
        const nextSettled = prev.settled || settled;
        if (prev.width === width && prev.height === height && prev.settled === nextSettled) {
          return prev;
        }
        return { width, height, settled: nextSettled };
      });
    };
    // 布局副作用里先量一次：没有开窗动画时不必等 ResizeObserver 的下一拍。
    read(false);
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => read(false)) : null;
    observer?.observe(el);
    // 开窗动画结束后再量一次，并放行开面。
    const cancelRefit = schedulePostPaintRefit(el, () => read(true));
    const fallback = setTimeout(() => read(true), FRAME_SETTLE_FALLBACK_MS);
    return () => {
      observer?.disconnect();
      cancelRefit();
      clearTimeout(fallback);
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

/** 设备像素比：窗口拖到另一块屏幕时 CSS 尺寸可能一点没变，只能靠 resolution 查询盯着。 */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => globalThis.devicePixelRatio ?? 1);
  useEffect(() => {
    const media = globalThis.matchMedia?.(`(resolution: ${dpr}dppx)`);
    if (!media?.addEventListener) return;
    const onChange = () => setDpr(globalThis.devicePixelRatio ?? 1);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [dpr]);
  return dpr;
}

/** 第一个字号同步落地，之后的变化防抖。`active` 为假表示还不到开面的时候。 */
function useFittedFontSize(target: number, active: boolean): number | null {
  const [applied, setApplied] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!active || applied !== null || !(target > 0)) return;
    setApplied(target);
  }, [active, applied, target]);
  useEffect(() => {
    if (applied === null || target === applied || !(target > 0)) return;
    const timer = setTimeout(() => setApplied(target), FONT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [applied, target]);
  return applied;
}

export function useReplayFit(options: ReplayFitOptions): ReplayFitState {
  const frameRef = useRef<HTMLDivElement>(null);
  const baseFontSize = useUIStore((state) => state.terminalFontSize);
  const lineHeight = useUIStore((state) => state.terminalLineHeight);
  const fontId = useUIStore((state) => state.terminalFontId);
  const cellWidthRatio = useCellWidthRatio(fontId, baseFontSize);
  const devicePixelRatio = useDevicePixelRatio();
  const frame = useFrameSize(frameRef);
  const [liveGrid, setLiveGrid] = useState<ReplayFitGrid | null>(null);

  const setGrid = useCallback((next: ReplayFitGrid | null) => {
    setLiveGrid((prev) => {
      // 日志还没给出任何尺寸时为 null：留住上一次的包络，别让字号在 基准值 ↔ 适配值
      // 之间来回跳，每跳一次终端就重建一次。
      if (next === null || sameReplayFitGrid(prev, next)) return prev;
      return { cols: next.cols, rows: next.rows };
    });
  }, []);

  const grid = liveGrid ?? options.initialGrid;
  const target = useMemo(
    () =>
      computeReplayFitFontSize({
        grid,
        frame: { width: frame.width, height: frame.height },
        baseFontSize,
        metrics: { cellWidthRatio, lineHeight, devicePixelRatio },
      }),
    [grid, frame.width, frame.height, baseFontSize, cellWidthRatio, lineHeight, devicePixelRatio]
  );

  const canMount = replayFitCanMount({ frame, grid, logSettled: options.logSettled });
  const fontSize = useFittedFontSize(target, canMount);
  // 只认「第一台适配后的终端」：之后换字号也重建，但那时画面已经有内容，再盖遮罩只会闪。
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!settled && fontSize !== null && fontSize === target) setSettled(true);
  }, [settled, fontSize, target]);

  return { frameRef, fontSize, minGrid: grid, pending: !settled, setGrid };
}
