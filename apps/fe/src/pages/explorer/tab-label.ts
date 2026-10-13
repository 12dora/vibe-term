// 标签页文字的纯推导：标题取当前路径的末段，位于目录根时取根的展示名。

export interface TabRootInfo {
  path: string;
  name: string;
}

/** 去掉末尾多余的斜杠（根 '/' 保持原样） */
function trimTrailingSlash(path: string): string {
  if (path.length <= 1) return path;
  return path.endsWith('/') ? path.replace(/\/+$/, '') || '/' : path;
}

/** 路径末段；根目录返回 '/' */
export function pathBasename(path: string): string {
  const trimmed = trimTrailingSlash(path);
  const index = trimmed.lastIndexOf('/');
  const base = index < 0 ? trimmed : trimmed.slice(index + 1);
  return base.length > 0 ? base : '/';
}

/** 标签页标题：停在目录根上时用根的展示名（未知则退回路径末段） */
export function tabLabel(path: string, root: TabRootInfo | null | undefined): string {
  if (root && trimTrailingSlash(root.path) === trimTrailingSlash(path)) {
    return root.name.length > 0 ? root.name : pathBasename(path);
  }
  return pathBasename(path);
}

/** 悬停提示：`节点名 · 路径`；节点名未知时只有路径 */
export function tabTitle(nodeName: string | undefined, path: string): string {
  return nodeName ? `${nodeName} · ${path}` : path;
}

/** 工作区里是否有来自多个节点的标签页（决定要不要显示节点名前缀） */
export function hasMultipleNodes(tabs: Iterable<{ nodeId: string }>): boolean {
  let first: string | null = null;
  for (const tab of tabs) {
    if (first === null) first = tab.nodeId;
    else if (tab.nodeId !== first) return true;
  }
  return false;
}
