import { parseTurnUri } from './ice';

export const STUN_MAGIC_COOKIE = 0x2112a442;
export const BINDING_REQUEST = 0x0001;
export const BINDING_SUCCESS = 0x0101;
export const BINDING_ERROR = 0x0111;
export const HEADER_SIZE = 20;
export const TXID_SIZE = 12;

const ATTR_MAPPED_ADDRESS = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const FAMILY_IPV4 = 0x01;
const FAMILY_IPV6 = 0x02;
const ICE_SCHEME_RE = /^(stuns?|turns?):/i;
const MAGIC_BYTES = Uint8Array.of(0x21, 0x12, 0xa4, 0x42);

export type StunTarget = { hostname: string; port: number };

export function iceSchemeOf(url: string): string | undefined {
  return ICE_SCHEME_RE.exec(url.trim())?.[0]?.toLowerCase();
}

export function parseStunTarget(url: string): StunTarget | null {
  if (iceSchemeOf(url) !== 'stun:') return null;
  const parsed = parseTurnUri(url);
  if (!parsed?.hostname || !Number.isFinite(parsed.port) || parsed.port <= 0) return null;
  return { hostname: parsed.hostname, port: parsed.port };
}

export function encodeBindingRequest(txid: Uint8Array): Uint8Array {
  const buf = new Uint8Array(HEADER_SIZE);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint16(0, BINDING_REQUEST);
  view.setUint16(2, 0);
  view.setUint32(4, STUN_MAGIC_COOKIE);
  buf.set(txid.subarray(0, TXID_SIZE), 8);
  return buf;
}

export function parseStunMappedAddress(msg: Uint8Array, txid: Uint8Array): string | null {
  if (stunMessageType(msg, txid) !== BINDING_SUCCESS) return null;
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const end = Math.min(msg.length, HEADER_SIZE + view.getUint16(2));
  let xorMapped: string | null = null;
  let mapped: string | null = null;
  let offset = HEADER_SIZE;
  while (offset + 4 <= end) {
    const type = view.getUint16(offset);
    const attrLen = view.getUint16(offset + 2);
    const valueStart = offset + 4;
    const valueEnd = valueStart + attrLen;
    if (valueEnd > end) break;
    const value = msg.subarray(valueStart, valueEnd);
    if (type === ATTR_XOR_MAPPED_ADDRESS) xorMapped = decodeMapped(value, txid, true);
    else if (type === ATTR_MAPPED_ADDRESS) mapped = decodeMapped(value, txid, false);
    offset = valueStart + ((attrLen + 3) & ~3);
  }
  return xorMapped ?? mapped;
}

export function stunMessageType(msg: Uint8Array, txid: Uint8Array): number | null {
  if (msg.length < HEADER_SIZE) return null;
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  if (view.getUint32(4) !== STUN_MAGIC_COOKIE) return null;
  for (let i = 0; i < TXID_SIZE; i++) {
    if (msg[8 + i] !== txid[i]) return null;
  }
  return view.getUint16(0);
}

export function or<T>(value: T | null | undefined, fallback: T): T {
  return value == null ? fallback : value;
}

function decodeMapped(value: Uint8Array, txid: Uint8Array, xor: boolean): string | null {
  if (value.length < 4) return null;
  const family = value[1];
  const rawPort = (or(value[2], 0) << 8) | or(value[3], 0);
  const port = xor ? rawPort ^ (STUN_MAGIC_COOKIE >>> 16) : rawPort;
  if (family === FAMILY_IPV4) return decodeMappedIpv4(value, port, xor);
  if (family !== FAMILY_IPV6 || value.length < 20) return null;
  return decodeMappedIpv6(value, txid, port, xor);
}

function decodeMappedIpv4(value: Uint8Array, port: number, xor: boolean): string | null {
  if (value.length < 8) return null;
  const parts = [0, 1, 2, 3].map((i) => {
    const raw = or(value[4 + i], 0);
    return xor ? raw ^ or(MAGIC_BYTES[i], 0) : raw;
  });
  return `${parts.join('.')}:${port}`;
}

function decodeMappedIpv6(value: Uint8Array, txid: Uint8Array, port: number, xor: boolean): string {
  const mask = xor ? Uint8Array.of(...MAGIC_BYTES, ...txid.subarray(0, TXID_SIZE)) : null;
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    const hi = or(value[4 + i * 2], 0);
    const lo = or(value[5 + i * 2], 0);
    const raw = (hi << 8) | lo;
    const xored = mask ? raw ^ (or(mask[i * 2], 0) << 8) ^ or(mask[i * 2 + 1], 0) : raw;
    groups.push(xored.toString(16));
  }
  const text = groups.map((part) => part.replace(/^0+(?=\w)/, '') || '0').join(':');
  let host = text;
  try {
    host = new URL(`http://[${text}]`).hostname.slice(1, -1);
  } catch {}
  return `[${host}]:${port}`;
}
