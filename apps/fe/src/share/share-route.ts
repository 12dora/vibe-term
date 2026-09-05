// 被分享页的路由形状：`/s/:shareId` 与 `/n/:nodeId/s/:shareId`。
// 页面挂在 RootLayout 之外，所以「当前 tab」不再是路由段，而是分享页自己的查询参数
// （`?w=<windowId>&p=<paneId>`）——控制台仍照常经 HostServices.appPath 改写地址，
// 只是被映射回同一个分享页，不会把访客带去 /devices/…。

import { NODE_ID_PATTERN, nodePathPrefix } from '@tmex/api-client';

export const SHARE_ROUTE_PATH = '/s/:shareId';
export const NODE_SHARE_ROUTE_PATH = '/n/:nodeId/s/:shareId';

/** 分享页地址（不含查询串）；nodeId 为空或 `self` 时无前缀。 */
export function sharePagePath(nodeId: string | null | undefined, shareId: string): string {
  return `${nodePathPrefix(nodeId)}/s/${encodeURIComponent(shareId)}`;
}

const SHARE_PATHNAME = new RegExp(`^(?:/n/${NODE_ID_PATTERN.source.slice(1, -1)})?/s/[^/]+/?$`);

/** 当前地址是否为分享页：401 拦截器据此放弃「踢去登录页」这一跳。 */
export function isSharePathname(pathname: string): boolean {
  return SHARE_PATHNAME.test(pathname);
}

export interface ShareConsoleTarget {
  windowId?: string;
  paneId?: string;
}

const PANE_ROUTE = /^\/devices\/[^/]+\/windows\/([^/]+)\/panes\/(.+)$/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 从包内构造的 `/devices/<d>/windows/<w>/panes/<p>` 里取出 window / pane（均已解码）。 */
export function parsePaneAppPath(path: string): ShareConsoleTarget | null {
  const match = PANE_ROUTE.exec(path.split(/[?#]/)[0]);
  if (!match) return null;
  return { windowId: safeDecode(match[1]), paneId: safeDecode(match[2]) };
}

/** 分享页的查询串：`?w=&p=`，两者都缺时为空串。 */
export function shareConsoleQuery(target: ShareConsoleTarget): string {
  const params = new URLSearchParams();
  if (target.windowId) params.set('w', target.windowId);
  if (target.paneId) params.set('p', target.paneId);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * 分享页的 `HostServices.appPath`：pane 路径映射成本页的查询串，其余一律回到分享页本身。
 * 控制台里的每一次导航都因此留在 `/s/<id>`，访客拿不到任何设备/节点地址。
 *
 * 注意这**不是**纯前缀变换，因此不能拿去当 `matchPath` 的 pattern 用。分享页只挂
 * `DeviceConsole` 与它的操作区，两者都只用 appPath 做导航（`useNavigate`），不做路由匹配；
 * 用 matchPath 的那几处（agent tab、文件面板、设备树）在分享页一个都不渲染。
 */
export function createShareAppPath(base: string): (path: string) => string {
  return (path: string) => {
    const target = parsePaneAppPath(path);
    return target ? `${base}${shareConsoleQuery(target)}` : base;
  };
}
