// 浏览器根元素之下的少量命令式 DOM 操作：聚焦视图容器、滚动、焦点是否还在本浏览器里。

import { findRow } from './views';

export const VIEW_SELECTOR = '[data-testid="explorer-view"]';

export function viewElement(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>(VIEW_SELECTOR) ?? null;
}

/** 聚焦视图容器；视图不在（加载中 / 空目录 / 出错）时退到浏览器根元素，快捷键照常可用。 */
export function focusView(root: HTMLElement | null): void {
  (viewElement(root) ?? root)?.focus({ preventScroll: true });
}

export function scrollViewToTop(root: HTMLElement | null): void {
  const view = viewElement(root);
  if (view) view.scrollTop = 0;
}

export function findViewRow(root: HTMLElement | null, path: string): HTMLElement | null {
  const view = viewElement(root);
  return view ? findRow(view, path) : null;
}

export function revealRow(root: HTMLElement | null, path: string): void {
  findViewRow(root, path)?.scrollIntoView({ block: 'nearest' });
}

function activeElement(): Element | null {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  return active && active !== document.body ? active : null;
}

/** 焦点已经丢了（落在 body 上）：可以放心拿回来，不会打断别处的输入。 */
export function isFocusLost(): boolean {
  return activeElement() === null;
}

export function isFocusInside(root: HTMLElement | null): boolean {
  const active = activeElement();
  return active !== null && root !== null && root.contains(active);
}

function isEditable(element: Element): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (element as HTMLElement).isContentEditable === true;
}

/**
 * 导航之后要不要把焦点挪到视图上：焦点丢了，或者还停在本浏览器的非输入控件上（如「后退」按钮）
 * 时挪；用户正在别处或在输入框里则不动。
 */
export function shouldRefocusAfterNavigation(root: HTMLElement | null): boolean {
  const active = activeElement();
  if (active === null) return true;
  if (root === null || !root.contains(active)) return false;
  return !isEditable(active) && !viewElement(root)?.contains(active);
}
