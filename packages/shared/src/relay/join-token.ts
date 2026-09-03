import { bytesToHex, decodeBase64url, encodeBase64url, hexToBytes } from '../auth/encoding';
import { canonicalHubUrl } from '../auth/hub-url';

export const RELAY_JOIN_TOKEN_PREFIX = 'r3.';
export const RELAY_JOIN_TOKEN_FIXED_BYTES = 176;
export const RELAY_JOIN_TOKEN_MAX_URLS = 16;
export const RELAY_JOIN_TOKEN_MAX_URL_LEN = 512;
export const RELAY_JOIN_TOKEN_CA_FINGERPRINT_CHARS = 64;

const CA_FINGERPRINT_HEX = /^[0-9a-f]{64}$/;
const TENANT_ID_HEX = /^[0-9a-f]{32}$/;
const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

export class RelayJoinTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayJoinTokenError';
  }
}

export type RelayJoinToken = {
  enrollSk: Uint8Array;
  rootPublicKey: Uint8Array;
  keyLogHeadHash: Uint8Array;
  /** K_log：解密中继上密钥日志记录的租户密钥。 */
  logKey: Uint8Array;
  /** 中继分配的租户编号，32 位小写 hex（16 字节）。 */
  tenantId: string;
  /** 租户令牌（32 字节原文，uplink 认证时按 b64url 上送）。 */
  token: Uint8Array;
  /** 有序 failover 的中继地址，至少一个。 */
  relayUrls: string[];
  caFingerprint?: string;
};

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/** 只认 https；回环地址允许 http（本机与测试）。 */
export function normalizeRelayUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new RelayJoinTokenError('relay url must be a non-empty string');
  }
  if (raw.length > RELAY_JOIN_TOKEN_MAX_URL_LEN) {
    throw new RelayJoinTokenError('relay url too long');
  }
  let canonical: string;
  try {
    canonical = canonicalHubUrl(raw);
  } catch (error) {
    throw new RelayJoinTokenError(error instanceof Error ? error.message : 'invalid relay url');
  }
  if (canonical.length > RELAY_JOIN_TOKEN_MAX_URL_LEN) {
    throw new RelayJoinTokenError('relay url too long');
  }
  const url = new URL(canonical);
  if (url.protocol === 'https:') return canonical;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return canonical;
  throw new RelayJoinTokenError('relay url must be https (http allowed for loopback only)');
}

function normalizeCaFingerprint(caFingerprint: string): string {
  const fingerprint = caFingerprint.toLowerCase();
  if (!CA_FINGERPRINT_HEX.test(fingerprint)) {
    throw new RelayJoinTokenError('CA fingerprint must be 64 hex characters');
  }
  return fingerprint;
}

function assert32(bytes: Uint8Array, field: string): Uint8Array {
  if (bytes.byteLength !== 32) {
    throw new RelayJoinTokenError(`${field} must be 32 bytes`);
  }
  return bytes;
}

function normalizeUrls(urls: readonly string[]): string[] {
  if (urls.length === 0) {
    throw new RelayJoinTokenError('relay join token needs at least one relay url');
  }
  if (urls.length > RELAY_JOIN_TOKEN_MAX_URLS) {
    throw new RelayJoinTokenError(`relay join token allows at most ${RELAY_JOIN_TOKEN_MAX_URLS}`);
  }
  return urls.map((url) => normalizeRelayUrl(url));
}

export function isRelayJoinToken(value: string): boolean {
  return typeof value === 'string' && value.startsWith(RELAY_JOIN_TOKEN_PREFIX);
}

/**
 * `"r3." + base64url(enroll_sk 32 ‖ root_pk 32 ‖ head_hash 32 ‖ K_log 32 ‖ tenant_id 16 ‖ token 32
 * ‖ n(u8) ‖ [len(u16 LE) ‖ url utf8]×n)`，可带 `.<64hex>` CA 指纹后缀。
 *
 * 拼接缓冲含 enroll_sk 与 K_log，返回前一定清零（与 fe 的 encodeJoinTokenZeroing 同规矩）。
 */
export function encodeRelayJoinToken(input: {
  enrollSk: Uint8Array;
  rootPublicKey: Uint8Array;
  keyLogHeadHash: Uint8Array;
  logKey: Uint8Array;
  tenantId: string;
  token: Uint8Array;
  relayUrls: readonly string[];
  caFingerprint?: string | null;
}): string {
  assert32(input.enrollSk, 'enrollSk');
  assert32(input.rootPublicKey, 'rootPublicKey');
  assert32(input.keyLogHeadHash, 'keyLogHeadHash');
  assert32(input.logKey, 'logKey');
  assert32(input.token, 'token');
  if (!TENANT_ID_HEX.test(input.tenantId)) {
    throw new RelayJoinTokenError('tenantId must be 32 lowercase hex characters');
  }
  const urls = normalizeUrls(input.relayUrls);
  const encoded = urls.map((url) => te.encode(url));
  const urlBytes = encoded.reduce((sum, bytes) => sum + 2 + bytes.byteLength, 0);
  const raw = new Uint8Array(RELAY_JOIN_TOKEN_FIXED_BYTES + 1 + urlBytes);
  try {
    raw.set(input.enrollSk, 0);
    raw.set(input.rootPublicKey, 32);
    raw.set(input.keyLogHeadHash, 64);
    raw.set(input.logKey, 96);
    raw.set(hexToBytes(input.tenantId), 128);
    raw.set(input.token, 144);
    raw[176] = urls.length;
    let offset = 177;
    const view = new DataView(raw.buffer);
    for (const bytes of encoded) {
      view.setUint16(offset, bytes.byteLength, true);
      raw.set(bytes, offset + 2);
      offset += 2 + bytes.byteLength;
    }
    const body = encodeBase64url(raw);
    if (!input.caFingerprint) return `${RELAY_JOIN_TOKEN_PREFIX}${body}`;
    return `${RELAY_JOIN_TOKEN_PREFIX}${body}.${normalizeCaFingerprint(input.caFingerprint)}`;
  } finally {
    raw.fill(0);
  }
}

function splitCaFingerprint(token: string): { body: string; caFingerprint?: string } {
  const dot = token.indexOf('.');
  if (dot === -1) return { body: token };
  const rest = token.slice(dot + 1);
  if (rest.includes('.')) {
    throw new RelayJoinTokenError('relay join token must have at most one CA fingerprint segment');
  }
  if (rest.length !== RELAY_JOIN_TOKEN_CA_FINGERPRINT_CHARS || !CA_FINGERPRINT_HEX.test(rest)) {
    throw new RelayJoinTokenError(
      'relay join token CA fingerprint must be 64 lowercase hex characters'
    );
  }
  return { body: token.slice(0, dot), caFingerprint: rest };
}

function decodeRelayUrls(raw: Uint8Array): string[] {
  const count = raw[RELAY_JOIN_TOKEN_FIXED_BYTES];
  if (count === 0) {
    throw new RelayJoinTokenError('relay join token needs at least one relay url');
  }
  if (count > RELAY_JOIN_TOKEN_MAX_URLS) {
    throw new RelayJoinTokenError(`relay join token allows at most ${RELAY_JOIN_TOKEN_MAX_URLS}`);
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const urls: string[] = [];
  let offset = RELAY_JOIN_TOKEN_FIXED_BYTES + 1;
  for (let i = 0; i < count; i++) {
    if (offset + 2 > raw.byteLength) {
      throw new RelayJoinTokenError('relay join token url table is truncated');
    }
    const len = view.getUint16(offset, true);
    if (len === 0 || len > RELAY_JOIN_TOKEN_MAX_URL_LEN) {
      throw new RelayJoinTokenError('relay join token url length out of range');
    }
    if (offset + 2 + len > raw.byteLength) {
      throw new RelayJoinTokenError('relay join token url table is truncated');
    }
    let text: string;
    try {
      text = td.decode(raw.subarray(offset + 2, offset + 2 + len));
    } catch {
      throw new RelayJoinTokenError('relay join token url is not valid utf-8');
    }
    urls.push(normalizeRelayUrl(text));
    offset += 2 + len;
  }
  if (offset !== raw.byteLength) {
    throw new RelayJoinTokenError('relay join token has trailing bytes');
  }
  return urls;
}

export function decodeRelayJoinToken(token: string): RelayJoinToken {
  if (!isRelayJoinToken(token)) {
    throw new RelayJoinTokenError(`relay join token must start with ${RELAY_JOIN_TOKEN_PREFIX}`);
  }
  const { body, caFingerprint } = splitCaFingerprint(token.slice(RELAY_JOIN_TOKEN_PREFIX.length));
  let raw: Uint8Array;
  try {
    raw = decodeBase64url(body);
  } catch {
    throw new RelayJoinTokenError('relay join token is not valid base64url');
  }
  if (raw.byteLength < RELAY_JOIN_TOKEN_FIXED_BYTES + 1) {
    throw new RelayJoinTokenError('relay join token is too short');
  }
  const urls = decodeRelayUrls(raw);
  return {
    enrollSk: raw.slice(0, 32),
    rootPublicKey: raw.slice(32, 64),
    keyLogHeadHash: raw.slice(64, 96),
    logKey: raw.slice(96, 128),
    tenantId: bytesToHex(raw.slice(128, 144)),
    token: raw.slice(144, 176),
    relayUrls: urls,
    ...(caFingerprint ? { caFingerprint } : {}),
  };
}
