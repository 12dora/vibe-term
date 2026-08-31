// 「接入更多设备」面板要展示的本机地址线索：监听地址 + 局域网 IPv4。
// 公网地址（隧道 / Hub 公开地址）由前端从 tunnel status 与 auth mode 取，这里只管本机能看到的。

import { networkInterfaces } from 'node:os';
import type { AccessAddressesResponse } from '@tmex/shared';
import { config } from '../config';

type InterfaceMap = ReturnType<typeof networkInterfaces>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackBindHost(bindHost: string): boolean {
  const host = bindHost.replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

function isPrivateIpv4(address: string): boolean {
  if (address.startsWith('10.') || address.startsWith('192.168.')) return true;
  const match = /^172\.(\d+)\./.exec(address);
  return match !== null && Number(match[1]) >= 16 && Number(match[1]) <= 31;
}

/** 非回环、非链路本地的 IPv4；私网段排前面，其余按字典序。 */
export function collectLanAddresses(interfaces: InterfaceMap): string[] {
  const seen = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      seen.add(entry.address);
    }
  }
  return [...seen].sort((a, b) => {
    const pa = isPrivateIpv4(a) ? 0 : 1;
    const pb = isPrivateIpv4(b) ? 0 : 1;
    return pa - pb || a.localeCompare(b);
  });
}

export function getAccessAddresses(
  deps: { bindHost?: string; port?: number; interfaces?: () => InterfaceMap } = {}
): AccessAddressesResponse {
  const bindHost = deps.bindHost ?? config.bindHost;
  const port = deps.port ?? config.port;
  const loopbackOnly = isLoopbackBindHost(bindHost);
  return {
    bindHost,
    port,
    loopbackOnly,
    lanAddresses: loopbackOnly ? [] : collectLanAddresses((deps.interfaces ?? networkInterfaces)()),
  };
}
