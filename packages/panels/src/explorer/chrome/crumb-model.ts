// 面包屑与地址栏的纯逻辑：路径拆分、溢出折叠、手输路径解析。

export interface ExplorerCrumb {
  label: string;
  path: string;
}

export interface CollapsedCrumbs {
  head: ExplorerCrumb[];
  hidden: ExplorerCrumb[];
  tail: ExplorerCrumb[];
}

function stripTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function isInsideRoot(path: string, rootPath: string): boolean {
  if (rootPath === '/') return path.startsWith('/');
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

/** 根目录 + 根以下每一级；`path` 不在根内时只剩根这一级。 */
export function explorerCrumbs(rootPath: string, rootName: string, path: string): ExplorerCrumb[] {
  const root = stripTrailingSlash(rootPath);
  const current = stripTrailingSlash(path);
  const crumbs: ExplorerCrumb[] = [{ label: rootName, path: root }];
  if (!isInsideRoot(current, root)) return crumbs;
  let acc = root === '/' ? '' : root;
  for (const segment of current.slice(acc.length).split('/').filter(Boolean)) {
    acc += `/${segment}`;
    crumbs.push({ label: segment, path: acc });
  }
  return crumbs;
}

/**
 * 最多保留 `maxVisible` 级：根始终在 `head`，其余名额给末尾，中间的进 `hidden`。
 * 根与当前目录永远可见，所以 `maxVisible` 小于 2 时按 2 处理。
 */
export function collapseCrumbs(
  crumbs: readonly ExplorerCrumb[],
  maxVisible: number
): CollapsedCrumbs {
  const limit = Math.max(2, Math.floor(maxVisible));
  if (crumbs.length <= limit) return { head: [...crumbs], hidden: [], tail: [] };
  const tailStart = crumbs.length - (limit - 1);
  return {
    head: crumbs.slice(0, 1),
    hidden: crumbs.slice(1, tailStart),
    tail: crumbs.slice(tailStart),
  };
}

function normalizeAbsolute(path: string): string {
  const stack: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }
  return `/${stack.join('/')}`;
}

/**
 * 地址栏输入 → 规范化绝对路径。绝对路径原样解析，相对路径相对当前目录；
 * 空输入或落到根目录之外返回 null。
 */
export function resolveTypedPath(
  input: string,
  rootPath: string,
  currentPath: string
): string | null {
  const typed = input.trim();
  if (typed === '' || typed.includes('\0')) return null;
  const root = normalizeAbsolute(rootPath);
  const absolute = typed.startsWith('/') ? typed : `${currentPath}/${typed}`;
  const resolved = normalizeAbsolute(absolute);
  return isInsideRoot(resolved, root) ? resolved : null;
}
