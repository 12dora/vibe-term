// 框选的纯几何：全部在滚动容器的「内容坐标系」（含 scrollTop / scrollLeft）里计算。

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PathRect {
  path: string;
  rect: Rect;
}

export const MARQUEE_DRAG_THRESHOLD_PX = 4;
export const MARQUEE_EDGE_PX = 24;
export const MARQUEE_MAX_SCROLL_STEP_PX = 18;

export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

/** 仅边线相贴不算相交。 */
export function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** 与框选矩形相交的行，按 `rects` 的顺序收集。 */
export function hitPaths(rects: readonly PathRect[], marquee: Rect): Set<string> {
  const hit = new Set<string>();
  for (const { path, rect } of rects) {
    if (intersects(rect, marquee)) hit.add(path);
  }
  return hit;
}

export function exceedsThreshold(
  a: Point,
  b: Point,
  threshold = MARQUEE_DRAG_THRESHOLD_PX
): boolean {
  return Math.abs(a.x - b.x) >= threshold || Math.abs(a.y - b.y) >= threshold;
}

export function clampPoint(point: Point, width: number, height: number): Point {
  return {
    x: Math.min(Math.max(0, point.x), Math.max(0, width)),
    y: Math.min(Math.max(0, point.y), Math.max(0, height)),
  };
}

/**
 * 指针贴近容器上 / 下边缘时每帧该滚多少像素（负数向上）。越靠近（或越过）边缘越快。
 */
export function edgeScrollDelta(
  pointerY: number,
  top: number,
  bottom: number,
  edge = MARQUEE_EDGE_PX,
  maxStep = MARQUEE_MAX_SCROLL_STEP_PX
): number {
  const above = top + edge - pointerY;
  if (above > 0) return -Math.ceil(maxStep * Math.min(1, above / edge));
  const below = pointerY - (bottom - edge);
  if (below > 0) return Math.ceil(maxStep * Math.min(1, below / edge));
  return 0;
}
