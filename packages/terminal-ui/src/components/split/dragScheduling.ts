// 分屏拖拽的时序与量测缓存。与侧栏 resizer（packages/ui/src/components/sidebar/resize-controller.ts）
// 同形：指针事件率（触控板 ~120 Hz）远高于帧率，状态更新按 rAF 合并，提交只发生在 pointerup。
//
// 拆成不依赖 React / DOM 的小模块，是为了让「一帧只更新一次」「候选 rect 一次拖拽只量一次」
// 这两条契约能被单元测试盯住（仓库测试环境无 DOM）。

import type { SidebarDropCandidates } from './dragHitTesting';

export interface DragFrames {
  /** 返回 null 表示当前环境没有 rAF，调度器退回同步应用 */
  requestFrame: (callback: () => void) => unknown | null;
  cancelFrame: (handle: unknown) => void;
}

export const domDragFrames: DragFrames = {
  requestFrame: (callback) =>
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : null,
  cancelFrame: (handle) => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle as number);
  },
};

export interface DragFrameScheduler {
  /** 同一帧内多次 schedule 只保留最后一次 */
  schedule: (apply: () => void) => void;
  /** 丢弃未应用的帧；拖拽收尾必须调用，否则残留帧会覆盖掉刚清空的状态 */
  cancel: () => void;
}

export function createDragFrameScheduler(frames: DragFrames = domDragFrames): DragFrameScheduler {
  let handle: unknown = null;
  let pending: (() => void) | null = null;

  const flush = (): void => {
    handle = null;
    const apply = pending;
    pending = null;
    apply?.();
  };

  return {
    schedule: (apply) => {
      pending = apply;
      if (handle !== null) return;
      const next = frames.requestFrame(flush);
      if (next === null) {
        flush();
        return;
      }
      handle = next;
    },
    cancel: () => {
      if (handle !== null) frames.cancelFrame(handle);
      handle = null;
      pending = null;
    },
  };
}

export interface DragMeasurement<T> {
  /** 首次读时量测，之后复用直到 invalidate */
  read: () => T;
  invalidate: () => void;
}

export function createDragMeasurement<T>(measure: () => T): DragMeasurement<T> {
  let value: T | null = null;
  return {
    read: () => {
      if (value === null) value = measure();
      return value;
    },
    invalidate: () => {
      value = null;
    },
  };
}

export function toRectLike(rect: DOMRect): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

// 侧栏落点候选：窗口行 + 侧栏容器（按 DOM 顺序），判定交给纯函数。
// 全文档 querySelectorAll + 每行一次 getBoundingClientRect，只在 pointerdown 量一次。
export function collectSidebarCandidates(): SidebarDropCandidates {
  const windows = Array.from(document.querySelectorAll('[data-testid^="window-item-"]')).map(
    (row) => ({
      windowId: (row.getAttribute('data-testid') ?? '').replace('window-item-', ''),
      rect: toRectLike(row.getBoundingClientRect()),
    })
  );
  const sidebars = Array.from(document.querySelectorAll('[data-slot="sidebar"]')).map((sidebar) =>
    toRectLike(sidebar.getBoundingClientRect())
  );
  return { windows, sidebars };
}
