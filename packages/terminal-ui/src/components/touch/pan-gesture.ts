import type { TerminalPanMetrics } from './types';

// 轴锁阈值：手势总位移越过它才定轴。小于长按位移容差（12px），保证「先定轴、再滚动」——
// 累积到一整行像素至少要 cellHeight/1.3 ≈ 14px，定轴一定发生在第一行滚出去之前。
export const PAN_AXIS_LOCK_PX = 8;

export type PanAxis = 'x' | 'y';

export interface PanPlan {
  panX: number;
  panY: number;
  /** 纵向未被平移吃掉的余量：到边后按嵌套滚动语义回落 scrollback */
  remainingY: number;
}

// 单指平移的锚点与轴锁。纵向位移仍由 TouchScrollGesture 统一取（锚点只有一处），
// 这里只管横向位移和轴判定。
export class TouchPanAnchor {
  private axis: PanAxis | null = null;
  private lastX = 0;
  private startX = 0;
  private startY = 0;

  anchor(clientX: number, clientY: number): void {
    this.axis = null;
    this.lastX = clientX;
    this.startX = clientX;
    this.startY = clientY;
  }

  reset(): void {
    this.axis = null;
  }

  takeHorizontalDelta(clientX: number): number {
    const delta = this.lastX - clientX;
    this.lastX = clientX;
    return delta;
  }

  // 首次总位移越过阈值时按主方向定轴，此后整个手势不再改轴（对角抖动不会来回切轴）。
  resolveAxis(clientX: number, clientY: number): PanAxis | null {
    if (this.axis) {
      return this.axis;
    }

    const dx = Math.abs(clientX - this.startX);
    const dy = Math.abs(clientY - this.startY);
    if (Math.max(dx, dy) < PAN_AXIS_LOCK_PX) {
      return null;
    }

    this.axis = dx > dy ? 'x' : 'y';
    return this.axis;
  }
}

function towardsEdge(delta: number, metrics: TerminalPanMetrics): number {
  const room = delta > 0 ? metrics.overflowY - metrics.scrollTop : metrics.scrollTop;
  const usable = Math.min(Math.abs(delta), Math.max(0, room));
  return delta > 0 ? usable : -usable;
}

// 该轴不超尺寸（或未定轴）→ 全额回落原有滚动语义，行为与开平移前完全一致。
export function planPan(
  axis: PanAxis | null,
  metrics: TerminalPanMetrics,
  deltaX: number,
  deltaY: number
): PanPlan {
  if (axis === 'x' && metrics.overflowX > 0) {
    // 轴锁在 X：纵向分量整体吞掉，不再连带滚 scrollback
    return { panX: deltaX, panY: 0, remainingY: 0 };
  }

  if (axis === 'y' && metrics.overflowY > 0) {
    const panY = towardsEdge(deltaY, metrics);
    return { panX: 0, panY, remainingY: deltaY - panY };
  }

  return { panX: 0, panY: 0, remainingY: deltaY };
}
