// 容器级事件委托：从事件目标找回是哪一行。只依赖 `closest` + `getAttribute`，
// 无 DOM 环境下可用替身单测（做法同 files/file-leaf-delegates.ts）。

export const ROW_PATH_ATTR = 'data-explorer-path';
/** 目录行才带：可作为放置目标 */
export const ROW_DIR_ATTR = 'data-explorer-dir';
/** 表头、新建文件夹占位行：点击既不算命中条目，也不算点了空白 */
export const INERT_ATTR = 'data-explorer-inert';
/** 触屏复选框的包裹层：点击只切换勾选，不触发打开 */
export const CHECK_ATTR = 'data-explorer-check';

export const ROW_SELECTOR = `[${ROW_PATH_ATTR}]`;

interface AttrElement {
  closest(selector: string): AttrElement | null;
  getAttribute(name: string): string | null;
}

function asAttrElement(target: unknown): AttrElement | null {
  const candidate = target as AttrElement | null;
  return candidate !== null &&
    typeof candidate === 'object' &&
    typeof candidate.closest === 'function'
    ? candidate
    : null;
}

function closestOf(target: unknown, selector: string): AttrElement | null {
  return asAttrElement(target)?.closest(selector) ?? null;
}

/** 事件目标所在行的路径；不在任何行内返回 null。 */
export function rowPathOf(target: unknown): string | null {
  return closestOf(target, ROW_SELECTOR)?.getAttribute(ROW_PATH_ATTR) ?? null;
}

/** 事件目标所在的目录行路径；落在文件行或空白处都返回 null（即「放到当前目录」）。 */
export function dropPathOf(target: unknown): string | null {
  const row = closestOf(target, ROW_SELECTOR);
  if (!row || row.getAttribute(ROW_DIR_ATTR) === null) return null;
  return row.getAttribute(ROW_PATH_ATTR);
}

export function isInertTarget(target: unknown): boolean {
  return closestOf(target, `[${INERT_ATTR}]`) !== null;
}

export function isCheckTarget(target: unknown): boolean {
  return closestOf(target, `[${CHECK_ATTR}]`) !== null;
}

/** 落在可拖拽元素上的按下交给原生拖拽，不起框选。 */
export function isDraggableTarget(target: unknown): boolean {
  return closestOf(target, '[draggable="true"]') !== null;
}

function escapeAttrValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

export function findRow(container: ParentNode, path: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[${ROW_PATH_ATTR}="${escapeAttrValue(path)}"]`);
}
