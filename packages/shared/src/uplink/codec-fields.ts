import { decodeBase64url, encodeBase64url } from '../auth/encoding';

export const UPLINK_CTL_TYPES = [
  'auth.challenge',
  'auth.response',
  'auth.ok',
  'ping',
  'pong',
  'node.status',
  'node.list',
  'key.log.req',
  'key.log.res',
  'key.log.append',
  'key.log.ack',
  'rtc.signal',
  'enroll.redeemed',
  'hub.tokens',
  'hub.attachments',
  'hub.forward',
  'hub.write-forward',
] as const;

export type UplinkCtlType = (typeof UPLINK_CTL_TYPES)[number];

export const TYPE_SET = new Set<string>(UPLINK_CTL_TYPES);
const te = new TextEncoder();
const td = new TextDecoder();
const NODE_ID_HEX = /^[0-9a-f]{32}$/i;

export const UPLINK_CTL_MAX_BYTES = 64 * 1024;
export const UPLINK_CTL_MAX_DEPTH = 8;
export const UPLINK_CTL_MAX_ARRAY_LEN = 1024;
export const UPLINK_CTL_MAX_STRING_LEN = 4 * 1024;
export const UPLINK_CTL_MAX_ENDPOINTS = 32;
export const UPLINK_CTL_MAX_HUBS = 16;
export const UPLINK_CTL_MAX_HUB_URL_LEN = 512;
export const UPLINK_CTL_MAX_CERT_BYTES = 2048;
export const UPLINK_CTL_MAX_U64 = 18446744073709551615n;
export const MIN_HUB_TOKENS_VERSION = '1.1.13';
export const UPLINK_CTL_MAX_ATTACHMENT_ENTRIES = 256;
export const HUB_ATTACHMENTS_FRAME_MAX_BYTES = 48 * 1024;
export const HUB_WRITE_FORWARD_FRAME_MAX_BYTES = 48 * 1024;
export const TMEX_FORWARDED_BY_HEADER = 'X-Tmex-Forwarded-By';
export const UPLINK_CTL_MAX_TOKEN_JSON_LEN = 16 * 1024;
export const KEY_LOG_PAGE_DEFAULT_LIMIT = 256;
export const KEY_LOG_PAGE_MAX_LIMIT = 256;
export const KEY_LOG_PAGE_MAX_BYTES = 1024 * 1024;

export type HubMode = 'active' | 'standby';
export type RtcSignalFrom = 'browser' | 'node';
export type EncodeUplinkCtlOptions = { legacy?: boolean };

export function skipsCtlBounds(t: unknown): boolean {
  return (
    t === 'key.log.res' ||
    t === 'hub.tokens' ||
    t === 'hub.attachments' ||
    t === 'hub.forward' ||
    t === 'hub.write-forward'
  );
}

export class UplinkCtlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UplinkCtlError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function encodeJsonBytes(value: unknown): Uint8Array {
  return te.encode(JSON.stringify(value));
}

export function decodeJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(td.decode(bytes));
}

export function utf8ByteLength(text: string): number {
  return te.encode(text).byteLength;
}

export function decodeUtf8(bytes: Uint8Array): string {
  return td.decode(bytes);
}

export function seqToWire(seq: bigint | number): number | string {
  const value = typeof seq === 'bigint' ? seq : BigInt(seq);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

export function seqFromWire(value: number | string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new UplinkCtlError('invalid seq');
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value)) {
    throw new UplinkCtlError('invalid seq');
  }
  const n = BigInt(value);
  if (n > UPLINK_CTL_MAX_U64) throw new UplinkCtlError('invalid seq');
  return n;
}

export function bytesToB64url(bytes: Uint8Array): string {
  return encodeBase64url(bytes);
}

export function b64urlToBytes(value: string, expectedLen?: number): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) throw new UplinkCtlError('invalid b64url');
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64url(value);
  } catch {
    throw new UplinkCtlError('invalid b64url');
  }
  if (expectedLen !== undefined && bytes.byteLength !== expectedLen) {
    throw new UplinkCtlError(`expected ${expectedLen} bytes`);
  }
  return bytes;
}

export function assertCtlBounds(value: unknown, depth = 0): void {
  if (depth > UPLINK_CTL_MAX_DEPTH) throw new Error('ctl too deep');
  if (typeof value === 'string' && value.length > UPLINK_CTL_MAX_STRING_LEN) {
    throw new Error('ctl string too long');
  }
  if (Array.isArray(value)) {
    if (value.length > UPLINK_CTL_MAX_ARRAY_LEN) throw new Error('ctl array too long');
    for (const item of value) assertCtlBounds(item, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      assertCtlBounds(item, depth + 1);
    }
  }
}

type CtlFailKind =
  | 'string'
  | 'nonEmpty'
  | 'boolean'
  | 'number'
  | 'integer'
  | 'nonNegInt'
  | 'posInt'
  | 'seq'
  | 'nodeId'
  | 'bytes'
  | 'hubMode'
  | 'httpUrl'
  | 'tooLong'
  | 'invalid';

/** 两条线共用同一套读取器，只有报错文案不同：mesh 抛裸 Error，hub 抛 UplinkCtlError。 */
export type CtlFail = (field: string, kind: CtlFailKind, detail?: string) => Error;

const CTL_EXPECT: Record<CtlFailKind, string> = {
  string: 'must be a string',
  nonEmpty: 'must be a non-empty string',
  boolean: 'must be a boolean',
  number: 'must be a number',
  integer: 'must be an integer',
  nonNegInt: 'must be a non-negative integer',
  posInt: 'must be a positive integer',
  seq: 'must be a seq',
  nodeId: 'must be 32-hex',
  bytes: 'has an unexpected byte length',
  hubMode: 'must be active|standby',
  httpUrl: 'must be an http(s) URL',
  tooLong: 'too long',
  invalid: 'is invalid',
};

const ctlFail: CtlFail = (field, kind, detail) => {
  if (kind === 'bytes') return new Error(`ctl field ${field} expected ${detail} bytes`);
  if (kind === 'tooLong') return new Error(`ctl field ${field} too long`);
  return new Error(`ctl field ${field} ${CTL_EXPECT[kind]}`);
};

const HUB_MISSING_KINDS = new Set<CtlFailKind>(['string', 'boolean']);

const hubFail: CtlFail = (field, kind) => {
  if (kind === 'nonEmpty') return new UplinkCtlError(`empty ${field}`);
  if (HUB_MISSING_KINDS.has(kind)) return new UplinkCtlError(`missing ${field}`);
  return new UplinkCtlError(`invalid ${field}`);
};

export type CtlReaders = {
  str(value: unknown, field: string): string;
  optStr(value: unknown, field: string): string | undefined;
  optNullStr(value: unknown, field: string): string | null | undefined;
  nonEmptyStr(value: unknown, field: string): string;
  bool(value: unknown, field: string): boolean;
  num(value: unknown, field: string): number;
  int(value: unknown, field: string): number;
  nonNegInt(value: unknown, field: string): number;
  posInt(value: unknown, field: string): number;
  /** mesh 线上 seq 用 bigint 表示。 */
  seq(value: unknown, field: string): bigint;
  /** hub 线上 seq 保留 number|string 原始表示，只做合法性校验。 */
  seqWire(value: unknown, field: string): number | string;
  b64(value: unknown, field: string, expectedLen?: number): Uint8Array;
  nodeId(value: unknown, field: string): string;
  hubMode(value: unknown, field: string): HubMode;
  httpUrl(value: unknown, field: string): string;
  fail: CtlFail;
};

export function createCtlReaders(fail: CtlFail): CtlReaders {
  const str = (value: unknown, field: string): string => {
    if (typeof value !== 'string') throw fail(field, 'string');
    return value;
  };
  const num = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw fail(field, 'number');
    return value;
  };
  const nonEmptyStr = (value: unknown, field: string): string => {
    const text = str(value, field);
    if (text.length === 0) throw fail(field, 'nonEmpty');
    return text;
  };
  return {
    str,
    num,
    nonEmptyStr,
    fail,
    optStr(value, field) {
      if (value === undefined || value === null) return undefined;
      return str(value, field);
    },
    optNullStr(value, field) {
      if (value === undefined) return undefined;
      if (value === null) return null;
      return str(value, field);
    },
    bool(value, field) {
      if (typeof value !== 'boolean') throw fail(field, 'boolean');
      return value;
    },
    int(value, field) {
      if (typeof value !== 'number' || !Number.isInteger(value)) throw fail(field, 'integer');
      return value;
    },
    nonNegInt(value, field) {
      const n = num(value, field);
      if (!Number.isInteger(n) || n < 0) throw fail(field, 'nonNegInt');
      return n;
    },
    posInt(value, field) {
      const n = num(value, field);
      if (!Number.isInteger(n) || n < 1) throw fail(field, 'posInt');
      return n;
    },
    seq(value, field) {
      if (typeof value === 'bigint') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
      if (typeof value === 'string' && value !== '') return BigInt(value);
      throw fail(field, 'seq');
    },
    seqWire(value, field) {
      if (typeof value !== 'number' && typeof value !== 'string') throw fail(field, 'seq');
      seqFromWire(value);
      return value;
    },
    b64(value, field, expectedLen) {
      const bytes = decodeBase64url(str(value, field));
      if (expectedLen !== undefined && bytes.byteLength !== expectedLen) {
        throw fail(field, 'bytes', String(expectedLen));
      }
      return bytes;
    },
    nodeId(value, field) {
      const id = nonEmptyStr(value, field);
      if (!NODE_ID_HEX.test(id)) throw fail(field, 'nodeId');
      return id.toLowerCase();
    },
    hubMode(value, field) {
      if (value !== 'active' && value !== 'standby') throw fail(field, 'hubMode');
      return value;
    },
    httpUrl(value, field) {
      const raw = str(value, field);
      if (raw.length > UPLINK_CTL_MAX_HUB_URL_LEN) throw fail(field, 'tooLong');
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw fail(field, 'httpUrl');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail(field, 'httpUrl');
      return raw;
    },
  };
}

/** mesh 解码器与跨线共享结构解析共用：报错文案为 `ctl field <字段> ...`。 */
export const ctlRead = createCtlReaders(ctlFail);
/** hub 解码器专用：报错文案为 `missing/empty/invalid <字段>`，且类型为 UplinkCtlError。 */
export const hubRead = createCtlReaders(hubFail);
