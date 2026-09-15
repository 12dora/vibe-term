// 回放适配：录像的网格是被分享那一端的（手机可能是 52×47），pty 流不能重排，
// 于是反过来调字号——把「网格 × cell」等比放到回放外框里。字号驱动而不是 CSS 缩放，
// 放大后字仍是重画出来的，命中测试也不用改。
//
// 计算只依赖（网格, 外框尺寸, 字体度量），绝不回读终端自己量出来的尺寸，否则
// 「字号改 → 表面变大 → 再算字号」会自激振荡。

export interface ReplayFitGrid {
  cols: number;
  rows: number;
}

export interface ReplayFitMetrics {
  /** cell 宽 ÷ 字号：等宽字体的 advance 比例，实测得到。 */
  cellWidthRatio: number;
  lineHeight: number;
  devicePixelRatio: number;
}

export interface ReplayFitInput {
  grid: ReplayFitGrid | null;
  /** 外框内尺寸（clientWidth/clientHeight）；量不到时为 0。 */
  frame: { width: number; height: number };
  metrics: ReplayFitMetrics;
  /** 没有网格 / 量不到外框时用的字号，即用户设置里的终端字号。 */
  baseFontSize: number;
}

export const REPLAY_FIT_MIN_FONT_SIZE = 8;
export const REPLAY_FIT_MAX_FONT_SIZE = 40;
/** 留两像素余量：外框与内容同宽时一次进位就会把居中翻成平移视口。 */
const FRAME_SAFETY_PX = 2;
/** 量比例的字号：取大值，把字体度量的量化误差摊薄。 */
const RATIO_PROBE_FONT_SIZE = 100;
const RATIO_PROBE_TEXT = 'W'.repeat(10);
/** 等宽字体的 advance 比例在 0.5~0.7；超出这个范围说明没量准，退回典型值。 */
const MIN_CELL_WIDTH_RATIO = 0.4;
const MAX_CELL_WIDTH_RATIO = 1.2;
export const DEFAULT_CELL_WIDTH_RATIO = 0.6;

function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return REPLAY_FIT_MIN_FONT_SIZE;
  return Math.min(REPLAY_FIT_MAX_FONT_SIZE, Math.max(REPLAY_FIT_MIN_FONT_SIZE, Math.floor(value)));
}

/**
 * 某字号下 ghostty 的 cell 像素尺寸：宽按 advance 实测、高恒为 `字号 × 行高`，
 * 两者都对齐到物理像素。dpr 与 ghostty 一样按 `Math.max(1, dpr)` 夹住
 * （terminal-dom.ts measureCellDimensions）——浏览器缩小到 dpr < 1 时若不夹，
 * 这里会算出比 ghostty 实际用的更小的 cell，字号就会选大一档而溢出外框。
 */
export function replayFitCellSize(
  fontSize: number,
  metrics: ReplayFitMetrics
): { width: number; height: number } {
  const dpr = Math.max(1, metrics.devicePixelRatio || 1);
  return {
    width: Math.max(1, Math.round(fontSize * metrics.cellWidthRatio * dpr)) / dpr,
    height: Math.max(1, Math.round(fontSize * metrics.lineHeight * dpr)) / dpr,
  };
}

function fitsInFrame(fontSize: number, grid: ReplayFitGrid, input: ReplayFitInput): boolean {
  const cell = replayFitCellSize(fontSize, input.metrics);
  return (
    grid.cols * cell.width <= input.frame.width - FRAME_SAFETY_PX &&
    grid.rows * cell.height <= input.frame.height - FRAME_SAFETY_PX
  );
}

function usableInput(input: ReplayFitInput): ReplayFitGrid | null {
  const grid = input.grid;
  if (!grid || !(grid.cols > 0) || !(grid.rows > 0)) return null;
  if (!(input.frame.width > 0) || !(input.frame.height > 0)) return null;
  if (!(input.metrics.cellWidthRatio > 0) || !(input.metrics.lineHeight > 0)) return null;
  return grid;
}

/**
 * 把录像网格塞进外框的最大字号：`min(宽限, 高限)` 取整后再按实际 cell 尺寸收/放一档。
 *
 * 解析解按未取整的 cell 算，而 ghostty 的 cell 会对齐到物理像素，逐格半像素误差在
 * 220 列上能累出几十像素，所以最后一定要按真 cell 校一遍。
 * 触到下限还塞不下就停在下限，剩下的交给既有的平移视口（贴左上 + 可滚）。
 */
export function computeReplayFitFontSize(input: ReplayFitInput): number {
  const grid = usableInput(input);
  if (!grid) return input.baseFontSize;
  const byWidth =
    (input.frame.width - FRAME_SAFETY_PX) / (grid.cols * input.metrics.cellWidthRatio);
  const byHeight = (input.frame.height - FRAME_SAFETY_PX) / (grid.rows * input.metrics.lineHeight);
  let size = clampFontSize(Math.min(byWidth, byHeight));
  while (size > REPLAY_FIT_MIN_FONT_SIZE && !fitsInFrame(size, grid, input)) size -= 1;
  while (size < REPLAY_FIT_MAX_FONT_SIZE && fitsInFrame(size + 1, grid, input)) size += 1;
  return size;
}

export interface ReplayFitMountInput {
  /** 外框内尺寸 + 「首帧（含开窗动画）之后量过了」。 */
  frame: { width: number; height: number; settled: boolean };
  grid: ReplayFitGrid | null;
  /** 日志已拉完：到这一步还没有网格就按基准字号开面。 */
  logSettled: boolean;
}

/**
 * 可以开面了吗。字号只在建面时生效，所以宁可晚一点开：外框没量到、或录像网格还没到手时
 * 开出来的那一台必然要被换掉，用户会看到画面跳一下，选区也会丢。
 */
export function replayFitCanMount(input: ReplayFitMountInput): boolean {
  if (!input.frame.settled) return false;
  if (!(input.frame.width > 0) || !(input.frame.height > 0)) return false;
  return input.grid !== null || input.logSettled;
}

export function sameReplayFitGrid(a: ReplayFitGrid | null, b: ReplayFitGrid | null): boolean {
  if (a === null || b === null) return a === b;
  return a.cols === b.cols && a.rows === b.rows;
}

export interface CellWidthProbe {
  measure(fontStack: string, fontSize: number, text: string): number;
}

/**
 * advance ÷ 字号。用与 ghostty 同一套探针（隐藏 span + `W`×10 + white-space: pre），
 * canvas measureText 与 DOM 的 advance 在有 letter-spacing/字体回退时会分叉。
 */
export function cellWidthRatioFrom(probe: CellWidthProbe, fontStack: string): number | null {
  const width = probe.measure(fontStack, RATIO_PROBE_FONT_SIZE, RATIO_PROBE_TEXT);
  const ratio = width / (RATIO_PROBE_TEXT.length * RATIO_PROBE_FONT_SIZE);
  if (!Number.isFinite(ratio) || ratio < MIN_CELL_WIDTH_RATIO || ratio > MAX_CELL_WIDTH_RATIO) {
    return null;
  }
  return ratio;
}

const domProbe: CellWidthProbe = {
  measure(fontStack, fontSize, text) {
    const host = globalThis.document?.body;
    if (!host) return 0;
    const span = document.createElement('span');
    span.textContent = text;
    span.style.position = 'absolute';
    span.style.visibility = 'hidden';
    span.style.whiteSpace = 'pre';
    span.style.fontFamily = fontStack;
    span.style.fontSize = `${fontSize}px`;
    host.appendChild(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    return width;
  },
};

const ratioCache = new Map<string, number>();

/** 同一字体栈只量一次；字体到货后由 `clearCellWidthRatioCache` 作废重量。量不到不写缓存（SSR / 字体未就绪）。 */
export function measureCellWidthRatio(fontStack: string): number {
  const cached = ratioCache.get(fontStack);
  if (cached !== undefined) return cached;
  const ratio = cellWidthRatioFrom(domProbe, fontStack);
  if (ratio === null) return DEFAULT_CELL_WIDTH_RATIO;
  ratioCache.set(fontStack, ratio);
  return ratio;
}

export function clearCellWidthRatioCache(): void {
  ratioCache.clear();
}
