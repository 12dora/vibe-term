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
  const w = parseIpv6(host);
  if (!w) return false;
  const w0 = w[0] ?? 0;
  const isLoopback = w.slice(0, 7).every((x) => x === 0) && (w[7] ?? 0) === 1;
  if (isLoopback) return true;
  if ((w0 & 0xffc0) === 0xfe80) return true;
  if ((w0 & 0xfe00) === 0xfc00) return true;
  return false;
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

function parseIpv6(host: string): number[] | null {
  if (host.includes('.')) return null;
  const compressed = host.split('::');
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
