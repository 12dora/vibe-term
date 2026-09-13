import { isIP } from 'node:net';
import os from 'node:os';
import { config as gatewayConfig } from '../config';
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

export function stunMappedAddressesForAdvertise(
  rows: readonly { ok: boolean; fakeIp?: boolean; mappedAddress?: string }[] = stunProbeSnapshot()
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (!row.ok || row.fakeIp || !row.mappedAddress) continue;
    out.push(row.mappedAddress);
  }
  return out;
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
  const ip = pickPublicPeerIpv4(opts, ifaceIps);
  if (!ip) return urls;
  const url = `ws://${ip}:${port}/peer`;
  if (urls.includes(url)) return urls;
  urls.push(url);
  return urls;
}

function pickPublicPeerIpv4(
  opts: EnumeratePeerEndpointsOpts,
  ifaceIps: ReadonlySet<string>
): string | null {
  const explicit = usablePublicIpv4(opts.publicHost);
  if (explicit && !ifaceIps.has(explicit)) return explicit;
  for (const raw of opts.mappedAddresses ?? []) {
    const ip = usablePublicIpv4(ipv4FromMapped(raw));
    if (ip && !ifaceIps.has(ip)) return ip;
  }
  return null;
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
  if (a === 0) return o.some((n) => n !== 0);
  if (a === 169) return b !== 254;
  return a < 224 || a > 239;
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
