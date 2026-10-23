// 主区（路由页）与「文件」视图的关系：哪些路径算文件视图、离开文件视图前停在哪。
// 入口 chunk 会用到本文件（侧栏切 tab、路由记忆），只依赖路由常量，不引入文件管理器工作区。
import { EXPLORER_ROUTE } from './explorer-route';

/** 未记录过任何主区路由（如冷启动直接落在文件管理器）时「收起」回到的地方。 */
export const MAIN_ROUTE_FALLBACK = '/';

// 文件预览：/file/<ref>，多 node 下带 /n/<nodeId> 前缀。
const FILE_PREVIEW_RE = /^(?:\/n\/[^/]+)?\/file\/[^/]+/;

export function isExplorerPath(pathname: string): boolean {
  return pathname === EXPLORER_ROUTE;
}

export function isFilePreviewPath(pathname: string): boolean {
  return FILE_PREVIEW_RE.test(pathname);
}

/** 主区已在展示文件管理器或某个文件预览：这两者同属「文件」视图。 */
export function isFileViewPath(pathname: string): boolean {
  return isExplorerPath(pathname) || isFilePreviewPath(pathname);
}

/** 用户切到侧栏「文件」tab 时，是否要把主区带去文件管理器（已在文件视图则保持原样）。 */
export function shouldShowExplorerOnTabChange(tab: string, pathname: string): boolean {
  return tab === 'files' && !isFileViewPath(pathname);
}

export interface RouteLocation {
  pathname: string;
  search?: string;
  hash?: string;
}

let lastMainRoute = MAIN_ROUTE_FALLBACK;

/**
 * 记下用户最近一次停留的非文件视图位置；文件视图不覆盖它。
 * 记完整位置（search / hash 一并带上）：设置页的 `?tab=`、侧边面板的 `?panel=` 都是真实状态；
 * 是否文件视图只看 pathname。
 */
export function rememberMainRoute(location: RouteLocation): void {
  if (isFileViewPath(location.pathname)) return;
  lastMainRoute = `${location.pathname}${location.search ?? ''}${location.hash ?? ''}`;
}

/** 收起文件管理器时回到的位置（pathname + search + hash）。 */
export function getLastMainRoute(): string {
  return lastMainRoute;
}

export function resetMainRouteForTest(): void {
  lastMainRoute = MAIN_ROUTE_FALLBACK;
}
