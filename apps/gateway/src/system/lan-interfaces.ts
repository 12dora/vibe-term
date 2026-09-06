// 手机扫码要用的局域网候选：比 mesh 的 peer 广告严得多。
// peer 广告只要「别的节点也许能连」，这里要的是「手机和这台电脑在同一张网上」，
// 所以容器 / 虚拟机 / 代理 fake-IP 网卡一律丢掉，隧道网卡只留 Tailscale 与私网 VPN 并另行标注。

import { spawnSync } from 'node:child_process';
import type { networkInterfaces } from 'node:os';
import type { LanAddressCandidate, LanAddressKind } from '@vibeterm/shared';
import { isCgnatIpv4, isFakeIpv4 } from '../mesh/address-class';

type InterfaceMap = ReturnType<typeof networkInterfaces>;

/** 物理网卡名：Linux 的可预测命名与 BSD/macOS 的常见前缀 */
const PHYSICAL_IFACE_PREFIXES = [
  'enp',
  'ens',
  'eno',
  'eth',
  'en',
  'em',
  'wlp',
  'wlan',
  'wl',
  'bond',
  'igb',
  're',
] as const;

/** 隧道网卡：上面的私网地址仍可能有人扫得到（同一 VPN / Tailscale），保留但降权 */
const TUNNEL_IFACE_PREFIXES = ['utun', 'tun', 'tap', 'wg', 'ipsec', 'ppp', 'tailscale'] as const;

/**
 * 容器 / 虚拟机 / 系统内部网卡：手机永远连不上，直接丢。
 * 注意不含裸 `br*` / `bridge*`——把物理网卡并进网桥（Proxmox、Linux 服务器、macOS 网络共享）
 * 时局域网地址就挂在网桥上，见 `isBridgeIface`；docker 自建网络是带连字符的 `br-<hex>`。
 */
const DISCARD_IFACE_PREFIXES = [
  'lo',
  'awdl',
  'llw',
  'ap',
  'gif',
  'stf',
  'dummy',
  'anpi',
  'docker',
  'veth',
  'virbr',
  'lxdbr',
  'lxcbr',
  'cni',
  'flannel',
  'podman',
  'vmnet',
  'vboxnet',
  'hyper-v',
  'cbridge',
] as const;

/** 虚拟化厂商 OUI：只在网卡名不像物理网卡时作为丢弃信号，避免误伤 USB 网卡 */
const VIRTUAL_MAC_PREFIXES = [
  '00:50:56',
  '00:0c:29',
  '00:05:69',
  '00:15:5d',
  '00:16:3e',
  '52:54:00',
  '02:42',
  '00:1c:42',
] as const;

const PRIMARY_IFACE_NAMES = new Set(['en0', 'eth0', 'wlan0']);

const startsWithAny = (name: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => name.startsWith(prefix));

export function isPhysicalIface(name: string): boolean {
  return startsWithAny(name.toLowerCase(), PHYSICAL_IFACE_PREFIXES);
}

export function isTunnelIface(name: string): boolean {
  return startsWithAny(name.toLowerCase(), TUNNEL_IFACE_PREFIXES);
}

/** 裸网桥 `br0` / `bridge100`：可能承载物理网卡的局域网地址。`br-<hex>` 是 docker 自建网络，不算。 */
export function isBridgeIface(name: string): boolean {
  return /^(?:br|bridge)\d*$/.test(name.toLowerCase());
}

export function isVirtualIface(name: string): boolean {
  const n = name.toLowerCase();
  if (isBridgeIface(n)) return false;
  if (n.startsWith('br-')) return true;
  return startsWithAny(n, DISCARD_IFACE_PREFIXES) || isTunnelIface(n);
}

export function isPrivateIpv4(address: string): boolean {
  if (address.startsWith('10.') || address.startsWith('192.168.')) return true;
  const match = /^172\.(\d+)\./.exec(address);
  return match !== null && Number(match[1]) >= 16 && Number(match[1]) <= 31;
}

function hasVirtualMac(mac: string | undefined): boolean {
  if (!mac) return false;
  const normalized = mac.toLowerCase();
  if (normalized === '00:00:00:00:00:00') return false;
  return VIRTUAL_MAC_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isIpv4Family(family: string | number | undefined): boolean {
  return family === 'IPv4' || family === 4;
}

/**
 * 单条网卡地址的归类；返回 null 表示不进候选。
 * CGNAT 段先判：Tailscale 在 macOS 走 `utun*`、Linux 走 `tailscale0`，不能被虚拟网卡规则吃掉。
 */
export function classifyLanCandidate(input: {
  iface: string;
  address: string;
  mac?: string;
}): LanAddressKind | null {
  const { address } = input;
  if (address.startsWith('169.254.')) return null;
  if (isFakeIpv4(address)) return null;
  if (isCgnatIpv4(address)) return 'tailscale';
  const name = input.iface.toLowerCase();
  const physical = isPhysicalIface(name);
  // 网桥可能并着虚拟机宿主的网卡，MAC 落在虚拟化 OUI 上是正常的，不作为丢弃信号
  if (!physical && !isBridgeIface(name) && hasVirtualMac(input.mac)) return null;
  if (isTunnelIface(name)) return isPrivateIpv4(address) ? 'vpn' : null;
  // 网桥只认私网地址：公网地址挂在网桥上多半是虚拟机 NAT 出口，不是手机能走的路
  if (isBridgeIface(name)) return isPrivateIpv4(address) ? 'lan' : null;
  if (isVirtualIface(name)) return null;
  if (physical) return 'lan';
  // 名字既不像物理网卡也不在已知虚拟前缀里（USB 网卡、雷雳网桥等）：只放行私网地址
  return isPrivateIpv4(address) ? 'lan' : null;
}

const TIER_DEFAULT_ROUTE = 0;
const TIER_PHYSICAL = 1;
const TIER_BRIDGE = 2;
const TIER_TAILSCALE = 3;
const TIER_VPN = 4;
const TIER_PUBLIC = 5;

function tierOf(candidate: LanAddressCandidate, defaultIface: string | null): number {
  if (candidate.kind === 'tailscale') return TIER_TAILSCALE;
  if (candidate.kind === 'vpn') return TIER_VPN;
  if (!isPrivateIpv4(candidate.ip)) return TIER_PUBLIC;
  const iface = candidate.iface.toLowerCase();
  const bridge = isBridgeIface(iface);
  // 默认路由走 utun 时（Surge 等代理接管默认网关）不给加权，否则 VPN 地址会抢到二维码第一条
  if (defaultIface && iface === defaultIface.toLowerCase() && (isPhysicalIface(iface) || bridge)) {
    return TIER_DEFAULT_ROUTE;
  }
  return bridge ? TIER_BRIDGE : TIER_PHYSICAL;
}

function nameBonus(candidate: LanAddressCandidate): number {
  return PRIMARY_IFACE_NAMES.has(candidate.iface.toLowerCase()) ? 0 : 1;
}

/** 具体绑到某个 IPv4 时，其它网卡地址虽然存在但没在监听：返回该地址，否则 null。 */
function pinnedBindAddress(bindHost: string | null | undefined): string | null {
  if (!bindHost) return null;
  const host = bindHost.replace(/^\[|\]$/g, '');
  if (host === '0.0.0.0' || host === '::' || host === '*') return null;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : null;
}

export interface LanCandidateOptions {
  /** 默认路由所在网卡；null / undefined 表示读不到，只按网卡名排序 */
  defaultIface?: string | null;
  bindHost?: string | null;
}

/**
 * 排序：默认路由物理网卡 → 其它物理局域网 → Tailscale → VPN → 物理网卡公网地址。
 * 同一 IP 出现在多张网卡时只留优先级最高的那条。
 */
export function collectLanCandidates(
  interfaces: InterfaceMap,
  options: LanCandidateOptions = {}
): LanAddressCandidate[] {
  const pinned = pinnedBindAddress(options.bindHost);
  const defaultIface = options.defaultIface ?? null;
  const rows: Array<{ candidate: LanAddressCandidate; tier: number; bonus: number; at: number }> =
    [];
  let index = 0;
  for (const [iface, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || !isIpv4Family(entry.family as string | number)) continue;
      if (pinned && entry.address !== pinned) continue;
      const kind = classifyLanCandidate({ iface, address: entry.address, mac: entry.mac });
      if (!kind) continue;
      const candidate: LanAddressCandidate = { ip: entry.address, kind, iface };
      rows.push({
        candidate,
        tier: tierOf(candidate, defaultIface),
        bonus: nameBonus(candidate),
        at: index++,
      });
    }
  }
  rows.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.bonus - b.bonus ||
      a.candidate.ip.localeCompare(b.candidate.ip) ||
      a.at - b.at
  );
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      if (seen.has(row.candidate.ip)) return false;
      seen.add(row.candidate.ip);
      return true;
    })
    .map((row) => row.candidate);
}

const DEFAULT_IFACE_TTL_MS = 60_000;
const DEFAULT_IFACE_TIMEOUT_MS = 300;

let defaultIfaceCache: { value: string | null; expiresAt: number } | null = null;

export function parseDarwinDefaultIface(output: string): string | null {
  return /^\s*interface:\s*(\S+)/m.exec(output)?.[1] ?? null;
}

export function parseLinuxDefaultIface(output: string): string | null {
  return /\bdev\s+(\S+)/.exec(output)?.[1] ?? null;
}

function runRouteCommand(command: string, args: string[]): string | null {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: DEFAULT_IFACE_TIMEOUT_MS,
      shell: false,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout ?? null;
  } catch {
    return null;
  }
}

function probeDefaultIface(): string | null {
  if (process.platform === 'darwin') {
    const out = runRouteCommand('route', ['-n', 'get', 'default']);
    return out ? parseDarwinDefaultIface(out) : null;
  }
  if (process.platform === 'linux') {
    const out = runRouteCommand('ip', ['-4', 'route', 'show', 'default']);
    return out ? parseLinuxDefaultIface(out) : null;
  }
  return null;
}

/** 默认路由网卡；读不到一律当作「没有默认网卡」。结果缓存 1 min，避免每次请求都 spawn。 */
export function readDefaultIface(now: number = Date.now()): string | null {
  if (defaultIfaceCache && now < defaultIfaceCache.expiresAt) return defaultIfaceCache.value;
  const value = probeDefaultIface();
  defaultIfaceCache = { value, expiresAt: now + DEFAULT_IFACE_TTL_MS };
  return value;
}

/** 测试用：丢掉默认网卡缓存。 */
export function resetDefaultIfaceCache(): void {
  defaultIfaceCache = null;
}
