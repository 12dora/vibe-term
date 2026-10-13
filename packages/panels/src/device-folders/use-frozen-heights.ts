// 拖拽期间冻结容器高度。
//
// 指针拖拽的预览是真实回流：被拖节点换个位置，网格可能少一行，容器随之变矮——如果指针正好
// 停在消失的那一行上，它就掉出了容器（落到外层容器，甚至整棵树之外 = 取消），预览撤销后
// 容器又长回来，指针又回到容器里……如此往复。所以拖拽开始时把整棵树和每张节点网格当前的
// 高度记成 `min-height`：回流可以让容器变高，但不会把它从指针底下抽走。拖拽（含松手后等
// 布局落定的那一段）结束时撤掉。
// 拖拽途中才挂载的网格（自动展开的分组）在下一次渲染时按它当时的高度补冻。

import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

/** 标在需要冻结高度的元素上（整棵树的根、每张节点网格） */
export const FREEZE_HEIGHT_ATTR = 'data-freeze-height';

interface Freezable {
  offsetHeight: number;
  style: { minHeight: string };
}

/**
 * 把还没冻结的元素冻住：`held` 记下每个元素原来的内联 `min-height`（撤销时还原），已经在
 * `held` 里的不重复量——冻结值是它第一次被看到时的高度，不随后续回流变化。
 */
export function freezeHeights<T extends Freezable>(targets: Iterable<T>, held: Map<T, string>) {
  for (const target of targets) {
    if (held.has(target)) continue;
    held.set(target, target.style.minHeight);
    target.style.minHeight = `${target.offsetHeight}px`;
  }
}

/** 撤销全部冻结，还原原来的内联 `min-height` */
export function releaseHeights<T extends Freezable>(held: Map<T, string>): void {
  for (const [target, previous] of held) target.style.minHeight = previous;
  held.clear();
}

function freezeTargets(root: HTMLElement): HTMLElement[] {
  const inside = Array.from(root.querySelectorAll<HTMLElement>(`[${FREEZE_HEIGHT_ATTR}]`));
  return root.hasAttribute(FREEZE_HEIGHT_ATTR) ? [root, ...inside] : inside;
}

// 无 DOM（SSR / bun test）时降级成 useEffect，避免 React 的 useLayoutEffect 警告
const useCommitEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

export function useFrozenHeights(rootRef: RefObject<HTMLElement | null>, frozen: boolean): void {
  const heldRef = useRef(new Map<HTMLElement, string>());
  // 不带依赖：冻结期间每次渲染都扫一遍，把新挂载的网格补上（已冻结的直接跳过）。
  // 必须是提交阶段的同步 effect：要赶在第一次回流的那一帧画出来之前把高度钉住
  useCommitEffect(() => {
    const root = rootRef.current;
    if (!frozen || !root) {
      releaseHeights(heldRef.current);
      return;
    }
    freezeHeights(freezeTargets(root), heldRef.current);
  });
  useEffect(() => {
    const held = heldRef.current;
    return () => releaseHeights(held);
  }, []);
}
