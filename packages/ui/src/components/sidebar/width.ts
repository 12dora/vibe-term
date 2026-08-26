import {
  SIDEBAR_WIDTH_DEFAULT_PX,
  SIDEBAR_WIDTH_MAX_RESERVE_PX,
  SIDEBAR_WIDTH_MIN_PX,
} from './constants';

export type SidebarSide = 'left' | 'right';

export function viewportWidth(): number {
  return typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth;
}

export function sidebarMaxWidth(viewport: number): number {
  return Math.max(SIDEBAR_WIDTH_MIN_PX, viewport - SIDEBAR_WIDTH_MAX_RESERVE_PX);
}

/** 用户期望宽度：只受下限约束，不被当前视口裁剪，窗口放大后可恢复。 */
export function preferredSidebarWidth(value: number): number {
  return Math.max(SIDEBAR_WIDTH_MIN_PX, Math.round(value));
}

export function clampSidebarWidth(value: number, viewport: number): number {
  return Math.min(sidebarMaxWidth(viewport), preferredSidebarWidth(value));
}

export function parseStoredSidebarWidth(raw: string | null): number {
  const stored = Number(raw);
  return Number.isFinite(stored) && stored > 0
    ? preferredSidebarWidth(stored)
    : SIDEBAR_WIDTH_DEFAULT_PX;
}

export function resizedSidebarWidth(startWidth: number, deltaX: number, side: SidebarSide): number {
  return startWidth + (side === 'left' ? deltaX : -deltaX);
}
