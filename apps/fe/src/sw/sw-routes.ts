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
 * 一律不拦截的同源路径前缀：网关 API、WS 升级、mesh 事件流、子节点代理、健康检查，
 * 以及 SW 脚本自身（更新检查必须走网络）。前缀匹配刻意从宽，宁可漏缓存不可错拦。
 */
export const BYPASS_PREFIXES: readonly string[] = [
  '/api/',
  '/ws',
  '/mesh/',
  '/n/',
  '/healthz',
  '/sw.js',
];

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
  if (isBypassPath(pathname)) return 'bypass';
  if (pathname.startsWith('/assets/')) return 'asset';
  if (pathname.startsWith('/fonts/')) return 'font';
  if (PRECACHED_ICONS.includes(pathname)) return 'icon';
  return info.mode === 'navigate' ? 'shell' : 'bypass';
}
