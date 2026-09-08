// 建面时的初始网格。ghostty 把 scrollback 的「行」按**创建时的列数**折算成字节预算，
// 且 resize 之后不可再调整（见 ghostty-wasm.ts scrollbackLinesToBytes）：按默认 80 列
// 建面的话，一个 200 列的 pane 实际只能留住约 4000 行，前端缓存的 22 页 history 写进去
// 就被挤掉——多做了功还看不见结果。
//
// 控制器早于第一次真实测量创建（cell 像素尺寸要等终端 open 之后才有），所以这里用容器
// 像素 + 字号估一个**偏宽**的网格：max_scrollback 是上限而非预分配，估宽只是多留回滚，
// 估窄才会丢历史。

/** 等宽字体的 advance / fontSize 实测在 0.55~0.62；取更小值保证列数只会估多不会估少 */
const INITIAL_CELL_WIDTH_RATIO = 0.5;
const DEFAULT_LINE_HEIGHT = 1.2;
const MIN_INITIAL_COLS = 200;
const MAX_INITIAL_COLS = 400;
const MIN_INITIAL_ROWS = 24;
const MAX_INITIAL_ROWS = 120;

export interface InitialTerminalGridInput {
  /** 容器像素尺寸；测不到（未挂载 / 零尺寸）时退回宽默认值 */
  rect: { width: number; height: number } | null;
  fontSize: number;
  lineHeight?: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function resolveInitialTerminalGrid({
  rect,
  fontSize,
  lineHeight,
}: InitialTerminalGridInput): { cols: number; rows: number } {
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 0;
  const cellWidth = Math.max(1, size * INITIAL_CELL_WIDTH_RATIO);
  const ratio = lineHeight !== undefined && lineHeight > 0 ? lineHeight : DEFAULT_LINE_HEIGHT;
  const cellHeight = Math.max(1, size * ratio);
  const width = rect && Number.isFinite(rect.width) ? rect.width : 0;
  const height = rect && Number.isFinite(rect.height) ? rect.height : 0;
  return {
    cols: clamp(Math.ceil(width / cellWidth), MIN_INITIAL_COLS, MAX_INITIAL_COLS),
    rows: clamp(Math.ceil(height / cellHeight), MIN_INITIAL_ROWS, MAX_INITIAL_ROWS),
  };
}

export function measureElementRect(
  element: { getBoundingClientRect(): { width: number; height: number } } | null
): { width: number; height: number } | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return { width: rect.width, height: rect.height };
}
