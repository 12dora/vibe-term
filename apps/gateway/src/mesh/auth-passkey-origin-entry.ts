// 服务端自己认得的入口地址：站点 URL、Cloudflare 隧道域名、中继访问地址。
//
// 只用服务端配置，不看任何请求头——它存在的意义就是判断请求里那个不可验证的 `Origin`
// 是不是本实例真的对外提供的入口（见 auth-passkey-origin.ts 的放行顺序）。
// 每一项都各自 try/catch：读不到就当没有，绝不因为某个存储不可用而放行更多 origin。

import { getSiteSettingsLinkProvider } from '../api/site-settings-link';
import { config } from '../config';
import { getDb } from '../db/client';
import { meshRelays } from '../db/schema';
import { getSiteSettings } from '../db/site-settings';
import { TunnelConfigStore } from '../tunnel/config-store';

/** 调用方可传入任意装配 deps；入口地址只读服务端配置，不再读取 hub 字段。 */
export type EntryOriginDeps = object;

function safe<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/**
 * 生效的站点 URL：`getSiteSettings()` 已经把 mesh link 盖在存储值上，
 * standalone（没有 mesh link）也读得到用户自己填的那个域名——换了反代域名的单机实例
 * 就是靠这一项才登得进去。存储不可用时退回 mesh link。
 */
function siteUrl(): string | null {
  return (
    safe(() => getSiteSettings().siteUrl) ??
    safe(() => getSiteSettingsLinkProvider().effectiveSiteUrl())
  );
}

/** 已配置的隧道主机名；`mode==='off'` 时不算入口。 */
function tunnelUrl(): string | null {
  const persisted = safe(() => new TunnelConfigStore(getDb()).get());
  if (!persisted || persisted.mode === 'off' || !persisted.hostname) return null;
  return `https://${persisted.hostname}`;
}

/** 已接入的中继地址：浏览器经中继访问时页面 origin 就是中继本身。 */
function relayUrls(): string[] {
  return (
    safe(() =>
      getDb()
        .select({ url: meshRelays.url })
        .from(meshRelays)
        .all()
        .map((row) => row.url)
        .filter((url): url is string => Boolean(url))
    ) ?? []
  );
}

/** 本实例对外提供的全部入口地址（未去重，比对时按规范化 origin 判等）。 */
export function defaultEntryOrigins(_deps: EntryOriginDeps = {}): Array<string | null> {
  return [config.baseUrl || null, siteUrl(), tunnelUrl(), ...relayUrls()];
}
