// Service Worker 的请求分类：纯函数，不碰任何 SW 全局，便于单测。
// 分类结果决定 sw.ts 用哪种缓存策略；'bypass' 表示连 respondWith 都不调用，
// 请求原封不动交回浏览器（对 WS 升级、流式 API、Range 请求是硬要求）。

export type SwRouteKind = 'shell' | 'asset' | 'font' | 'icon' | 'bypass';

export interface SwRequestInfo {
  url: string;
  method: string;
  /** Request.mode，导航请求为 'navigate' */
  mode: string;
  /** 请求是否带 Range 头（分片请求必须直通，缓存回放会破坏 206 语义） */
  hasRange: boolean;
  /** SW 自身所在源，取 self.location.origin */
  scopeOrigin: string;
}

/**
 * 一律不拦截的同源路径前缀：网关 API、WS 升级、mesh 事件流、健康检查，
 * 以及 SW 脚本自身（更新检查必须走网络）。前缀匹配刻意从宽，宁可漏缓存不可错拦。
 */
export const BYPASS_PREFIXES: readonly string[] = ['/api/', '/ws', '/mesh/', '/healthz', '/sw.js'];

/**
 * `/n/<id>/` 下只有转发给该 node 的传输层要直通；其余 `/n/<id>/devices` 之类是本应用的路由，
 * 导航时同样该拿本地应用壳——整段 `/n/` 直通会让多节点用户的每次冷启动都退回纯网络。
 */
export const NODE_BYPASS_SEGMENTS: readonly string[] = ['ws', 'api', 'mesh'];

const NODE_PREFIX = '/n/';

/** `/n/<id>/<segment>` 或 `/n/<id>/<segment>/...` 命中传输层前缀 */
export function isNodeBypassPath(pathname: string): boolean {
  if (!pathname.startsWith(NODE_PREFIX)) return false;
  const rest = pathname.slice(NODE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return false;
  const sub = rest.slice(slash + 1);
  return NODE_BYPASS_SEGMENTS.some((name) => sub === name || sub.startsWith(`${name}/`));
}

/** 预缓存的应用图标（PWA 图标与 apple-touch-icon） */
export const PRECACHED_ICONS: readonly string[] = [
  '/vibeterm.png',
  '/vibeterm-maskable.png',
  '/logo.png',
];

/** 应用壳在缓存里的键；导航请求一律回放它 */
export const SHELL_URL = '/index.html';

function parsePathname(url: string, scopeOrigin: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === scopeOrigin ? parsed.pathname : null;
  } catch {
    return null;
  }
}

export function isBypassPath(pathname: string): boolean {
  return BYPASS_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

export function classifyRequest(info: SwRequestInfo): SwRouteKind {
  if (info.method !== 'GET') return 'bypass';
  if (info.hasRange) return 'bypass';
  const pathname = parsePathname(info.url, info.scopeOrigin);
  if (pathname === null) return 'bypass';
  if (isBypassPath(pathname) || isNodeBypassPath(pathname)) return 'bypass';
  if (pathname.startsWith('/assets/')) return 'asset';
  if (pathname.startsWith('/fonts/')) return 'font';
  if (PRECACHED_ICONS.includes(pathname)) return 'icon';
  return info.mode === 'navigate' ? 'shell' : 'bypass';
}
