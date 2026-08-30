// pane 根元素的捕获阶段选择处理要放过关闭控件。
//
// 关闭按钮的 `stopPropagation()` 在冒泡阶段，拦不住祖先的 `onPointerDownCapture`：不放过它，
// 点非焦点 pane 的关闭按钮会先把路由导航到这个即将被关掉的 pane，URL 随即指向一个已删除的
// pane（中心只剩「连接设备中」遮罩）。

export const PANE_CLOSE_ATTR = 'data-pane-close';

const PANE_CLOSE_SELECTOR = `[${PANE_CLOSE_ATTR}]`;

interface ClosestTarget {
  closest(selector: string): unknown;
}

/** 事件是否发自关闭控件（含它内部的图标等子节点）。 */
export function isPaneCloseTarget(target: unknown): boolean {
  if (!target || typeof (target as ClosestTarget).closest !== 'function') return false;
  return (target as ClosestTarget).closest(PANE_CLOSE_SELECTOR) != null;
}
