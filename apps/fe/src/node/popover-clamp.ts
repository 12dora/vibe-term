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

/** 浮层与徽标之间的缝（原来的 `mt-1`）。 */
export const POPOVER_GAP = 4;

/** 徽标下方至少要有这么高才值得往下展开，否则翻到上方。 */
export const POPOVER_MIN_BELOW = 200;

export interface PopoverAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * 可见视口。手机上要用**视觉**视口（`window.visualViewport`）：地址栏收起、键盘弹出、双指缩放
 * 之后它才是用户真正看得见的那块，`innerHeight` 不是。
 */
export interface PopoverViewportRect {
  width: number;
  height: number;
  /** 视觉视口相对布局视口的偏移；`fixed` 与 `getBoundingClientRect` 都用布局视口坐标。 */
  offsetLeft?: number;
  offsetTop?: number;
  /** 布局视口高度（`documentElement.clientHeight`）；翻到上方时用 `bottom` 定位要靠它换算。 */
  layoutHeight?: number;
}

export interface PopoverBox {
  left: number;
  /** 向下展开时写 `top`，翻到上方时为 null。 */
  top: number | null;
  /** 翻到上方时写 `bottom`（贴着徽标上沿），向下展开时为 null。 */
  bottom: number | null;
  width: number;
  /** 卡片自身滚动的上限：可见视口在这个方向上还剩多少。 */
  maxHeight: number;
  above: boolean;
}

/**
 * `position: fixed` 的浮层盒子：横向沿用「贴徽标右对齐、越界推回」，纵向夹进可见视口并在
 * 下方明显不够时翻到徽标上方。页头本身在安全区之下，但翻上去的卡片会顶到状态栏，
 * 所以上界另收 `safeTop`（`--vibeterm-safe-area-top` 的解析值）。
 */
export function placePopover({
  anchor,
  viewport,
  maxWidth = POPOVER_MAX_WIDTH,
  margin = POPOVER_VIEWPORT_MARGIN,
  gap = POPOVER_GAP,
  minBelow = POPOVER_MIN_BELOW,
  safeTop = 0,
}: {
  anchor: PopoverAnchorRect;
  viewport: PopoverViewportRect;
  maxWidth?: number;
  margin?: number;
  gap?: number;
  minBelow?: number;
  safeTop?: number;
}): PopoverBox {
  const viewLeft = viewport.offsetLeft ?? 0;
  const viewTop = viewport.offsetTop ?? 0;
  const width = popoverWidth(viewport.width, maxWidth, margin);
  // clampPopoverOffset 按「视口自 0 起」算，视觉视口有偏移时先换算过去，再把偏移加回来
  const offset = clampPopoverOffset({
    anchorRight: anchor.right - viewLeft,
    viewportWidth: viewport.width,
    width,
    margin,
  });
  const left = anchor.right - offset - width;

  const topLimit = Math.max(viewTop + margin, safeTop + margin);
  const bottomLimit = viewTop + viewport.height - margin;
  const belowTop = Math.max(anchor.bottom + gap, topLimit);
  const belowSpace = bottomLimit - belowTop;
  const aboveBottom = Math.min(anchor.top - gap, bottomLimit);
  const aboveSpace = aboveBottom - topLimit;
  if (belowSpace >= minBelow || aboveSpace <= belowSpace) {
    return {
      left,
      top: belowTop,
      bottom: null,
      width,
      maxHeight: Math.max(0, belowSpace),
      above: false,
    };
  }
  const layoutHeight = viewport.layoutHeight ?? viewTop + viewport.height;
  return {
    left,
    top: null,
    bottom: layoutHeight - aboveBottom,
    width,
    maxHeight: Math.max(0, aboveSpace),
    above: true,
  };
}
