// 手机要访问的地址：不是浏览器当前的 origin（本机打开时是 127.0.0.1，别的设备根本连不上），
// 而是按可达性排出来的候选——公网入口（隧道 / Hub 公开地址）、局域网 IP、以及非回环的当前地址。

import type { AccessAddressesResponse, TunnelStatusResponse } from '@tmex/shared';

// 种类只用来给候选打标签（界面上要区分「隧道 / Hub / 局域网 / 当前地址」），排序仍按可达性。
export type AccessAddressKind = 'tunnel' | 'hub' | 'lan' | 'current';

export interface AccessAddress {
  kind: AccessAddressKind;
  url: string;
}

export interface AccessAddressInput {
  origin: string;
  tunnel: TunnelStatusResponse | null;
  hubPublicUrl: string | null;
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

/** 候选列表：隧道 → Hub → 局域网 → 当前地址；全部为空时退回当前 origin（哪怕是回环，界面另给提示）。 */
export function buildAccessAddresses(input: AccessAddressInput): AccessAddress[] {
  const out: AccessAddress[] = [];
  const seen = new Set<string>();
  const push = (kind: AccessAddressKind, url: string | null) => {
    if (!url) return;
    const normalized = url.replace(/\/+$/, '');
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ kind, url: normalized });
  };

  push('tunnel', tunnelPublicUrl(input.tunnel));
  push('hub', input.hubPublicUrl);
  const addresses = input.addresses;
  if (addresses && !addresses.loopbackOnly && Array.isArray(addresses.lanAddresses)) {
    for (const ip of addresses.lanAddresses) push('lan', `http://${ip}:${addresses.port}`);
  }
  if (input.origin && !isLoopbackOrigin(input.origin)) push('current', input.origin);
  if (out.length === 0 && input.origin) push('current', input.origin);
  return out;
}

/** 只剩回环地址可展示时提醒：本机只监听 127.0.0.1，其他设备连不上。 */
export function showLoopbackHint(list: AccessAddress[], input: AccessAddressInput): boolean {
  const onlyLoopback = list.every((item) => item.kind === 'current' && isLoopbackOrigin(item.url));
  return onlyLoopback && (input.addresses?.loopbackOnly ?? isLoopbackOrigin(input.origin));
}
