const CANONICAL_IPV4_OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export interface Ipv6Tokens {
  head: number[];
  tail: number[] | null;
}

export function stripIpv6Decorators(text: string): string {
  let host = text.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  const zoneIdx = host.indexOf('%');
  if (zoneIdx >= 0) {
    host = host.slice(0, zoneIdx);
  }
  return host;
}

function parseIpv4Octets(text: string): [number, number, number, number] | null {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((part) => CANONICAL_IPV4_OCTET.test(part))) {
    return null;
  }
  return [Number(parts[0]), Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

export function rewriteEmbeddedIpv4(host: string): string | null {
  const lastColon = host.lastIndexOf(':');
  const dotted = host.slice(lastColon + 1);
  if (!dotted.includes('.')) return host;
  const octets = parseIpv4Octets(dotted);
  if (!octets) return null;
  const hi = ((octets[0] << 8) | octets[1]).toString(16);
  const lo = ((octets[2] << 8) | octets[3]).toString(16);
  return `${host.slice(0, lastColon + 1)}${hi}:${lo}`;
}

function parseHexGroups(text: string): number[] | null {
  if (text.length === 0) return [];
  const tokens = text.split(':');
  const groups: number[] = [];
  for (const token of tokens) {
    if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
    groups.push(Number.parseInt(token, 16));
  }
  return groups;
}

function tokenizeUncompressed(text: string): Ipv6Tokens | null {
  const groups = parseHexGroups(text);
  if (!groups) return null;
  return { head: groups, tail: null };
}

function tokenizeCompressed(headText: string, tailText: string): Ipv6Tokens | null {
  const head = parseHexGroups(headText);
  const tail = parseHexGroups(tailText);
  if (!head || !tail) return null;
  return { head, tail };
}

export function tokenizeIpv6(host: string): Ipv6Tokens | null {
  if (!host.includes(':')) return null;
  const rewritten = rewriteEmbeddedIpv4(host);
  if (!rewritten) return null;
  const sides = rewritten.split('::');
  if (sides.length > 2) return null;
  if (sides.length === 1) return tokenizeUncompressed(sides[0] ?? '');
  return tokenizeCompressed(sides[0] ?? '', sides[1] ?? '');
}

function writeGroups(bytes: Uint8Array, groups: number[], offsetGroups: number): void {
  for (let i = 0; i < groups.length; i += 1) {
    const value = groups[i] ?? 0;
    const offset = (offsetGroups + i) * 2;
    bytes[offset] = value >> 8;
    bytes[offset + 1] = value & 0xff;
  }
}

export function assembleIpv6Bytes(tokens: Ipv6Tokens): Uint8Array | null {
  const bytes = new Uint8Array(16);
  if (tokens.tail === null) {
    if (tokens.head.length !== 8) return null;
    writeGroups(bytes, tokens.head, 0);
    return bytes;
  }
  const missing = 8 - tokens.head.length - tokens.tail.length;
  if (missing < 1) return null;
  writeGroups(bytes, tokens.head, 0);
  writeGroups(bytes, tokens.tail, 8 - tokens.tail.length);
  return bytes;
}
