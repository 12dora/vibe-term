import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

const PIN_THRESHOLD_PX = 48;
/** 默认只渲染最近这么多块，点「显示更早」再按此步长展开 */
const WINDOW_STEP = 200;

/**
 * 渲染窗口的起点：吸底时跟着最新的 windowSize 条走；
 * 用户上滚（frozenStart 非空）后起点冻结，新块只往下追加，正在读的块不会被顶掉。
 */
export function windowStartIndex(
  total: number,
  windowSize: number,
  frozenStart: number | null
): number {
  if (frozenStart !== null) return Math.min(frozenStart, Math.max(0, total - 1));
  return Math.max(0, total - windowSize);
}

export function isPinnedToBottom(el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
}

interface ScrollBox {
  scrollHeight: number;
  scrollTop: number;
}

/** 吸底：内容长高多少就往下补多少。 */
export function stickToBottom(el: ScrollBox): void {
  el.scrollTop = el.scrollHeight;
}

/** 「距底距离」锚点：展开更早的消息会让 scrollHeight 变大，靠它把视口钉回原来那一段。 */
export function bottomAnchor(el: ScrollBox): number {
  return el.scrollHeight - el.scrollTop;
}

export function restoreBottomAnchor(el: ScrollBox, anchor: number): void {
  el.scrollTop = el.scrollHeight - anchor;
}

export interface FrameHost {
  requestAnimationFrame: (callback: () => void) => number;
  cancelAnimationFrame: (handle: number) => void;
}

const DEFAULT_FRAME_HOST: FrameHost = {
  requestAnimationFrame: (callback) => requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
};

/**
 * 滚动事件合帧：一帧内来多少次 scroll 都只测量一次。
 * 惯性滚动一帧能打十几个事件，每个都同步读 scrollHeight/scrollTop/clientHeight
 * 就是十几次强制布局。
 */
export interface ScrollCoalescer {
  onScroll: () => void;
  /** 立刻结算还压在这一帧里的那次测量（吸底前必须先知道用户是不是刚上滚）。 */
  flush: () => void;
  dispose: () => void;
}

export function createScrollCoalescer(
  measure: () => void,
  host: FrameHost = DEFAULT_FRAME_HOST
): ScrollCoalescer {
  let frame: number | null = null;
  const cancel = (): boolean => {
    if (frame === null) return false;
    host.cancelAnimationFrame(frame);
    frame = null;
    return true;
  };
  return {
    onScroll: () => {
      if (frame !== null) return;
      frame = host.requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    },
    flush: () => {
      if (cancel()) measure();
    },
    dispose: () => void cancel(),
  };
}

export interface ChatScroll {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 窗口起点：前面这么多块没渲染，>0 时显示「显示更早」 */
  hidden: number;
  showJumpToBottom: boolean;
  onScroll: () => void;
  scrollToBottom: () => void;
  showEarlier: () => void;
}

/** 吸底 / 上滚冻结 / 窗口展开三件事共用一套 ref 与测量，整体作为一个 hook 挂在滚动容器上。 */
export function useChatScroll(blocks: readonly unknown[], running: boolean): ChatScroll {
  const total = blocks.length;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  const anchorRef = useRef<number | null>(null);
  const coalescerRef = useRef<ScrollCoalescer | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [windowSize, setWindowSize] = useState(WINDOW_STEP);
  const [frozenStart, setFrozenStart] = useState<number | null>(null);

  const scrollToBottom = useCallback((): void => {
    const el = containerRef.current;
    if (!el) return;
    stickToBottom(el);
    pinnedRef.current = true;
    setShowJumpToBottom(false);
    setFrozenStart(null);
  }, []);

  // 吸底：用户未上滚时新内容自动滚到底，多次 flush 合并成一帧一次读写，避免每次提交都强制布局
  // biome-ignore lint/correctness/useExhaustiveDependencies: blocks/running 变化即触发吸底
  useEffect(() => {
    if (!pinnedRef.current) {
      setShowJumpToBottom(true);
      return;
    }
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      // 同一帧里用户刚上滚过的话，先把那次测量结算掉，别把人拽回底部。
      coalescerRef.current?.flush();
      const el = containerRef.current;
      if (el && pinnedRef.current) stickToBottom(el);
    });
  }, [blocks, running]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    []
  );

  // 展开更早的消息后按「距底距离」锚点回写 scrollTop，视口内容不跳
  // biome-ignore lint/correctness/useExhaustiveDependencies: windowSize 变化即是回写时机
  useLayoutEffect(() => {
    const el = containerRef.current;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (el && anchor !== null) restoreBottomAnchor(el, anchor);
  }, [windowSize, frozenStart]);

  // 测量函数每次渲染都换一份（要读到最新的 blocks/windowSize），
  // 但合帧器只建一次，用 ref 中转。
  const measureRef = useRef<() => void>(() => undefined);
  measureRef.current = () => {
    const el = containerRef.current;
    if (!el) return;
    const pinned = isPinnedToBottom(el);
    pinnedRef.current = pinned;
    setShowJumpToBottom(!pinned);
    setFrozenStart((prev) => (pinned ? null : (prev ?? windowStartIndex(total, windowSize, null))));
  };
  const scrollCoalescer = useMemo(() => createScrollCoalescer(() => measureRef.current()), []);
  coalescerRef.current = scrollCoalescer;
  useEffect(() => scrollCoalescer.dispose, [scrollCoalescer]);

  const showEarlier = (): void => {
    const el = containerRef.current;
    anchorRef.current = el ? bottomAnchor(el) : null;
    if (frozenStart !== null) setFrozenStart(Math.max(0, frozenStart - WINDOW_STEP));
    else setWindowSize((size) => size + WINDOW_STEP);
  };

  return {
    containerRef,
    hidden: windowStartIndex(total, windowSize, frozenStart),
    showJumpToBottom,
    onScroll: scrollCoalescer.onScroll,
    scrollToBottom,
    showEarlier,
  };
}
