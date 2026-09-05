import type { ShareOriginCandidate, ShareOriginKind } from './types';

const KIND_PRIORITY: Record<ShareOriginKind, number> = {
  custom: 0,
  site: 1,
  hub: 2,
  relay: 3,
  tunnel: 4,
  ip: 5,
};

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_MAPPED_RE = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function parseIpv4(host: string): number[] | null {
  const match = host.match(IPV4_RE);
  if (!match) return null;
  const octets = match.slice(1, 5).map((part) => Number(part));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return octets;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  if (a === 0 || a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv6Words(host: string): number[] | null {
  if (!host.includes(':')) return null;
  const [head = '', tail] = host.split('::', 2);
  const toWords = (part: string): number[] | null => {
    if (!part) return [];
    const words: number[] = [];
    for (const chunk of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(chunk)) return null;
      words.push(Number.parseInt(chunk, 16));
    }
    return words;
  };
  const left = toWords(head);
  if (!left) return null;
  if (tail === undefined) return left.length === 8 ? left : null;
  const right = toWords(tail);
  if (!right) return null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  return [...left, ...new Array<number>(fill).fill(0), ...right];
}

function mappedIpv4FromWords(words: number[]): number[] | null {
  if (!words.slice(0, 5).every((word) => word === 0)) return null;
  if (words[5] !== 0xffff) return null;
  const hi = words[6] ?? 0;
  const lo = words[7] ?? 0;
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

function isPrivateIpv6(host: string): boolean {
  const words = parseIpv6Words(host);
  if (!words) return false;
  const mapped = mappedIpv4FromWords(words);
  if (mapped) return isPrivateIpv4(mapped);
  const first = words[0] ?? 0;
  if (words.every((word) => word === 0)) return true;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xffc0) === 0xfec0) return true;
  return false;
}

function normalizeHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone >= 0) host = host.slice(0, zone);
  if (host.length > 1 && host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function isPublicHost(hostRaw: string): boolean {
  const host = normalizeHost(hostRaw);
  if (!host) return false;
  const mapped = host.match(IPV4_MAPPED_RE)?.[1];
  const ipv4 = parseIpv4(mapped ?? host);
  if (ipv4) return !isPrivateIpv4(ipv4);
  if (host.includes(':')) return !isPrivateIpv6(host);
  if (host === 'localhost') return false;
  if (host.endsWith('.local') || host.endsWith('.localhost')) return false;
  if (host.endsWith('.internal') || host.endsWith('.home.arpa')) return false;
  return host.includes('.');
}

/** 只接受 http(s) 且主机名可从公网访问的 origin。 */
export function isPublicShareOrigin(url: string): boolean {
  const parsed = parseOrigin(url);
  return parsed !== null && isPublicHost(parsed.hostname);
}

function parseOrigin(url: string): URL | null {
  const raw = url.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function normalizeShareOrigin(url: string): string | null {
  const parsed = parseOrigin(url);
  if (!parsed) return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}

/** 按 kind 预设优先级排序并过滤掉非公网地址；同 kind 保持传入顺序，重复地址去重。 */
export function rankShareOrigins(candidates: ShareOriginCandidate[]): ShareOriginCandidate[] {
  const seen = new Set<string>();
  const kept: Array<{ candidate: ShareOriginCandidate; index: number }> = [];
  candidates.forEach((candidate, index) => {
    const normalized = normalizeShareOrigin(candidate.url);
    if (!normalized || !isPublicShareOrigin(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    kept.push({ candidate: { ...candidate, url: normalized }, index });
  });
  kept.sort((left, right) => {
    const delta = KIND_PRIORITY[left.candidate.kind] - KIND_PRIORITY[right.candidate.kind];
    return delta !== 0 ? delta : left.index - right.index;
  });
  return kept.map((entry) => entry.candidate);
}
