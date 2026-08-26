// 分屏渲染的固定尺寸常量与单位换算。

export const WINDOW_RESIZE_DEBOUNCE_MS = 150;
export const CELL_SIZE_RETRY_MS = 200;
export const CELL_SIZE_MAX_RETRIES = 15;
// 每个 pane 的垂直占位：上留白 6px + 浮起标题栏 24px + 下方视觉空间 8px + 底部留白 8px
export const PANE_V_OVERHEAD_PX = 46;
// 标题栏区域高度（垂直占位的上半部分）
export const PANE_HEADER_PX = 38;
// 每个 pane 的水平留白：左右各 6px，让内容与 splitter/边缘之间有视觉空白
export const PANE_H_OVERHEAD_PX = 12;
export const PANE_DRAG_THRESHOLD_PX = 6;

// cells → 百分比：容器与 window 尺寸过渡期失配时仍铺满
export function cellsToPercent(cells: number, total: number): string {
  return `${(cells / Math.max(1, total)) * 100}%`;
}
