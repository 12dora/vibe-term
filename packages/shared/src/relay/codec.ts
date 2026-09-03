import { decodeBase64url, encodeBase64url } from '../auth/encoding';
import type { RelayEnvelope } from './tenant-cipher';

export const RELAY_PROTO_VERSION = 1;
export const MIN_RELAY_CLIENT_VERSION = '1.1.23';

export const RELAY_CTL_TYPES = [
  'auth.challenge',
  'relay.auth',
  'auth.ok',
  'ping',
  'pong',
  'relay.status',
  'relay.list',
  'relay.keylog.append',
  'relay.keylog.ack',
  'relay.keylog.req',
  'relay.keylog.res',
  'relay.keylog.push',
  'relay.rtc',
  'relay.enroll.create',
  'relay.enroll.ack',
  'enroll.redeemed',
  'relay.quota',
  'relay.kicked',
] as const;
export type RelayCtlType = (typeof RELAY_CTL_TYPES)[number];

const TYPE_SET = new Set<string>(RELAY_CTL_TYPES);
const te = new TextEncoder();
const td = new TextDecoder();
const HEX_16 = /^[0-9a-f]{32}$/;

export const RELAY_CTL_MAX_BYTES = 64 * 1024;
export const RELAY_CTL_MAX_DEPTH = 8;
export const RELAY_CTL_MAX_ARRAY_LEN = 1024;
/** 单个字符串的兜底上限：帧本身就 ≤64 KiB，具体字段各有更紧的限制。 */
export const RELAY_CTL_MAX_STRING_LEN = 48 * 1024;
export const RELAY_CTL_MAX_SHORT_STRING_LEN = 512;
export const RELAY_CTL_MAX_NODES = 256;
export const RELAY_CTL_MAX_STUN = 8;
export const RELAY_CTL_MAX_CERT_BYTES = 2048;
export const RELAY_CTL_MAX_MEMBER_BYTES = 8 * 1024;
/** 签名字段上限：根签名恒 64 B，passkey 签名是变长 Borsh `PasskeyAssertion`。 */
export const RELAY_CTL_MAX_SIG_BYTES = 4 * 1024;
export const RELAY_KEYLOG_PAGE_DEFAULT_LIMIT = 32;
export const RELAY_KEYLOG_PAGE_MAX_LIMIT = 64;
export const RELAY_CTL_MAX_U64 = 18446744073709551615n;
export const RELAY_KEYLOG_SEQ_MISMATCH = 'SEQ_MISMATCH';

export class RelayCtlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayCtlError';
  }
}

export type RelaySeqWire = number | string;
export type RelayTurnConfig = { url: string; username: string; credential: string };
export type RelayRtcConfig = { stun: string[]; turn: RelayTurnConfig | null };
export type RelayNodeStatus = 'pending' | 'admitted' | 'revoked';
export type RelayKickReason = 'password_rotated' | 'kicked' | 'revoked';
export type RelayRtcFrom = 'browser' | 'node';
export type RelayMemberProof = { bytes: string; sig: string };
export type RelayKeylogMemberOp = 'admit' | 'revoke' | 'rotate-root';
export type RelayKeylogMember = { op: RelayKeylogMemberOp; bytes: string; sig: string };
export type RelayQuota = {
  maxNodes: number;
  maxStreams: number;
  bandwidthBytesPerSec: number | null;
};
export type RelayListNode = {
  id: string;
  online: boolean;
  status: RelayNodeStatus;
  epoch?: number;
  blob?: RelayEnvelope;
};
export type RelayKeyLogRecordWire = { seq: RelaySeqWire; blob: RelayEnvelope };

export type RelayCtlMessage =
  | { t: 'auth.challenge'; nonce: string }
  | {
      t: 'relay.auth';
      tenant_id: string;
      token: string;
      node_id: string;
      sig: string;
      proto: number;
      client_version: string;
      member?: RelayMemberProof;
    }
  | { t: 'auth.ok'; tenant_id: string; key_log_head_seq: RelaySeqWire; rtc: RelayRtcConfig }
  | { t: 'ping' }
  | { t: 'pong' }
  | { t: 'relay.status'; blob: RelayEnvelope; epoch: number }
  | {
      t: 'relay.list';
      version: number;
      nodes: RelayListNode[];
      rtc: RelayRtcConfig;
      key_log_head_seq: RelaySeqWire;
    }
  | {
      t: 'relay.keylog.append';
      id: string;
      seq: RelaySeqWire;
      blob: RelayEnvelope;
      member?: RelayKeylogMember;
    }
  | {
      t: 'relay.keylog.ack';
      id: string;
      ok: boolean;
      seq?: RelaySeqWire;
      error?: string;
      head?: RelaySeqWire;
      member_ignored?: boolean;
      /** 成员明文被丢弃的原因（诊断用；日志本身照旧落库）。 */
      member_error?: string;
    }
  | { t: 'relay.keylog.req'; from_seq: RelaySeqWire; limit?: number }
  | { t: 'relay.keylog.res'; records: RelayKeyLogRecordWire[]; has_more?: boolean }
  | { t: 'relay.keylog.push'; records: RelayKeyLogRecordWire[]; has_more?: boolean }
  | { t: 'relay.rtc'; rtcSession: string; from: RelayRtcFrom; to: string; enc: RelayEnvelope }
  | {
      t: 'relay.enroll.create';
      id: string;
      enroll_pk: string;
      authorization: string;
      authorization_sig: string;
      exp: number;
    }
  | { t: 'relay.enroll.ack'; id: string; ok: boolean; error?: string }
  | {
      t: 'enroll.redeemed';
      certificate: string;
      cert_sig: string;
      enroll_pk: string;
      node_id: string;
    }
  | ({ t: 'relay.quota' } & RelayQuota)
  | { t: 'relay.kicked'; reason: RelayKickReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new RelayCtlError(message);
}

function assertBounds(value: unknown, depth: number): void {
  if (depth > RELAY_CTL_MAX_DEPTH) fail('ctl too deep');
  if (typeof value === 'string' && value.length > RELAY_CTL_MAX_STRING_LEN) {
    fail('ctl string too long');
  }
  if (Array.isArray(value)) {
    if (value.length > RELAY_CTL_MAX_ARRAY_LEN) fail('ctl array too long');
    for (const item of value) assertBounds(item, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) assertBounds(item, depth + 1);
  }
}

function str(obj: Record<string, unknown>, key: string, max = RELAY_CTL_MAX_SHORT_STRING_LEN) {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) fail(`invalid ${key}`);
  if (value.length > max) fail(`${key} too long`);
  return value;
}

function optStr(
  obj: Record<string, unknown>,
  key: string,
  max = RELAY_CTL_MAX_SHORT_STRING_LEN
): string | undefined {
  if (obj[key] === undefined || obj[key] === null) return undefined;
  return str(obj, key, max);
}

function bool(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') fail(`invalid ${key}`);
  return value;
}

function optBool(obj: Record<string, unknown>, key: string): boolean | undefined {
  if (obj[key] === undefined || obj[key] === null) return undefined;
  return bool(obj, key);
}

function uint(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(`invalid ${key}`);
  return value;
}

function optUint(obj: Record<string, unknown>, key: string): number | undefined {
  if (obj[key] === undefined || obj[key] === null) return undefined;
  return uint(obj, key);
}

export function relaySeqToWire(seq: bigint | number): RelaySeqWire {
  const value = typeof seq === 'bigint' ? seq : BigInt(seq);
  if (value < 0n || value > RELAY_CTL_MAX_U64) fail('invalid seq');
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

export function relaySeqFromWire(value: RelaySeqWire): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid seq');
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value)) fail('invalid seq');
  const seq = BigInt(value);
  if (seq > RELAY_CTL_MAX_U64) fail('invalid seq');
  return seq;
}

function seq(obj: Record<string, unknown>, key: string): RelaySeqWire {
  const value = obj[key];
  if (typeof value !== 'number' && typeof value !== 'string') fail(`invalid ${key}`);
  relaySeqFromWire(value);
  return value;
}

function optSeq(obj: Record<string, unknown>, key: string): RelaySeqWire | undefined {
  if (obj[key] === undefined || obj[key] === null) return undefined;
  return seq(obj, key);
}

function b64(
  obj: Record<string, unknown>,
  key: string,
  expectedLen?: number,
  maxLen = RELAY_CTL_MAX_CERT_BYTES
): string {
  const value = str(obj, key, RELAY_CTL_MAX_STRING_LEN);
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64url(value);
  } catch {
    fail(`invalid ${key}`);
  }
  if (expectedLen !== undefined && bytes.byteLength !== expectedLen) fail(`invalid ${key}`);
  if (bytes.byteLength > maxLen) fail(`${key} too large`);
  return encodeBase64url(bytes);
}

function hexId(obj: Record<string, unknown>, key: string): string {
  const value = str(obj, key, 32);
  if (!HEX_16.test(value)) fail(`invalid ${key}`);
  return value;
}

function envelope(obj: Record<string, unknown>, key: string): RelayEnvelope {
  const value = obj[key];
  if (!isRecord(value)) fail(`invalid ${key}`);
  if (value.v !== 1) fail(`invalid ${key}.v`);
  const epoch = optUint(value, 'epoch');
  const env: RelayEnvelope = {
    v: 1,
    ...(epoch !== undefined ? { epoch } : {}),
    n: b64(value, 'n', 12),
    ct: b64(value, 'ct', undefined, RELAY_CTL_MAX_BYTES),
  };
  return env;
}

function rtcConfig(obj: Record<string, unknown>, key: string): RelayRtcConfig {
  const value = obj[key];
  if (!isRecord(value)) fail(`invalid ${key}`);
  const stun = value.stun;
  if (!Array.isArray(stun) || stun.length > RELAY_CTL_MAX_STUN) fail(`invalid ${key}.stun`);
  const turn = value.turn;
  if (turn !== null && turn !== undefined && !isRecord(turn)) fail(`invalid ${key}.turn`);
  for (const item of stun) {
    if (typeof item !== 'string' || item.length === 0) fail(`invalid ${key}.stun`);
    if (item.length > RELAY_CTL_MAX_SHORT_STRING_LEN) fail(`invalid ${key}.stun`);
  }
  if (!isRecord(turn)) return { stun: stun as string[], turn: null };
  if (typeof turn.username !== 'string' || typeof turn.credential !== 'string') {
    fail(`invalid ${key}.turn`);
  }
  return {
    stun: stun as string[],
    turn: { url: str(turn, 'url'), username: turn.username, credential: turn.credential },
  };
}

function memberProof(obj: Record<string, unknown>, key: string): RelayMemberProof | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) fail(`invalid ${key}`);
  return {
    bytes: b64(value, 'bytes', undefined, RELAY_CTL_MAX_MEMBER_BYTES),
    sig: b64(value, 'sig', undefined, RELAY_CTL_MAX_SIG_BYTES),
  };
}

function keylogMember(obj: Record<string, unknown>, key: string): RelayKeylogMember | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) fail(`invalid ${key}`);
  const op = value.op;
  if (op !== 'admit' && op !== 'revoke' && op !== 'rotate-root') fail(`invalid ${key}.op`);
  return {
    op,
    bytes: b64(value, 'bytes', undefined, RELAY_CTL_MAX_MEMBER_BYTES),
    sig: b64(value, 'sig', undefined, RELAY_CTL_MAX_SIG_BYTES),
  };
}

function listNodes(obj: Record<string, unknown>): RelayListNode[] {
  const nodes = obj.nodes;
  if (!Array.isArray(nodes)) fail('invalid nodes');
  if (nodes.length > RELAY_CTL_MAX_NODES) fail('too many nodes');
  return nodes.map((item) => {
    if (!isRecord(item)) fail('invalid nodes[]');
    const status = item.status;
    if (status !== 'pending' && status !== 'admitted' && status !== 'revoked') {
      fail('invalid nodes[].status');
    }
    const epoch = optUint(item, 'epoch');
    return {
      id: hexId(item, 'id'),
      online: bool(item, 'online'),
      status,
      ...(epoch !== undefined ? { epoch } : {}),
      ...(item.blob === undefined || item.blob === null ? {} : { blob: envelope(item, 'blob') }),
    };
  });
}

function keylogRecords(obj: Record<string, unknown>): RelayKeyLogRecordWire[] {
  const records = obj.records;
  if (!Array.isArray(records)) fail('invalid records');
  if (records.length > RELAY_KEYLOG_PAGE_MAX_LIMIT) fail('too many records');
  return records.map((item) => {
    if (!isRecord(item)) fail('invalid records[]');
    return { seq: seq(item, 'seq'), blob: envelope(item, 'blob') };
  });
}

function parseAuth(obj: Record<string, unknown>): RelayCtlMessage {
  const member = memberProof(obj, 'member');
  return {
    t: 'relay.auth',
    tenant_id: hexId(obj, 'tenant_id'),
    token: b64(obj, 'token', 32),
    node_id: hexId(obj, 'node_id'),
    sig: b64(obj, 'sig', 64),
    proto: uint(obj, 'proto'),
    client_version: str(obj, 'client_version', 64),
    ...(member ? { member } : {}),
  };
}

function parseKeylogAck(obj: Record<string, unknown>): RelayCtlMessage {
  const ackSeq = optSeq(obj, 'seq');
  const head = optSeq(obj, 'head');
  const error = optStr(obj, 'error');
  const memberIgnored = optBool(obj, 'member_ignored');
  const memberError = optStr(obj, 'member_error');
  return {
    t: 'relay.keylog.ack',
    id: str(obj, 'id'),
    ok: bool(obj, 'ok'),
    ...(ackSeq !== undefined ? { seq: ackSeq } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(head !== undefined ? { head } : {}),
    ...(memberIgnored !== undefined ? { member_ignored: memberIgnored } : {}),
    ...(memberError !== undefined ? { member_error: memberError } : {}),
  };
}

function parsePage(obj: Record<string, unknown>, t: 'relay.keylog.res' | 'relay.keylog.push') {
  const hasMore = optBool(obj, 'has_more');
  return {
    t,
    records: keylogRecords(obj),
    ...(hasMore !== undefined ? { has_more: hasMore } : {}),
  } as RelayCtlMessage;
}

type RelayCtlParser = (obj: Record<string, unknown>) => RelayCtlMessage;

const PARSERS: Record<RelayCtlType, RelayCtlParser> = {
  'auth.challenge': (obj) => ({ t: 'auth.challenge', nonce: b64(obj, 'nonce', 32) }),
  'relay.auth': parseAuth,
  'auth.ok': (obj) => ({
    t: 'auth.ok',
    tenant_id: hexId(obj, 'tenant_id'),
    key_log_head_seq: seq(obj, 'key_log_head_seq'),
    rtc: rtcConfig(obj, 'rtc'),
  }),
  ping: () => ({ t: 'ping' }),
  pong: () => ({ t: 'pong' }),
  'relay.status': (obj) => ({
    t: 'relay.status',
    blob: envelope(obj, 'blob'),
    epoch: uint(obj, 'epoch'),
  }),
  'relay.list': (obj) => ({
    t: 'relay.list',
    version: uint(obj, 'version'),
    nodes: listNodes(obj),
    rtc: rtcConfig(obj, 'rtc'),
    key_log_head_seq: seq(obj, 'key_log_head_seq'),
  }),
  'relay.keylog.append': (obj) => {
    const member = keylogMember(obj, 'member');
    return {
      t: 'relay.keylog.append',
      id: str(obj, 'id'),
      seq: seq(obj, 'seq'),
      blob: envelope(obj, 'blob'),
      ...(member ? { member } : {}),
    };
  },
  'relay.keylog.ack': parseKeylogAck,
  'relay.keylog.req': (obj) => {
    const limit = optUint(obj, 'limit');
    if (limit !== undefined && (limit < 1 || limit > RELAY_KEYLOG_PAGE_MAX_LIMIT)) {
      fail('invalid limit');
    }
    return {
      t: 'relay.keylog.req',
      from_seq: seq(obj, 'from_seq'),
      ...(limit !== undefined ? { limit } : {}),
    };
  },
  'relay.keylog.res': (obj) => parsePage(obj, 'relay.keylog.res'),
  'relay.keylog.push': (obj) => parsePage(obj, 'relay.keylog.push'),
  'relay.rtc': (obj) => {
    const from = obj.from;
    if (from !== 'browser' && from !== 'node') fail('invalid from');
    return {
      t: 'relay.rtc',
      rtcSession: str(obj, 'rtcSession', 128),
      from,
      to: hexId(obj, 'to'),
      enc: envelope(obj, 'enc'),
    };
  },
  'relay.enroll.create': (obj) => ({
    t: 'relay.enroll.create',
    id: str(obj, 'id'),
    enroll_pk: b64(obj, 'enroll_pk', 32),
    authorization: b64(obj, 'authorization', undefined, RELAY_CTL_MAX_MEMBER_BYTES),
    authorization_sig: b64(obj, 'authorization_sig', undefined, RELAY_CTL_MAX_SIG_BYTES),
    exp: uint(obj, 'exp'),
  }),
  'relay.enroll.ack': (obj) => {
    const error = optStr(obj, 'error');
    return {
      t: 'relay.enroll.ack',
      id: str(obj, 'id'),
      ok: bool(obj, 'ok'),
      ...(error ? { error } : {}),
    };
  },
  'enroll.redeemed': (obj) => ({
    t: 'enroll.redeemed',
    certificate: b64(obj, 'certificate', undefined, RELAY_CTL_MAX_CERT_BYTES),
    cert_sig: b64(obj, 'cert_sig', 64),
    enroll_pk: b64(obj, 'enroll_pk', 32),
    node_id: hexId(obj, 'node_id'),
  }),
  'relay.quota': (obj) => {
    const bandwidth = obj.bandwidthBytesPerSec;
    if (bandwidth !== null && (typeof bandwidth !== 'number' || bandwidth < 0)) {
      fail('invalid bandwidthBytesPerSec');
    }
    return {
      t: 'relay.quota',
      maxNodes: uint(obj, 'maxNodes'),
      maxStreams: uint(obj, 'maxStreams'),
      bandwidthBytesPerSec: bandwidth === null ? null : (bandwidth as number),
    };
  },
  'relay.kicked': (obj) => {
    const reason = obj.reason;
    if (reason !== 'password_rotated' && reason !== 'kicked' && reason !== 'revoked') {
      fail('invalid reason');
    }
    return { t: 'relay.kicked', reason };
  },
};

/** 校验并归一化一条 ctl（丢弃未知字段），encode/decode 共用同一条路径。 */
export function parseRelayCtl(value: unknown): RelayCtlMessage {
  if (!isRecord(value)) fail('ctl must be an object');
  assertBounds(value, 0);
  const t = value.t;
  if (typeof t !== 'string' || !TYPE_SET.has(t)) fail(`unknown relay ctl t: ${String(t)}`);
  return PARSERS[t as RelayCtlType](value);
}

export function encodeRelayCtl(msg: RelayCtlMessage): Uint8Array {
  const bytes = te.encode(JSON.stringify(parseRelayCtl(msg)));
  if (bytes.byteLength > RELAY_CTL_MAX_BYTES) fail('ctl too large');
  return bytes;
}

export function decodeRelayCtl(input: Uint8Array | string): RelayCtlMessage {
  const text = typeof input === 'string' ? input : td.decode(input);
  const byteLength = typeof input === 'string' ? te.encode(text).byteLength : input.byteLength;
  if (byteLength > RELAY_CTL_MAX_BYTES) fail('ctl too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('invalid json');
  }
  return parseRelayCtl(parsed);
}
