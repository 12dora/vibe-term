import { assembleIpv6Bytes, stripIpv6Decorators, tokenizeIpv6 } from './ipv6-parse';

export { assembleIpv6Bytes, tokenizeIpv6 };

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

export function parseIpv6ToBytes(text: string): Uint8Array | null {
  const host = stripIpv6Decorators(text);
  const tokens = tokenizeIpv6(host);
  if (!tokens) return null;
  return assembleIpv6Bytes(tokens);
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
