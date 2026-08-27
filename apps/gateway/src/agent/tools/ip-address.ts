const CANONICAL_IPV4_OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function isCanonicalIpv4(host: string): boolean {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((part) => CANONICAL_IPV4_OCTET.test(part));
}

export function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function parseIpv4Octets(text: string): [number, number, number, number] | null {
  const parts = text.split('.');
  if (!isCanonicalIpv4(text)) return null;
  return [Number(parts[0]), Number(parts[1]), Number(parts[2]), Number(parts[3])];
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

export function parseIpv6ToBytes(text: string): Uint8Array | null {
  let host = text.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  const zoneIdx = host.indexOf('%');
  if (zoneIdx >= 0) {
    host = host.slice(0, zoneIdx);
  }
  if (!host.includes(':')) return null;

  const lastColon = host.lastIndexOf(':');
  const dotted = host.slice(lastColon + 1);
  if (dotted.includes('.')) {
    const octets = parseIpv4Octets(dotted);
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    host = `${host.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const sides = host.split('::');
  if (sides.length > 2) return null;

  const bytes = new Uint8Array(16);
  const writeGroups = (groups: number[], offsetGroups: number) => {
    for (let i = 0; i < groups.length; i += 1) {
      const value = groups[i] ?? 0;
      const offset = (offsetGroups + i) * 2;
      bytes[offset] = value >> 8;
      bytes[offset + 1] = value & 0xff;
    }
  };

  if (sides.length === 1) {
    const groups = parseHexGroups(sides[0] ?? '');
    if (!groups || groups.length !== 8) return null;
    writeGroups(groups, 0);
    return bytes;
  }

  const head = parseHexGroups(sides[0] ?? '');
  const tail = parseHexGroups(sides[1] ?? '');
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  writeGroups(head, 0);
  writeGroups(tail, 8 - tail.length);
  return bytes;
}

function isUnspecifiedOrLoopback(bytes: Uint8Array): boolean {
  for (let i = 0; i < 15; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return bytes[15] === 0 || bytes[15] === 1;
}

function isIpv4Mapped(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

export function isPrivateIpv6Bytes(bytes: Uint8Array): boolean {
  if (bytes.length !== 16) return false;
  if (isUnspecifiedOrLoopback(bytes)) return true;
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0x80) === 0x80) return true;
  if (isIpv4Mapped(bytes)) {
    return isPrivateIpv4(bytes[12] ?? 0, bytes[13] ?? 0);
  }
  return false;
}

export function isPrivateIpv6Hostname(hostname: string): boolean {
  const bytes = parseIpv6ToBytes(hostname);
  if (!bytes) return true;
  return isPrivateIpv6Bytes(bytes);
}
