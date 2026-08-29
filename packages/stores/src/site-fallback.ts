// 站点信息兜底：非 React 代码（如 buildBrowserTitle）需要的 siteName / siteUrl。
// 不再硬读默认 runtime——由当前活跃的 node 边界注册自己的 site 设置读取器，
// 未注册时退回内置缺省值，多 runtime 下不会串到 entry 的站点信息。

import { PRODUCT_NAME } from '@tmex/shared';

export interface SiteFallbackSnapshot {
  siteName?: string | null;
  siteUrl?: string | null;
}

type SiteFallbackReader = () => SiteFallbackSnapshot | null | undefined;

let reader: SiteFallbackReader | null = null;

/** 注册当前活跃 runtime 的站点设置读取器，返回注销函数。 */
export function setSiteFallbackReader(fn: SiteFallbackReader | null): () => void {
  reader = fn;
  const registered = fn;
  return () => {
    if (reader === registered) reader = null;
  };
}

export function getSiteNameFallback(): string {
  return reader?.()?.siteName || PRODUCT_NAME;
}

export function getSiteUrlFallback(): string {
  const url = reader?.()?.siteUrl;
  if (url) return url;
  return typeof window !== 'undefined' ? window.location.origin : '';
}
