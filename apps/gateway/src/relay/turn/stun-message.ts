import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const MAGIC_COOKIE = 0x2112a442;
export const ATTR = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_ADDRESS_FAMILY: 0x0017,
  EVEN_PORT: 0x0018,
  REQUESTED_TRANSPORT: 0x0019,
  DONT_FRAGMENT: 0x001a,
  XOR_MAPPED_ADDRESS: 0x0020,
  RESERVATION_TOKEN: 0x0022,
  SOFTWARE: 0x8022,
  FINGERPRINT: 0x8028,
} as const;
export const METHOD = {
  BINDING: 1,
  ALLOCATE: 3,
  REFRESH: 4,
  SEND: 6,
  DATA: 7,
  CREATE_PERMISSION: 8,
  CHANNEL_BIND: 9,
} as const;
export const CLASS = { REQUEST: 0, INDICATION: 1, SUCCESS: 2, ERROR: 3 } as const;

export type StunAttribute = { type: number; value: Buffer; offset?: number };
export type StunMessage = {
  method: number;
  class: number;
  transactionId: Buffer;
  attributes: StunAttribute[];
  raw: Buffer;
};
export type StunAddress = { address: string; port: number };
export type EncodeMessageOptions = {
  method: number;
  class: number;
  transactionId?: Uint8Array;
  attributes?: readonly StunAttribute[];
  integrityKey?: Uint8Array;
  fingerprint?: boolean;
};

function decodeAttributes(raw: Buffer): StunAttribute[] | null {
  const attributes: StunAttribute[] = [];
  for (let offset = 20; offset < raw.length; ) {
    if (offset + 4 > raw.length) return null;
    const type = raw.readUInt16BE(offset);
    const length = raw.readUInt16BE(offset + 2);
    const end = offset + 4 + length;
    const next = offset + 4 + ((length + 3) & ~3);
    if (next > raw.length) return null;
    attributes.push({ type, value: raw.subarray(offset + 4, end), offset });
    offset = next;
  }
  return attributes;
}

export function decodeMessage(data: Uint8Array): StunMessage | null {
  if (data.length < 20 || data.length > 65535) return null;
  const raw = Buffer.from(data);
  const type = raw.readUInt16BE(0);
  const length = raw.readUInt16BE(2);
  if ((type & 0xc000) !== 0 || raw.readUInt32BE(4) !== MAGIC_COOKIE) return null;
  if ((length & 3) !== 0 || length + 20 !== raw.length) return null;
  const attributes = decodeAttributes(raw);
  if (!attributes) return null;
  return {
    method: (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2),
    class: ((type >> 4) & 1) | ((type >> 7) & 2),
    transactionId: raw.subarray(8, 20),
    attributes,
    raw,
  };
}

function encodeAttribute(attribute: StunAttribute): Buffer {
  const result = Buffer.alloc(4 + ((attribute.value.length + 3) & ~3));
  result.writeUInt16BE(attribute.type, 0);
  result.writeUInt16BE(attribute.value.length, 2);
  result.set(attribute.value, 4);
  return result;
}

function encodeHeader(options: EncodeMessageOptions, length: number): Buffer {
  const transactionId = options.transactionId ?? randomBytes(12);
  if (transactionId.length !== 12) throw new RangeError('STUN transaction ID must be 12 bytes');
  const method = options.method;
  const type =
    (method & 0x0f) |
    ((method & 0x70) << 1) |
    ((method & 0xf80) << 2) |
    ((options.class & 1) << 4) |
    ((options.class & 2) << 7);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  header.set(transactionId, 8);
  return header;
}

export function encodeMessage(options: EncodeMessageOptions): Buffer {
  const attributes = (options.attributes ?? []).filter(
    (attribute) => attribute.type !== ATTR.MESSAGE_INTEGRITY && attribute.type !== ATTR.FINGERPRINT
  );
  const body = Buffer.concat(attributes.map(encodeAttribute));
  const integritySize = options.integrityKey ? 24 : 0;
  const fingerprintSize = options.fingerprint === false ? 0 : 8;
  const result = Buffer.concat([
    encodeHeader(options, body.length + integritySize + fingerprintSize),
    body,
    Buffer.alloc(integritySize + fingerprintSize),
  ]);
  if (options.integrityKey) {
    const offset = 20 + body.length;
    result.writeUInt16BE(ATTR.MESSAGE_INTEGRITY, offset);
    result.writeUInt16BE(20, offset + 2);
    result.set(integrityDigest(result, offset, options.integrityKey), offset + 4);
  }
  if (fingerprintSize) {
    const offset = result.length - 8;
    result.writeUInt16BE(ATTR.FINGERPRINT, offset);
    result.writeUInt16BE(4, offset + 2);
    result.writeUInt32BE(fingerprint(result.subarray(0, offset)), offset + 4);
  }
  return result;
}

function integrityDigest(raw: Buffer, offset: number, key: Uint8Array): Buffer {
  const signed = Buffer.from(raw.subarray(0, offset));
  // HMAC 不包含属性自身，但报头长度必须包含 MESSAGE-INTEGRITY。
  signed.writeUInt16BE(offset + 24 - 20, 2);
  return createHmac('sha1', key).update(signed).digest();
}

export function longTermKey(username: string, realm: string, password: string): Buffer {
  return createHash('md5').update(`${username}:${realm}:${password}`, 'utf8').digest();
}

export function verifyIntegrity(message: StunMessage, key: Uint8Array): boolean {
  const attributes = message.attributes.filter(
    (attribute) => attribute.type === ATTR.MESSAGE_INTEGRITY
  );
  const integrity = attributes[0];
  if (attributes.length !== 1 || !integrity || integrity.value.length !== 20) return false;
  if (integrity.offset === undefined) return false;
  return timingSafeEqual(integrity.value, integrityDigest(message.raw, integrity.offset, key));
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function fingerprint(data: Uint8Array): number {
  return (crc32(data) ^ 0x5354554e) >>> 0;
}

export function verifyFingerprint(message: StunMessage): boolean {
  const attributes = message.attributes.filter((attribute) => attribute.type === ATTR.FINGERPRINT);
  if (attributes.length === 0) return true;
  const attribute = attributes[0];
  if (attributes.length !== 1 || !attribute || attribute.value.length !== 4) return false;
  if (attribute.offset !== message.raw.length - 8) return false;
  return attribute.value.readUInt32BE(0) === fingerprint(message.raw.subarray(0, attribute.offset));
}

export function getAttributes(message: StunMessage, type: number): Buffer[] {
  const values: Buffer[] = [];
  for (const attribute of message.attributes) {
    if (attribute.type === type) values.push(attribute.value);
    // MESSAGE-INTEGRITY 后的普通属性不受认证保护，不能参与业务处理。
    if (attribute.type === ATTR.MESSAGE_INTEGRITY) break;
  }
  return values;
}

export function getAttribute(message: StunMessage, type: number): Buffer | undefined {
  return getAttributes(message, type)[0];
}

export function textAttribute(type: number, text: string): StunAttribute {
  return { type, value: Buffer.from(text, 'utf8') };
}

export function uint32Attribute(type: number, value: number): StunAttribute {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return { type, value: bytes };
}

export function errorAttribute(code: number, reason: string): StunAttribute {
  const value = Buffer.alloc(4 + Buffer.byteLength(reason));
  value[2] = Math.floor(code / 100);
  value[3] = code % 100;
  value.write(reason, 4);
  return { type: ATTR.ERROR_CODE, value };
}

function ipv6Bytes(address: string): Buffer {
  const segments = address.split('::');
  const left = ipv6Words(segments[0]);
  const right = ipv6Words(segments[1] ?? '');
  const words = [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  const bytes = Buffer.alloc(16);
  words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2));
  return bytes;
}

function ipv6Words(part: string): number[] {
  if (!part) return [];
  return part.split(':').flatMap((word) => {
    if (!word.includes('.')) return [Number.parseInt(word, 16)];
    const bytes = word.split('.').map(Number);
    return [(bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]];
  });
}

function addressMask(transactionId: Uint8Array): Buffer {
  if (transactionId.length !== 12) throw new RangeError('STUN transaction ID must be 12 bytes');
  const mask = Buffer.alloc(16);
  mask.writeUInt32BE(MAGIC_COOKIE);
  mask.set(transactionId, 4);
  return mask;
}

export function addressAttribute(
  type: number,
  peer: StunAddress,
  transactionId: Uint8Array
): StunAttribute {
  const family = isIP(peer.address);
  if (!family) throw new TypeError('STUN address must be an IP literal');
  const bytes =
    family === 4 ? Buffer.from(peer.address.split('.').map(Number)) : ipv6Bytes(peer.address);
  const value = Buffer.alloc(bytes.length + 4);
  value[1] = family === 4 ? 1 : 2;
  value.writeUInt16BE(peer.port ^ (MAGIC_COOKIE >>> 16), 2);
  const mask = addressMask(transactionId);
  for (let index = 0; index < bytes.length; index++) value[index + 4] = bytes[index] ^ mask[index];
  return { type, value };
}

export function decodeAddress(value: Uint8Array, transactionId: Uint8Array): StunAddress | null {
  if (transactionId.length !== 12 || value.length < 4 || value[0] !== 0) return null;
  const family = value[1];
  if (family !== 1 && family !== 2) return null;
  if (value.length !== (family === 1 ? 8 : 20)) return null;
  const bytes = Buffer.from(value);
  const port = bytes.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16);
  const mask = addressMask(transactionId);
  const ip = bytes.subarray(4);
  for (let index = 0; index < ip.length; index++) ip[index] ^= mask[index];
  const address = family === 1 ? [...ip].join('.') : formatIpv6(ip);
  return { address, port };
}

function formatIpv6(bytes: Buffer): string {
  const words = Array.from({ length: 8 }, (_, index) => bytes.readUInt16BE(index * 2).toString(16));
  const raw = words.join(':');
  // URL 的 IPv6 序列化采用最长连续零段压缩，统一所有地址的字符串表示。
  return new URL(`http://[${raw}]/`).hostname.slice(1, -1);
}

export function requestedTransportAttribute(protocol = 17): StunAttribute {
  const value = Buffer.alloc(4);
  value[0] = protocol;
  return { type: ATTR.REQUESTED_TRANSPORT, value };
}

export function channelNumberAttribute(channel: number): StunAttribute {
  const value = Buffer.alloc(4);
  value.writeUInt16BE(channel);
  return { type: ATTR.CHANNEL_NUMBER, value };
}

export function decodeErrorCode(value: Uint8Array): { code: number; reason: string } | null {
  if (value.length < 4) return null;
  return {
    code: value[2] * 100 + value[3],
    reason: Buffer.from(value.subarray(4)).toString('utf8'),
  };
}

export function isChannelData(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] >= 0x40 && data[0] <= 0x7f;
}

export function encodeChannelData(channel: number, data: Uint8Array): Buffer {
  if (channel < 0x4000 || channel > 0x7fff) throw new RangeError('Invalid TURN channel');
  const result = Buffer.alloc(4 + data.length);
  result.writeUInt16BE(channel, 0);
  result.writeUInt16BE(data.length, 2);
  result.set(data, 4);
  return result;
}

export function decodeChannelData(data: Uint8Array): { channel: number; data: Buffer } | null {
  if (data.length < 4 || data.length > 65535) return null;
  const raw = Buffer.from(data);
  const channel = raw.readUInt16BE(0);
  const length = raw.readUInt16BE(2);
  if (channel < 0x4000 || channel > 0x7fff || length + 4 > raw.length) return null;
  if (raw.length > 4 + ((length + 3) & ~3)) return null;
  return { channel, data: raw.subarray(4, 4 + length) };
}
