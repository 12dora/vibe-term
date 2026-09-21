import { isIP } from 'node:net';
import os from 'node:os';
import { config as gatewayConfig, isPublicPeerHostname } from '../config';
import {
  classifyRemoteAddress,
  hasLocalCgnatAddress,
  isCgnatIpv4,
  isFakeIpv4,
  parseIpv6Words,
} from './address-class';
import { stunProbeSnapshot } from './rtc/stun-probe';

const CONTAINER_IFACE_PREFIXES = [
  'docker',
  'veth',
  'virbr',
  'lxdbr',
  'lxcbr',
  'cni',
  'flannel',
  'podman',
] as const;

export type AdvertisablePeerAddressOpts = {
  iface?: string;
  allowCgnat?: boolean;
};

export type EnumeratePeerEndpointsOpts = {
  bindHosts?: readonly string[];
  publicHost?: string | null;
  mappedAddresses?: readonly (string | undefined)[];
};

export function isContainerOrientedIface(name: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('br-')) return true;
  return CONTAINER_IFACE_PREFIXES.some((prefix) => n === prefix || n.startsWith(prefix));
}

export function isAdvertisablePeerAddress(
  addr: os.NetworkInterfaceInfo,
  opts?: AdvertisablePeerAddressOpts
): boolean {
  if (addr.internal) return false;
  if (opts?.iface && isContainerOrientedIface(opts.iface)) return false;
  const family = addr.family as string | number;
  if (family === 'IPv4' || family === 4) {
    if (isFakeIpv4(addr.address) || (!opts?.allowCgnat && isCgnatIpv4(addr.address))) return false;
    return isAdvertisableIpv4(addr.address);
  }
  if (family === 'IPv6' || family === 6) return isAdvertisableIpv6(addr.address);
  return false;
}

/** 网卡地址在前；1:1 DNAT 的公网 IPv4 追加在后（仅 bind-all 时）。 */
export function enumeratePeerEndpoints(
  port: number,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
  opts?: EnumeratePeerEndpointsOpts
): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const ifaceIps = new Set<string>();
  const allowCgnat = hasLocalCgnatAddress(interfaces);
  for (const [iface, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      noteInterfaceIpv4(addr, ifaceIps);
      if (!isAdvertisablePeerAddress(addr, { iface, allowCgnat })) continue;
      const family = addr.family as string | number;
      const v6 = family === 'IPv6' || family === 6;
      const host = v6 ? `[${stripZoneId(addr.address)}]` : stripZoneId(addr.address);
      const url = `ws://${host}:${port}/peer`;
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  return appendPublicPeerEndpoint(urls, port, ifaceIps, opts);
}

/** STUN 映射地址只在最近一轮探测内有效：公网出口变化后旧地址不能继续广播。 */
export const STUN_MAPPED_ADVERTISE_TTL_MS = 30 * 60 * 1000;

export type StunAdvertiseRow = {
  ok: boolean;
  fakeIp?: boolean;
  mappedAddress?: string;
  probedAt?: number;
};

/** 分歧时最多广告这么多条不同公网 IPv4；对端有 backoff + probe 裁剪。 */
export const STUN_MAPPED_ADVERTISE_MAX = 3;

/**
 * 选出可广告的 STUN mapped 地址。
 * `fakeIp` 只表示「解析 STUN 服务器域名时系统 DNS 见过 fake-IP」，与 mapped 本身无关，
 * 不再作为否决条件；mapped 是否可广告由 `usablePublicIpv4` 把关。
 * 多条样本按 mapped IPv4 计票：只有 1 条有效样本时采用；≥2 条且严格过半则只发多数派。
 * 平票 / 无多数时按票数降序、地址升序把可用公网候选全部广告出去（去重，上限
 * `STUN_MAPPED_ADVERTISE_MAX`），不退化为「一个都不发」。
 */
export function stunMappedAddressesForAdvertise(
  rows: readonly StunAdvertiseRow[] = stunProbeSnapshot(),
  now: number = Date.now()
): string[] {
  const usable: string[] = [];
  for (const row of rows) {
    const mapped = mappedAddressIfAdvertisable(row, now);
    if (mapped) usable.push(mapped);
  }
  return pickMajorityMappedAddresses(usable);
}

function mappedAddressIfAdvertisable(row: StunAdvertiseRow, now: number): string | null {
  if (!row.ok || !row.mappedAddress) return null;
  if (row.probedAt !== undefined && now - row.probedAt > STUN_MAPPED_ADVERTISE_TTL_MS) return null;
  return mappedIpv4(row.mappedAddress) ? row.mappedAddress : null;
}

function pickMajorityMappedAddresses(mapped: readonly string[]): string[] {
  if (mapped.length === 0) return [];
  if (mapped.length === 1) return [...mapped];
  const winner = majorityMappedIpv4(mapped);
  if (winner) return mapped.filter((item) => mappedIpv4(item) === winner);
  return uniqueMappedByVotes(mapped, STUN_MAPPED_ADVERTISE_MAX);
}

function uniqueMappedByVotes(mapped: readonly string[], limit: number): string[] {
  const counts = new Map<string, number>();
  const first = new Map<string, string>();
  for (const item of mapped) {
    const ip = mappedIpv4(item);
    if (!ip) continue;
    counts.set(ip, (counts.get(ip) ?? 0) + 1);
    if (!first.has(ip)) first.set(ip, item);
  }
  return [...counts.keys()]
    .sort((a, b) => {
      const byVotes = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
      return byVotes !== 0 ? byVotes : a.localeCompare(b);
    })
    .slice(0, Math.max(0, limit))
    .flatMap((ip) => {
      const row = first.get(ip);
      return row ? [row] : [];
    });
}

function majorityMappedIpv4(mapped: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const item of mapped) {
    const ip = mappedIpv4(item);
    if (!ip) continue;
    counts.set(ip, (counts.get(ip) ?? 0) + 1);
  }
  return strictMajorityKey(counts, mapped.length);
}

function strictMajorityKey(counts: Map<string, number>, total: number): string | null {
  let winner: string | null = null;
  let best = 0;
  let ties = 0;
  for (const [ip, n] of counts) {
    if (n > best) {
      winner = ip;
      best = n;
      ties = 1;
    } else if (n === best) {
      ties += 1;
    }
  }
  if (!winner || ties !== 1 || best < 2 || best * 2 <= total) return null;
  return winner;
}

function mappedIpv4(mapped: string | undefined): string | null {
  return usablePublicIpv4(ipv4FromMapped(mapped));
}

function appendPublicPeerEndpoint(
  urls: string[],
  port: number,
  ifaceIps: ReadonlySet<string>,
  opts?: EnumeratePeerEndpointsOpts
): string[] {
  if (!opts) return urls;
  const bindHosts = opts.bindHosts ?? gatewayConfig.peerBindHost;
  if (!peerBindsAllInterfaces(bindHosts)) return urls;
  for (const host of pickPublicPeerHosts(opts, ifaceIps)) {
    const url = `ws://${host}:${port}/peer`;
    if (urls.includes(url)) continue;
    urls.push(url);
  }
  return urls;
}

function pickPublicPeerHosts(
  opts: EnumeratePeerEndpointsOpts,
  ifaceIps: ReadonlySet<string>
): string[] {
  const explicit = advertisablePublicHost(opts.publicHost);
  if (explicit && !ifaceIps.has(explicit)) return [explicit];
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const raw of opts.mappedAddresses ?? []) {
    const ip = mappedIpv4(raw);
    if (!ip || ifaceIps.has(ip) || seen.has(ip)) continue;
    seen.add(ip);
    hosts.push(ip);
    if (hosts.length >= STUN_MAPPED_ADVERTISE_MAX) break;
  }
  return hosts;
}

/** 显式公网 host：可广告 IPv4，或语法合法的 FQDN。 */
export function advertisablePublicHost(raw: string | null | undefined): string | null {
  const host = raw?.trim() ?? '';
  if (!host) return null;
  if (isIP(host) === 4) return usablePublicIpv4(host);
  if (isIP(host) !== 0) return null;
  return isPublicPeerHostname(host) ? host : null;
}

export function usablePublicIpv4(raw: string | null | undefined): string | null {
  const host = raw?.trim() ?? '';
  if (!host || isIP(host) !== 4) return null;
  if (isFakeIpv4(host) || isCgnatIpv4(host)) return null;
  if (classifyRemoteAddress(host) === 'lan') return null;
  if (!isAdvertisableIpv4(host)) return null;
  return host;
}

function ipv4FromMapped(mapped: string | undefined): string | null {
  if (!mapped) return null;
  const host = mapped.startsWith('[')
    ? mapped.slice(1, mapped.lastIndexOf(']'))
    : mapped.slice(0, mapped.lastIndexOf(':'));
  return host || null;
}

function peerBindsAllInterfaces(hosts: readonly string[]): boolean {
  return hosts.some((host) => {
    const h = host.trim();
    return h === '0.0.0.0' || h === '::' || h === '*';
  });
}

function noteInterfaceIpv4(addr: os.NetworkInterfaceInfo, into: Set<string>): void {
  if (addr.internal) return;
  const family = addr.family as string | number;
  if (family !== 'IPv4' && family !== 4) return;
  const host = stripZoneId(addr.address);
  if (host) into.add(host);
}

function stripZoneId(address: string): string {
  const cut = address.indexOf('%');
  return cut === -1 ? address : address.slice(0, cut);
}

function parseIpv4Octets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isAdvertisableIpv4(address: string): boolean {
  const o = parseIpv4Octets(stripZoneId(address));
  if (!o) return false;
  const [a, b] = o;
  if (a === 127) return false;
  if (a === 0) return false;
  if (a === 169) return b !== 254;
  return a < 224;
}

function isAdvertisableIpv6(address: string): boolean {
  const w = parseIpv6Words(address);
  if (!w) return false;
  const w0 = w[0];
  if ((w0 & 0xffc0) === 0xfe80) return false;
  if ((w0 & 0xfe00) === 0xfc00) return false;
  if ((w0 & 0xffc0) === 0xfec0) return false;
  if ((w0 & 0xff00) === 0xff00) return false;
  if (w.slice(0, 7).some((x) => x !== 0)) return true;
  return w[7] > 1;
}
