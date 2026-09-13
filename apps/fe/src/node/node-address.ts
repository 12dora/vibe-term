// 节点表 ADDRESS 列：从 hub URL / 直连对端 / 广告 endpoint / 中继主机推导展示用 host。
// 纯函数，不读 store；缺值一律 `null`，由调用方换成 '—' / '-'。

import { type Translate, formatRelative } from '@/lib/format-relative';
import type { MeshNodeTransport } from '@vibeterm/api-client/auth/index';

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const IPV4_HOSTPORT_RE = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/;

export interface NodeAddressInput {
  isHub?: boolean;
  isSelf?: boolean;
  pending?: boolean;
  transport?: MeshNodeTransport | string | null;
  peerAddress?: string | null;
  endpoints?: readonly string[] | null;
  viaRelay?: string | null;
  relayPresence?: readonly string[] | null;
  hubPublicUrl?: string | null;
  selfAddress?: string | null;
}

export interface NodeReachInput {
  isSelf?: boolean;
  online?: boolean;
  pending?: boolean;
  reach?: string | null;
  transport?: string | null;
}

export type { Translate };

/** 剥 scheme / path，保留 host[:port]；解析失败则原样返回非空串。 */
export function displayHost(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const value = raw.trim();
  if (!value) return null;
  const url = parseAsUrl(value);
  if (!url?.hostname) return value;
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

/** 广告 endpoint：优先非局域网 host，否则第一项。 */
export function advertisedEndpointHost(
  endpoints: readonly string[] | null | undefined
): string | null {
  if (!endpoints?.length) return null;
  let fallback: string | null = null;
  for (const item of endpoints) {
    const host = displayHost(item);
    if (!host) continue;
    if (!fallback) fallback = host;
    if (!isLanDisplayHost(host)) return host;
  }
  return fallback;
}

/**
 * ADDRESS 优先级：hub publicUrl → 直连 peerAddress → 广告 endpoint（偏公网）
 * → 当前 viaRelay / relayPresence → self 本机 HTTPS/域名 → 空。
 */
export function deriveNodeAddress(input: NodeAddressInput): string | null {
  if (input.pending) return null;
  if (input.isHub) {
    const hub = displayHost(input.hubPublicUrl);
    if (hub) return hub;
  }
  return (
    liveDirectHost(input) ??
    advertisedEndpointHost(input.endpoints) ??
    relayHost(input) ??
    selfHost(input)
  );
}

function liveDirectHost(input: NodeAddressInput): string | null {
  const transport = input.transport;
  if (transport !== 'ws-secure' && transport !== 'dc') return null;
  return displayHost(input.peerAddress);
}

function relayHost(input: NodeAddressInput): string | null {
  if (input.transport === 'relay') {
    const via = displayHost(input.viaRelay);
    if (via) return via;
  }
  return displayHost(input.relayPresence?.[0]);
}

function selfHost(input: NodeAddressInput): string | null {
  if (!input.isSelf) return null;
  return displayHost(input.selfAddress);
}

/**
 * REACH 单元格：有链路时 `lan/dc`、`wan/ws-secure`；中转收成 `relay`。
 * self / 离线 / pending 返回 `null`（调用方画破折号）。
 */
export function nodeReachLabel(input: NodeReachInput): string | null {
  if (input.isSelf || input.pending || input.online === false) return null;
  const reach = input.reach ?? '';
  const transport = input.transport ?? '';
  if (!reach && !transport) return null;
  if (isRelayPath(reach, transport)) return 'relay';
  if (reach && transport) return `${reach}/${transport}`;
  return reach || transport || null;
}

function isRelayPath(reach: string, transport: string): boolean {
  if (reach === 'relay' && (!transport || transport === 'relay')) return true;
  return transport === 'relay' && (!reach || reach === 'relay');
}

/** 相对时间；`null` / 非正数返回 `null`，不出现负数。 */
export function nodeRelativeTime(
  t: Translate,
  at: number | null | undefined,
  now: number
): string | null {
  if (at == null || !Number.isFinite(at) || at <= 0) return null;
  return formatRelative(t, at, now, 'nodes.time');
}

function parseAsUrl(value: string): URL | null {
  try {
    if (SCHEME_RE.test(value)) return new URL(value);
    if (value.startsWith('[') || IPV4_HOSTPORT_RE.test(value) || !value.includes('://')) {
      return new URL(`https://${value}`);
    }
    return new URL(value);
  } catch {
    return null;
  }
}

function isLanDisplayHost(hostPort: string): boolean {
  const host = stripPort(hostPort)
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '::1') return true;
  return isLanIpv4(host) || isLanIpv6(host);
}

function stripPort(hostPort: string): string {
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']');
    return end >= 0 ? hostPort.slice(1, end) : hostPort;
  }
  const colon = hostPort.lastIndexOf(':');
  if (colon > 0 && hostPort.indexOf(':') === colon) return hostPort.slice(0, colon);
  return hostPort;
}

function isLanIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 169 && b === 254;
}

function isLanIpv6(host: string): boolean {
  if (!host.includes(':')) return false;
  if (host === '::1') return true;
  const head = host.split(':')[0] ?? '';
  const n = Number.parseInt(head, 16);
  if (!Number.isFinite(n)) return false;
  if ((n & 0xffc0) === 0xfe80) return true;
  return (n & 0xfe00) === 0xfc00;
}
