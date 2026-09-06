// 「接入更多设备」面板要展示的本机地址线索：监听地址 + 局域网 IPv4 候选。
// 隧道地址由前端从 tunnel status 取；中继入口在这里给——它要探测结论，前端拿不到。

import { networkInterfaces } from 'node:os';
import type { AccessAddressesResponse, LanAddressCandidate } from '@vibeterm/shared';
import { config } from '../config';
import { collectLanCandidates, readDefaultIface } from './lan-interfaces';

type InterfaceMap = ReturnType<typeof networkInterfaces>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackBindHost(bindHost: string): boolean {
  const host = bindHost.replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

export interface AccessAddressesDeps {
  bindHost?: string;
  port?: number;
  interfaces?: () => InterfaceMap;
  /** 默认路由网卡；不传时现读（自带 1 min 缓存） */
  defaultIface?: () => string | null;
  /** 中继入口 `<relay>/n/<self>`；探不通或不是中继上联时为 null */
  relayAccessUrl?: () => string | null;
}

/** 候选 IP 列表，等价于 `collectLanCandidates(...).map((c) => c.ip)`。 */
export function collectLanAddresses(
  interfaces: InterfaceMap,
  options: { defaultIface?: string | null; bindHost?: string | null } = {}
): string[] {
  return collectLanCandidates(interfaces, options).map((candidate) => candidate.ip);
}

function readRelayAccessUrl(deps: AccessAddressesDeps): string | null {
  if (!deps.relayAccessUrl) return null;
  try {
    return deps.relayAccessUrl();
  } catch {
    return null;
  }
}

export function getAccessAddresses(deps: AccessAddressesDeps = {}): AccessAddressesResponse {
  const bindHost = deps.bindHost ?? config.bindHost;
  const port = deps.port ?? config.port;
  const loopbackOnly = isLoopbackBindHost(bindHost);
  const lanCandidates: LanAddressCandidate[] = loopbackOnly
    ? []
    : collectLanCandidates((deps.interfaces ?? networkInterfaces)(), {
        defaultIface: (deps.defaultIface ?? readDefaultIface)(),
        bindHost,
      });
  return {
    bindHost,
    port,
    loopbackOnly,
    lanAddresses: lanCandidates.map((candidate) => candidate.ip),
    lanCandidates,
    relayAccessUrl: readRelayAccessUrl(deps),
  };
}
