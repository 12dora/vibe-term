// 框选（橡皮筋选择）：鼠标主键在非拖拽源上按下并拖过阈值后开始，期间捕获指针。
// 行的矩形在起框时量一次并换算到内容坐标系，之后滚动不必重量。

import type { PointerEvent, RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type SelectionState, selectByRect } from '../model/selection';
import { isEditableTarget } from '../model/shortcuts';
import {
  type PathRect,
  type Point,
  type Rect,
  clampPoint,
  edgeScrollDelta,
  exceedsThreshold,
  hitPaths,
  rectFromPoints,
} from './marquee';
import { ROW_PATH_ATTR, ROW_SELECTOR, isDraggableTarget, isInertTarget } from './row-target';
import { useLatestRef } from './use-latest-ref';

export interface MarqueeOptions {
  containerRef: RefObject<HTMLElement | null>;
  /** 触屏下关闭 */
  enabled: boolean;
  order: readonly string[];
  selection: SelectionState;
  onSelectionChange(next: SelectionState): void;
}

export interface MarqueeHandlers {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
}

export interface MarqueeResult {
  /** 框选矩形（容器内容坐标系）；未在框选时为 null */
  rect: Rect | null;
  handlers: MarqueeHandlers;
  /** 框选刚结束时返回 true 并复位：随后的 click 应被忽略 */
  consumeDragClick: () => boolean;
}

/** 松开后多久内的 click 视为这次拖拽带出来的 */
const CLICK_SUPPRESS_MS = 80;

interface Session {
  pointerId: number;
  startClient: Point;
  startContent: Point;
  lastClient: Point;
  additive: boolean;
  base: SelectionState;
  active: boolean;
  rows: PathRect[];
  frame: number | null;
  /** 上一次命中集合的指纹，没变就不通知 */
  hitKey: string | null;
}

interface Runtime {
  options: { readonly current: MarqueeOptions };
  session: { current: Session | null };
  suppressClick: { current: boolean };
  setRect: (rect: Rect | null) => void;
}

function toContent(container: HTMLElement, client: Point): Point {
  const bounds = container.getBoundingClientRect();
  return {
    x: client.x - bounds.left + container.scrollLeft,
    y: client.y - bounds.top + container.scrollTop,
  };
}

function collectRowRects(container: HTMLElement): PathRect[] {
  const bounds = container.getBoundingClientRect();
  const dx = container.scrollLeft - bounds.left;
  const dy = container.scrollTop - bounds.top;
  const rows: PathRect[] = [];
  for (const element of container.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const path = element.getAttribute(ROW_PATH_ATTR);
    if (path === null) continue;
    const box = element.getBoundingClientRect();
    rows.push({
      path,
      rect: {
        left: box.left + dx,
        top: box.top + dy,
        right: box.right + dx,
        bottom: box.bottom + dy,
      },
    });
  }
  return rows;
}

// 按在滚动条上不算：滚动条在 client 区域之外
function isOnScrollbar(container: HTMLElement, event: PointerEvent<HTMLElement>): boolean {
  const bounds = container.getBoundingClientRect();
  return (
    event.clientX - bounds.left >= container.clientLeft + container.clientWidth ||
    event.clientY - bounds.top >= container.clientTop + container.clientHeight
  );
}

function canStart(container: HTMLElement, event: PointerEvent<HTMLElement>): boolean {
  if (event.button !== 0 || event.pointerType !== 'mouse') return false;
  const { target } = event;
  if (isDraggableTarget(target) || isInertTarget(target) || isEditableTarget(target)) return false;
  return !isOnScrollbar(container, event);
}

function applyMarquee(runtime: Runtime, session: Session, container: HTMLElement): void {
  const current = clampPoint(
    toContent(container, session.lastClient),
    container.scrollWidth,
    container.scrollHeight
  );
  const marquee = rectFromPoints(session.startContent, current);
  runtime.setRect(marquee);
  const hit = hitPaths(session.rows, marquee);
  const hitKey = [...hit].join('\n');
  if (hitKey === session.hitKey) return;
  session.hitKey = hitKey;
  const { order, onSelectionChange } = runtime.options.current;
  onSelectionChange(selectByRect(order, hit, session.base, session.additive));
}

function scheduleAutoScroll(runtime: Runtime): void {
  const session = runtime.session.current;
  if (!session?.active) return;
  session.frame = requestAnimationFrame(() => {
    const container = runtime.options.current.containerRef.current;
    if (runtime.session.current !== session || !container) return;
    const bounds = container.getBoundingClientRect();
    const delta = edgeScrollDelta(session.lastClient.y, bounds.top, bounds.bottom);
    if (delta !== 0) {
      const before = container.scrollTop;
      container.scrollTop = before + delta;
      if (container.scrollTop !== before) applyMarquee(runtime, session, container);
    }
    scheduleAutoScroll(runtime);
  });
}

function begin(runtime: Runtime, event: PointerEvent<HTMLElement>): void {
  const { containerRef, enabled, selection } = runtime.options.current;
  const container = containerRef.current;
  if (!enabled || !container || !canStart(container, event)) return;
  const client = { x: event.clientX, y: event.clientY };
  runtime.session.current = {
    pointerId: event.pointerId,
    startClient: client,
    startContent: toContent(container, client),
    lastClient: client,
    additive: event.shiftKey || event.metaKey || event.ctrlKey,
    base: selection,
    active: false,
    rows: [],
    frame: null,
    hitKey: null,
  };
}

function finish(runtime: Runtime, pointerId: number): void {
  const session = runtime.session.current;
  if (!session || session.pointerId !== pointerId) return;
  runtime.session.current = null;
  if (session.frame !== null) cancelAnimationFrame(session.frame);
  if (!session.active) return;
  runtime.suppressClick.current = true;
  setTimeout(() => {
    runtime.suppressClick.current = false;
  }, CLICK_SUPPRESS_MS);
  const container = runtime.options.current.containerRef.current;
  if (container?.hasPointerCapture?.(pointerId)) container.releasePointerCapture(pointerId);
  runtime.setRect(null);
}

function move(runtime: Runtime, event: PointerEvent<HTMLElement>): void {
  const session = runtime.session.current;
  const container = runtime.options.current.containerRef.current;
  if (!session || session.pointerId !== event.pointerId || !container) return;
  // 没过阈值就在视图外松开时收不到 pointerup，靠 buttons 兜底
  if (event.buttons === 0) {
    finish(runtime, event.pointerId);
    return;
  }
  session.lastClient = { x: event.clientX, y: event.clientY };
  if (!session.active) {
    if (!exceedsThreshold(session.startClient, session.lastClient)) return;
    session.active = true;
    session.rows = collectRowRects(container);
    container.setPointerCapture?.(event.pointerId);
    scheduleAutoScroll(runtime);
  }
  applyMarquee(runtime, session, container);
}

export function useMarqueeSelection(options: MarqueeOptions): MarqueeResult {
  const [rect, setRect] = useState<Rect | null>(null);
  const latest = useLatestRef(options);
  const session = useRef<Session | null>(null);
  const suppressClick = useRef(false);

  const api = useMemo(() => {
    const runtime: Runtime = { options: latest, session, suppressClick, setRect };
    const handlers: MarqueeHandlers = {
      onPointerDown: (event) => begin(runtime, event),
      onPointerMove: (event) => move(runtime, event),
      onPointerUp: (event) => finish(runtime, event.pointerId),
      onPointerCancel: (event) => finish(runtime, event.pointerId),
    };
    const consumeDragClick = (): boolean => {
      const was = suppressClick.current;
      suppressClick.current = false;
      return was;
    };
    return { handlers, consumeDragClick };
  }, [latest]);

  useEffect(
    () => () => {
      const frame = session.current?.frame;
      if (typeof frame === 'number') cancelAnimationFrame(frame);
      session.current = null;
    },
    []
  );

  return { rect, handlers: api.handlers, consumeDragClick: api.consumeDragClick };
}
