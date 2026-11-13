// 请求 authority（Host）是否指向本机：IP 字面量、localhost / *.localhost、本机 mDNS 名
// （`<hostname>.local`）或服务端已配置的域名。免登录单机的 Host 规则与特权本机判定
// （`localClientClass`）共用这一条：浏览器按页面域名发请求，域名不是本机认得的名字时，
// 即使套接字是回环也不当本机。

import { listDomainAccessHosts } from '../api/domain-access-routes';
import { getShareService } from '../share/share-service';
import { ownEntryOrigins } from './auth-passkey-origin-entry';
import {
  collectConfiguredHosts,
  hostnameOf,
  isIpLiteral,
  isLocalName,
  normalizeHost,
} from './domain-access-policy';

function shareDefaultOrigin(): string | null {
  try {
    return getShareService().getSettings().defaultOrigin;
  } catch {
    return null;
  }
}

/** 本实例自己的入口 origin：站点 URL、隧道、本机中继、分享默认地址。 */
export function serverEntryOrigins(): Array<string | null> {
  return [...ownEntryOrigins(), shareDefaultOrigin()];
}

export function serverConfiguredHosts(
  origins: ReadonlyArray<string | null | undefined> = serverEntryOrigins()
): string[] {
  let domainHosts: string[] = [];
  try {
    domainHosts = listDomainAccessHosts();
  } catch {
    domainHosts = [];
  }
  return collectConfiguredHosts([...domainHosts, ...origins]);
}

export function authorityAllowed(
  authority: string,
  configured: () => readonly string[] = serverConfiguredHosts
): boolean {
  const normalized = normalizeHost(authority);
  if (!normalized) return false;
  if (isIpLiteral(normalized) || isLocalName(normalized)) return true;
  const hosts = configured();
  return hosts.includes(normalized) || hosts.includes(hostnameOf(normalized));
}

/** 原始 `Host`；测试里手造的请求没有该头时退回 URL。 */
export function requestAuthority(req: Request): string {
  const host = req.headers.get('host');
  if (host) return host;
  try {
    return new URL(req.url).host;
  } catch {
    return '';
  }
}
