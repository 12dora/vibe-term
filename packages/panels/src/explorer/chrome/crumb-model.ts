// 面包屑与地址栏的纯逻辑：路径拆分、溢出折叠、手输路径解析。

export interface ExplorerCrumb {
  label: string;
  path: string;
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

export interface CrumbFitMetrics {
  /** 两级之间分隔符的宽度 */
  separator: number;
  /** 「…」折叠按钮的宽度 */
  overflow: number;
  /** 根这一级被压缩时至少保留的宽度 */
  minRoot: number;
  /** 当前目录被压缩时至少保留的宽度 */
  minLast: number;
}

export const DEFAULT_CRUMB_METRICS: CrumbFitMetrics = {
  separator: 12,
  overflow: 26,
  minRoot: 44,
  minLast: 56,
};

export interface CrumbFit {
  /** 根这一级是否仍在面包屑里（false 时它进了「…」菜单，`hidden` 含 0） */
  rootVisible: boolean;
  /** 收进「…」菜单的下标，升序 */
  hidden: number[];
  /** 根被压缩后的最大宽度；null 表示按自然宽度 */
  rootMaxWidth: number | null;
  /** 当前目录被压缩后的最大宽度；null 表示按自然宽度 */
  lastMaxWidth: number | null;
}

function trailWidth(parts: readonly number[], separator: number): number {
  const total = parts.reduce((sum, width) => sum + width, 0);
  return total + separator * Math.max(0, parts.length - 1);
}

function indexRange(from: number, count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, offset) => from + offset);
}

/** 根保持自然宽度时，最少要把几个中间级收进「…」才放得下；全收了仍放不下返回 null。 */
function fewestHiddenMiddle(
  widths: readonly number[],
  available: number,
  metrics: CrumbFitMetrics
): number | null {
  const middle = widths.length - 2;
  for (let hiddenCount = 0; hiddenCount <= middle; hiddenCount += 1) {
    const marker = hiddenCount > 0 ? [metrics.overflow] : [];
    const parts = [widths[0] ?? 0, ...marker, ...widths.slice(1 + hiddenCount)];
    if (trailWidth(parts, metrics.separator) <= available) return hiddenCount;
  }
  return null;
}

/**
 * 按量得的自然宽度决定面包屑怎么摆，当前目录（最后一级）优先级最高：
 * 1. 先从靠根的一侧把中间级收进「…」；
 * 2. 仍放不下就压缩根（不小于 `minRoot`）；
 * 3. 再放不下，根也进「…」；此时当前目录独占剩余宽度，只有它自己都放不下才截断。
 * `widths[0]` 是根，末位是当前目录；没有可用宽度（尚未量到）时全部按自然宽度显示。
 */
export function fitCrumbs(
  widths: readonly number[],
  available: number,
  metrics: CrumbFitMetrics = DEFAULT_CRUMB_METRICS
): CrumbFit {
  const count = widths.length;
  const natural: CrumbFit = {
    rootVisible: count > 0,
    hidden: [],
    rootMaxWidth: null,
    lastMaxWidth: null,
  };
  if (count === 0 || !(available > 0)) return natural;
  const { separator, overflow, minRoot, minLast } = metrics;
  const root = widths[0] ?? 0;
  const last = widths[count - 1] ?? 0;
  if (count === 1) {
    return root <= available ? natural : { ...natural, lastMaxWidth: Math.max(minLast, available) };
  }

  const middle = count - 2;
  const fitting = fewestHiddenMiddle(widths, available, metrics);
  if (fitting !== null) return { ...natural, hidden: indexRange(1, fitting) };

  const middleHidden = indexRange(1, middle);
  const afterRoot = trailWidth(middle > 0 ? [overflow, last] : [last], separator) + separator;
  const rootRoom = available - afterRoot;
  if (rootRoom >= Math.min(root, minRoot)) {
    return { rootVisible: true, hidden: middleHidden, rootMaxWidth: rootRoom, lastMaxWidth: null };
  }

  const lastRoom = available - overflow - separator;
  return {
    rootVisible: false,
    hidden: [0, ...middleHidden],
    rootMaxWidth: null,
    lastMaxWidth: last <= lastRoom ? null : Math.max(minLast, lastRoom),
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
