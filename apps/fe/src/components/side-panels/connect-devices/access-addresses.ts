// 手机要访问的地址：不是浏览器当前的 origin（本机打开时是 127.0.0.1，别的设备根本连不上），
// 而是按可达性排出来的候选——公网入口（隧道 / 本机 Hub / 中继）、局域网 IP、以及非回环的当前地址。

import type { AccessAddressesResponse, TunnelStatusResponse } from '@vibeterm/shared';
import { entryStatus } from './host-status';

// 种类只用来给候选打标签（界面上要区分「隧道 / Hub / 中继 / 局域网 / Tailscale / VPN / 当前地址」），
// 排序仍按可达性。
export type AccessAddressKind =
  | 'tunnel'
  | 'hub'
  | 'relay'
  | 'lan'
  | 'tailscale'
  | 'vpn'
  | 'current';

export interface AccessAddress {
  kind: AccessAddressKind;
  url: string;
}

export interface AccessAddressInput {
  origin: string;
  tunnel: TunnelStatusResponse | null;
  hubPublicUrl: string | null;
  /** 本机自己就是 Hub；成员节点上 `hubPublicUrl` 是上级地址，扫出来打开的是上级的界面 */
  selfIsHub: boolean;
  /** 上联是中继：此时没有 Hub 入口，公网槽由中继候选填 */
  relayMode: boolean;
  addresses: AccessAddressesResponse | null;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return LOOPBACK_HOSTS.has(host) || host === '::1' || host.startsWith('127.');
  } catch {
    return false;
  }
}

function tunnelPublicUrl(tunnel: TunnelStatusResponse | null): string | null {
  // 整包跑测试时别的用例会往同一个查询键塞形状不完整的桩数据，这里按缺省处理而不是崩。
  const config = tunnel?.config;
  if (!config) return null;
  if (config.mode === 'named' && config.hostname) return `https://${config.hostname}`;
  if (config.mode === 'quick') return tunnel?.process?.publicUrl ?? null;
  return null;
}

/** 隧道候选：地址 + 它现在是否真的可达（与「本机作为中继」那三步同一条判据）。 */
interface TunnelCandidate {
  url: string | null;
  /** 进程在跑且连接器有边缘连接：只有这种隧道才配当默认（二维码扫出来的那一条）。 */
  healthy: boolean;
}

function tunnelCandidate(tunnel: TunnelStatusResponse | null): TunnelCandidate {
  const url = tunnelPublicUrl(tunnel);
  if (!url) return { url: null, healthy: false };
  const entry = entryStatus(tunnel, null);
  // 进程活着但没有边缘连接：地址暂时打不开，能列但不能排第一
  if (entry.degraded) return { url, healthy: false };
  // 进程已停：这个地址必然打不开，直接不摆出来
  if (!entry.running) return { url: null, healthy: false };
  return { url, healthy: true };
}

/** 本机 Hub 的公网入口。成员节点与中继上联都没有；回环地址手机扫不到，一律丢掉。 */
function selfHubUrl(input: AccessAddressInput): string | null {
  if (!input.selfIsHub || input.relayMode) return null;
  const url = input.hubPublicUrl;
  if (!url || isLoopbackOrigin(url)) return null;
  return url;
}

type LanEntry = { kind: 'lan' | 'tailscale' | 'vpn'; ip: string };

const LAN_ORDER = ['lan', 'tailscale', 'vpn'] as const;

/** 旧网关只给 `lanAddresses: string[]`，此时全部按局域网处理。 */
function lanEntries(addresses: AccessAddressesResponse | null): LanEntry[] {
  if (!addresses || addresses.loopbackOnly) return [];
  const candidates = addresses.lanCandidates;
  if (Array.isArray(candidates))
    return candidates.map((item) => ({ kind: item.kind, ip: item.ip }));
  if (Array.isArray(addresses.lanAddresses)) {
    return addresses.lanAddresses.map((ip) => ({ kind: 'lan' as const, ip }));
  }
  return [];
}

/**
 * 候选列表：可用的隧道 → 本机 Hub → 中继入口 → 局域网 → Tailscale → VPN →
 * 掉线的隧道 → 当前地址；全部为空时退回当前 origin（哪怕是回环，界面另给提示）。
 *
 * 第一条就是二维码的缺省地址，所以隧道只有**当前真的可达**才排第一：光看「配了主机名」
 * 会把停掉的隧道推成默认，用户扫出来是一个打不开的地址。
 */
export function buildAccessAddresses(input: AccessAddressInput): AccessAddress[] {
  const out: AccessAddress[] = [];
  const seen = new Set<string>();
  const push = (kind: AccessAddressKind, url: string | null | undefined) => {
    if (!url) return;
    const normalized = url.replace(/\/+$/, '');
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ kind, url: normalized });
  };

  const tunnel = tunnelCandidate(input.tunnel);
  if (tunnel.healthy) push('tunnel', tunnel.url);
  push('hub', selfHubUrl(input));
  push('relay', input.addresses?.relayAccessUrl ?? null);
  const port = input.addresses?.port;
  const lan = lanEntries(input.addresses);
  for (const kind of LAN_ORDER) {
    for (const entry of lan) {
      if (entry.kind === kind) push(kind, `http://${entry.ip}:${port}`);
    }
  }
  if (!tunnel.healthy) push('tunnel', tunnel.url);
  if (input.origin && !isLoopbackOrigin(input.origin)) push('current', input.origin);
  if (out.length === 0 && input.origin) push('current', input.origin);
  return out;
}

/** 只剩回环地址可展示时提醒：本机只监听 127.0.0.1，其他设备连不上。 */
export function showLoopbackHint(list: AccessAddress[], input: AccessAddressInput): boolean {
  const onlyLoopback = list.every((item) => item.kind === 'current' && isLoopbackOrigin(item.url));
  return onlyLoopback && (input.addresses?.loopbackOnly ?? isLoopbackOrigin(input.origin));
}
