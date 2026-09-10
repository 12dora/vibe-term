// 链路诊断浮层的横向定位：浮层挂在徽标上（`absolute right-0`），而徽标在页头动作区里的位置
// 随标签长短、同排按钮多少而变，手机上 288px 的浮层照着徽标右对齐会整块滑出屏幕。
// 这里只做纯计算：给出浮层宽度与相对徽标右边缘的偏移，组件量完 rect 后套上去。

export const POPOVER_MAX_WIDTH = 288;
export const POPOVER_VIEWPORT_MARGIN = 8;

/** 视口塞不下 288px 时按边距收窄，保证两侧都留得出 margin。 */
export function popoverWidth(
  viewportWidth: number,
  maxWidth = POPOVER_MAX_WIDTH,
  margin = POPOVER_VIEWPORT_MARGIN
): number {
  return Math.max(0, Math.min(maxWidth, viewportWidth - 2 * margin));
}

/**
 * 浮层右边缘默认贴着徽标右边缘（偏移 0），越界时才推回来：偏移为正=左移，为负=右移。
 * 两条约束——左边缘 ≥ margin、右边缘 ≤ viewportWidth - margin——夹出一个区间，取区间内离 0
 * 最近的那个值，所以能放下时布局与原来完全一致。
 */
export function clampPopoverOffset({
  anchorRight,
  viewportWidth,
  width,
  margin = POPOVER_VIEWPORT_MARGIN,
}: {
  /** 徽标容器右边缘的视口坐标（`getBoundingClientRect().right`）。 */
  anchorRight: number;
  viewportWidth: number;
  width: number;
  margin?: number;
}): number {
  const min = anchorRight - viewportWidth + margin;
  const max = anchorRight - width - margin;
  // 宽度没按 popoverWidth 收过时区间可能是空的，此时保左边缘（读的是左边那列标签）。
  if (max <= min) return max;
  return Math.min(Math.max(0, min), max);
}
