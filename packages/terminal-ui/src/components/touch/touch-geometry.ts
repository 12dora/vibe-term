import type { TerminalScroller } from './types';

export const TOUCH_SCROLL_GAIN = 1.3;
export const SCROLLBAR_TOUCH_HOTZONE_PX = 36;
export const LONG_PRESS_SELECT_MS = 500;
// 拖拽启动阈值必须与长按位移容差同值：首次越阈的 move 同时清长按定时器并发 press，
// 否则会出现 press 已发但长按定时器仍在武装的竞态窗口
export const LONG_PRESS_MOVE_TOLERANCE_PX = 12;
export const MOBILE_VIEWPORT_MAX_WIDTH_PX = 768;
export const FALLBACK_CELL_HEIGHT_PX = 18;

export interface TouchPoint {
  readonly identifier: number;
  readonly clientX: number;
  readonly clientY: number;
}

export interface TouchPointList {
  readonly length: number;
  item(index: number): TouchPoint | null;
}

export interface EdgeRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface TouchEnvironment {
  readonly innerWidth: number;
  readonly navigator: { readonly maxTouchPoints: number };
}

export function isMobileTouchEnvironment(view: TouchEnvironment): boolean {
  return (
    view.innerWidth < MOBILE_VIEWPORT_MAX_WIDTH_PX ||
    view.navigator.maxTouchPoints > 0 ||
    'ontouchstart' in view
  );
}

export function findTouchById(
  touchList: TouchPointList,
  identifier: number | null
): TouchPoint | null {
  if (identifier === null) return null;
  for (let i = 0; i < touchList.length; i += 1) {
    const touch = touchList.item(i);
    if (touch && touch.identifier === identifier) {
      return touch;
    }
  }
  return null;
}

export function touchCentroidY(touchList: TouchPointList): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < touchList.length; i += 1) {
    const touch = touchList.item(i);
    if (touch) {
      sum += touch.clientY;
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

export function movedDistance(fromX: number, fromY: number, toX: number, toY: number): number {
  return Math.hypot(toX - fromX, toY - fromY);
}

export function exceedsMoveTolerance(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  tolerancePx: number = LONG_PRESS_MOVE_TOLERANCE_PX
): boolean {
  return movedDistance(fromX, fromY, toX, toY) > tolerancePx;
}

export function terminalLineHeight(terminal: unknown): number {
  const core = (terminal as TerminalScroller | null | undefined)?._core;
  return core?._renderService?.dimensions?.css?.cell?.height ?? FALLBACK_CELL_HEIGHT_PX;
}

export function accumulateScrollPixels(pendingPixelDelta: number, deltaY: number): number {
  return pendingPixelDelta + deltaY * TOUCH_SCROLL_GAIN;
}

// 向零取整：正负方向都只消费完整行，余量留在累积器里等下一帧
export function pendingPixelsToLines(pendingPixelDelta: number, lineHeight: number): number {
  return pendingPixelDelta > 0
    ? Math.floor(pendingPixelDelta / lineHeight)
    : Math.ceil(pendingPixelDelta / lineHeight);
}

export function isInsideRect(rect: EdgeRect, clientX: number, clientY: number): boolean {
  const insideX = clientX >= rect.left && clientX <= rect.right;
  const insideY = clientY >= rect.top && clientY <= rect.bottom;
  return insideX && insideY;
}

export function isInsideRightEdgeHotzone(
  rect: EdgeRect,
  clientX: number,
  clientY: number,
  hotzonePx: number = SCROLLBAR_TOUCH_HOTZONE_PX
): boolean {
  if (!isInsideRect(rect, clientX, clientY)) {
    return false;
  }
  return clientX >= rect.right - hotzonePx;
}
