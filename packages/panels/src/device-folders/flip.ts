// 网格回流的 FLIP 过渡：条目换了位置（视觉顺序变了）时不是瞬间跳过去，而是从原来的位置滑到
// 新位置。
//
// 做法是标准的 First-Last-Invert-Play：顺序变化提交之后量每个条目的新位置，与上一次记下的
// 位置求差，用 Web Animations 从「差值位移」播到「无位移」。用 WAAPI 而不是改内联 style：
// 条目的内联 `transform` 归 dnd-kit 的 sortable 管，两边互不踩。位置一律记成**相对网格容器**
// 的坐标，页面滚动 / 上方别的分组变高都不会被误当成条目移动。
// 动画没播完又来一次回流：先读出在飞的位移再取消旧动画，新动画从当前看到的位置接着走。

import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

export interface FlipPoint {
  x: number;
  y: number;
}

/** 位移小于这个值（px）就不播：亚像素抖动不值得起一个动画 */
const FLIP_MIN_DELTA = 0.5;
const FLIP_FALLBACK_MS = 200;
const FLIP_FALLBACK_EASING = 'ease-out';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const NO_OFFSET: FlipPoint = { x: 0, y: 0 };

/**
 * 条目该从哪儿滑回来：上一次的位置（加上还在飞的位移 = 用户此刻看到的位置）减去新位置。
 * 没有上一次的位置（新出现的条目）或几乎没动返回 null。
 */
export function flipDelta(
  prev: FlipPoint | undefined,
  next: FlipPoint,
  inflight: FlipPoint = NO_OFFSET
): FlipPoint | null {
  if (!prev) return null;
  const x = prev.x + inflight.x - next.x;
  const y = prev.y + inflight.y - next.y;
  if (Math.abs(x) < FLIP_MIN_DELTA && Math.abs(y) < FLIP_MIN_DELTA) return null;
  return { x, y };
}

/** CSS 时长（`200ms` / `0.2s`）→ 毫秒；读不出来用 fallback */
export function parseCssTimeMs(value: string, fallback: number): number {
  const match = /^(-?\d*\.?\d+)(ms|s)$/.exec(value.trim());
  if (!match) return fallback;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return fallback;
  return match[2] === 's' ? amount * 1000 : amount;
}

const running = new WeakMap<HTMLElement, Animation>();

function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

interface FlipTiming {
  duration: number;
  easing: string;
}

function flipTiming(container: HTMLElement): FlipTiming {
  const style = window.getComputedStyle(container);
  return {
    duration: parseCssTimeMs(style.getPropertyValue('--vibeterm-motion-layout'), FLIP_FALLBACK_MS),
    easing: style.getPropertyValue('--vibeterm-ease-out').trim() || FLIP_FALLBACK_EASING,
  };
}

function play(element: HTMLElement, delta: FlipPoint, timing: FlipTiming): void {
  if (typeof element.animate !== 'function') return;
  const frames = [
    { transform: `translate(${delta.x}px, ${delta.y}px)` },
    { transform: 'translate(0px, 0px)' },
  ];
  let animation: Animation;
  try {
    animation = element.animate(frames, { ...timing });
  } catch {
    // 主题给的缓动串浏览器不认：退回内置的，动画照播
    animation = element.animate(frames, { ...timing, easing: FLIP_FALLBACK_EASING });
  }
  running.set(element, animation);
}

function flipItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && Boolean(child.dataset.flipId)
  );
}

/** 量新位置、对上一次的位置播过渡，返回这一次的位置表 */
function reflow(container: HTMLElement, prev: ReadonlyMap<string, FlipPoint> | null) {
  const items = flipItems(container);
  // 先统一读「此刻看到的位置」，再统一取消旧动画，最后统一读落定的位置：读写不交错
  const seen = items.map((item) => item.getBoundingClientRect());
  for (const item of items) running.get(item)?.cancel();
  const origin = container.getBoundingClientRect();
  const next = new Map<string, FlipPoint>();
  const moves: [HTMLElement, FlipPoint][] = [];
  items.forEach((item, index) => {
    const id = item.dataset.flipId ?? '';
    const settled = item.getBoundingClientRect();
    const before = seen[index] ?? settled;
    const point = { x: settled.left - origin.left, y: settled.top - origin.top };
    next.set(id, point);
    const delta = flipDelta(prev?.get(id), point, {
      x: before.left - settled.left,
      y: before.top - settled.top,
    });
    if (delta) moves.push([item, delta]);
  });
  if (moves.length > 0 && !prefersReducedMotion()) {
    const timing = flipTiming(container);
    for (const [item, delta] of moves) play(item, delta, timing);
  }
  return next;
}

// 无 DOM（SSR / bun test）时降级成 useEffect，避免 React 的 useLayoutEffect 警告
const useCommitEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/**
 * 给 `containerRef` 的直接子元素（带 `data-flip-id` 的那些）加回流过渡。
 * `orderKey` 是当前视觉顺序的签名，变了才量；`tracking` 为真期间（拖拽中 / 落下后等布局落定）
 * 持续记位置，转为假的那一次仍会把条目送回最终位置（取消拖拽时滑回原位），之后清掉记录——
 * 平时的重排（新增 / 删除节点、窗口变宽）没有可靠的「上一次位置」，不播。
 */
export function useFlipReflow(
  containerRef: RefObject<HTMLElement | null>,
  orderKey: string,
  tracking: boolean
): void {
  const prevRef = useRef<Map<string, FlipPoint> | null>(null);
  // `orderKey` 只是触发信号（视觉顺序变了才重新量），回调本体不读它
  useCommitEffect(() => {
    const container = containerRef.current;
    if (!container || (!tracking && !prevRef.current)) return;
    const next = reflow(container, prevRef.current);
    prevRef.current = tracking ? next : null;
  }, [containerRef, orderKey, tracking]);
}
