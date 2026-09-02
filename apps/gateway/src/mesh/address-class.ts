import type { PeerReach, PeerTransportKind } from './types';

export const RTT_MATERIAL_ABS_MS = 10;
export const RTT_MATERIAL_REL = 0.2;
export const RTT_EVENT_MIN_INTERVAL_MS = 10_000;

export type AddressClass = 'lan' | 'wan';

/** 有实测 peer 路径即为可达；`wan` 与 `lan` 同等视为在线。 */
export function isPeerReachable(reach: PeerReach | undefined): boolean {
  return reach === 'lan' || reach === 'wan' || reach === 'relay';
}

export function rttChangedMaterially(
  prev: number | null | undefined,
  next: number | null | undefined
): boolean {
  if (prev == null && next == null) return false;
  if (prev == null || next == null) return true;
  const delta = Math.abs(next - prev);
  if (delta >= RTT_MATERIAL_ABS_MS) return true;
  if (prev === 0) return delta > 0;
  return delta / Math.abs(prev) >= RTT_MATERIAL_REL;
}

export function classifyPeerReach(
  transport: PeerTransportKind | null | undefined,
  remoteAddress: string | null | undefined
): PeerReach {
  if (transport == null) return null;
  if (transport === 'relay') return 'relay';
  return classifyRemoteAddress(remoteAddress);
}

/**
 * 对端地址分类：无地址证据一律 `wan`，避免把公网链路标成局域网。
 * 私网：loopback、RFC1918、链路本地、IPv6 ULA，以及它们的 IPv4-mapped 形式。
 */
export function classifyRemoteAddress(raw: string | null | undefined): AddressClass {
  const host = normalizeHost(raw);
  if (!host) return 'wan';
  if (host === 'localhost') return 'lan';
  const mapped = unwrapIpv4Mapped(host);
  if (mapped && isLanIpv4(mapped)) return 'lan';
  if (isLanIpv4(host) || isLanIpv6(host)) return 'lan';
  return 'wan';
}

export function hostFromWsUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return normalizeHost(parsed.hostname);
  } catch {
    return null;
  }
}

/** 从 ICE candidate 行取出远端 IP（`candidate:… <ip> <port> typ …`）。 */
export function addressFromIceCandidate(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const match = candidate.match(
    /(?:^|\s)(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+(?:%[0-9a-z._-]+)?)\s+\d+\s+typ\s+/i
  );
  return match?.[1] ?? null;
}

function normalizeHost(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let host = raw.trim();
  if (!host || host === 'unknown') return null;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone >= 0) host = host.slice(0, zone);
  host = host.toLowerCase();
  return host || null;
}

/** Lowercased host without brackets/zone; IPv4-mapped forms become dotted IPv4. */
export function canonicalPeerHost(raw: string | null | undefined): string | null {
  const host = normalizeHost(raw);
  if (!host) return null;
  return unwrapIpv4Mapped(host) ?? host;
}

/** CGNAT shared-address space `100.64.0.0/10` (RFC 6598), including IPv4-mapped. */
export function isCgnatIpv4(host: string): boolean {
  const n = canonicalPeerHost(host);
  if (!n) return false;
  const o = parseIpv4(n);
  if (!o) return false;
  const a = o[0] ?? 0;
  const b = o[1] ?? 0;
  return a === 100 && b >= 64 && b <= 127;
}

/** IPv6 unique local `fc00::/7`. */
export function isIpv6Ula(host: string): boolean {
  const w = parseIpv6Words(host);
  if (!w) return false;
  return ((w[0] ?? 0) & 0xfe00) === 0xfc00;
}

/** Deprecated IPv6 site-local `fec0::/10`. */
export function isIpv6SiteLocal(host: string): boolean {
  const w = parseIpv6Words(host);
  if (!w) return false;
  return ((w[0] ?? 0) & 0xffc0) === 0xfec0;
}

export function hasLocalCgnatAddress(
  interfaces: Record<string, RankableIfaceAddr[] | undefined>
): boolean {
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      const family = addr.family as string | number | undefined;
      if (family === 'IPv4' || family === 4) {
        if (isCgnatIpv4(addr.address)) return true;
      }
    }
  }
  return false;
}

/** Sorted unique non-internal addresses; used to detect local network changes. */
export function localNetworkFingerprint(
  interfaces: Record<string, RankableIfaceAddr[] | undefined>
): string {
  const set = new Set<string>();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      const host = normalizeHost(addr.address);
      if (host) set.add(host);
    }
  }
  return [...set].sort().join(',');
}

function unwrapIpv4Mapped(host: string): string | null {
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted) return dotted[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1] ?? '', 16);
  const lo = Number.parseInt(hex[2] ?? '', 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isLanIpv4(host: string): boolean {
  const o = parseIpv4(host);
  if (!o) return false;
  const a = o[0] ?? 0;
  const b = o[1] ?? 0;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isLanIpv6(host: string): boolean {
  const w = parseIpv6Words(host);
  if (!w) return false;
  const w0 = w[0] ?? 0;
  const isLoopback = w.slice(0, 7).every((x) => x === 0) && (w[7] ?? 0) === 1;
  if (isLoopback) return true;
  if ((w0 & 0xffc0) === 0xfe80) return true;
  if ((w0 & 0xfe00) === 0xfc00) return true;
  return false;
}

export type RankableIfaceAddr = {
  address: string;
  netmask?: string;
  family?: string | number;
  internal?: boolean;
  cidr?: string | null;
};

const TIER_SAME_SUBNET = 0;
const TIER_PRIVATE = 1;
const TIER_PUBLIC = 2;
const FAMILY_V4 = 0;
const FAMILY_V6 = 1;
const FAMILY_OTHER = 2;

/**
 * 直连候选排序：同网段（相对本机非 internal 网卡）> 其他私网 > 公网；
 * 同一档内 IPv4 先于 IPv6。稳定：同档同族保持输入相对顺序。
 */
export function rankPeerEndpoints(
  endpoints: string[],
  interfaces: Record<string, RankableIfaceAddr[] | undefined>
): string[] {
  const locals = collectLocalNets(interfaces);
  return endpoints
    .map((url, index) => {
      const host = hostFromWsUrl(url);
      const mapped = host ? unwrapIpv4Mapped(host) : null;
      const v4 = mapped ? parseIpv4(mapped) : host ? parseIpv4(host) : null;
      const v6 = !v4 && host ? parseIpv6Words(host) : null;
      const family = v4 ? FAMILY_V4 : v6 ? FAMILY_V6 : FAMILY_OTHER;
      const same = v4
        ? locals.v4.some((net) => ipv4SameSubnet(v4, net.addr, net.prefix))
        : v6
          ? locals.v6.some((net) => ipv6PrefixEqual(v6, net.addr, net.prefix))
          : false;
      const privateAddr = classifyRemoteAddress(host) === 'lan';
      const tier = same ? TIER_SAME_SUBNET : privateAddr ? TIER_PRIVATE : TIER_PUBLIC;
      return { url, index, tier, family };
    })
    .sort((a, b) => a.tier - b.tier || a.family - b.family || a.index - b.index)
    .map((row) => row.url);
}

function collectLocalNets(interfaces: Record<string, RankableIfaceAddr[] | undefined>): {
  v4: Array<{ addr: [number, number, number, number]; prefix: number }>;
  v6: Array<{ addr: number[]; prefix: number }>;
} {
  const v4: Array<{ addr: [number, number, number, number]; prefix: number }> = [];
  const v6: Array<{ addr: number[]; prefix: number }> = [];
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      const family = addr.family as string | number | undefined;
      const isV4 = family === 'IPv4' || family === 4;
      const isV6 = family === 'IPv6' || family === 6;
      if (isV4) {
        const parsed = parseIpv4(addr.address);
        const prefix = ipv4PrefixLen(addr);
        if (parsed && prefix != null) v4.push({ addr: parsed, prefix });
      } else if (isV6) {
        const parsed = parseIpv6Words(addr.address);
        const prefix = ipv6PrefixLen(addr);
        if (parsed && prefix != null) v6.push({ addr: parsed, prefix });
      }
    }
  }
  return { v4, v6 };
}

function ipv4PrefixLen(addr: RankableIfaceAddr): number | null {
  const fromCidr = prefixFromCidr(addr.cidr);
  if (fromCidr != null && fromCidr >= 0 && fromCidr <= 32) return fromCidr;
  if (!addr.netmask) return null;
  const o = parseIpv4(addr.netmask);
  if (!o) return null;
  const n = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  let bits = 0;
  let seenZero = false;
  for (let i = 31; i >= 0; i--) {
    if ((n >>> i) & 1) {
      if (seenZero) return null;
      bits += 1;
    } else {
      seenZero = true;
    }
  }
  return bits;
}

function ipv6PrefixLen(addr: RankableIfaceAddr): number | null {
  const fromCidr = prefixFromCidr(addr.cidr);
  if (fromCidr != null && fromCidr >= 0 && fromCidr <= 128) return fromCidr;
  return null;
}

function prefixFromCidr(cidr: string | null | undefined): number | null {
  if (!cidr) return null;
  const slash = cidr.lastIndexOf('/');
  if (slash < 0) return null;
  const n = Number(cidr.slice(slash + 1));
  return Number.isInteger(n) ? n : null;
}

function ipv4SameSubnet(
  peer: [number, number, number, number],
  local: [number, number, number, number],
  prefix: number
): boolean {
  return ipv4Network(peer, prefix) === ipv4Network(local, prefix);
}

function ipv4Network(addr: [number, number, number, number], prefix: number): number {
  const ip = ((addr[0] << 24) | (addr[1] << 16) | (addr[2] << 8) | addr[3]) >>> 0;
  if (prefix <= 0) return 0;
  if (prefix >= 32) return ip;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) >>> 0;
}

function ipv6PrefixEqual(a: number[], b: number[], prefixLen: number): boolean {
  if (prefixLen <= 0) return true;
  const bits = Math.min(prefixLen, 128);
  const full = Math.floor(bits / 16);
  for (let i = 0; i < full; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return false;
  }
  const rem = bits % 16;
  if (rem === 0) return true;
  const mask = (0xffff << (16 - rem)) & 0xffff;
  return ((a[full] ?? 0) & mask) === ((b[full] ?? 0) & mask);
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const o: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    o.push(n);
  }
  return o as [number, number, number, number];
}

/** 解析 IPv6 为 8 个 16-bit 字；zone-id（`%iface`）在内部剥掉。畸形输入返回 null。 */
export function parseIpv6Words(address: string): number[] | null {
  const cut = address.indexOf('%');
  const bare = (cut === -1 ? address : address.slice(0, cut)).toLowerCase();
  if (bare.includes('.')) return null;
  const compressed = bare.split('::');
  if (compressed.length > 2) return null;
  const parseGroup = (group: string): number[] | null => {
    if (!group) return [];
    const parts = group.split(':');
    const words: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
      words.push(Number.parseInt(p, 16));
    }
    return words;
  };
  if (compressed.length === 1) {
    const words = parseGroup(compressed[0] ?? '');
    return words && words.length === 8 ? words : null;
  }
  const left = parseGroup(compressed[0] ?? '');
  const right = parseGroup(compressed[1] ?? '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}
