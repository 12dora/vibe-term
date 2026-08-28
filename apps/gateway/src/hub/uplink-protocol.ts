import { decodeBase64url, encodeBase64url } from '@tmex/shared/auth';
import type { HubTurnConfig } from './types';

export class UplinkCtlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UplinkCtlError';
  }
}

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
] as const;

export type UplinkCtlType = (typeof UPLINK_CTL_TYPES)[number];

export type AuthChallengeMessage = { t: 'auth.challenge'; nonce: string };
export type AuthResponseMessage = { t: 'auth.response'; node_id: string; sig: string };
export type AuthOkMessage = { t: 'auth.ok' };
export type PingMessage = { t: 'ping' };
export type PongMessage = { t: 'pong' };

export type NodeStatusMessage = {
  t: 'node.status';
  version: string;
  tmux: boolean;
  direct_capable: boolean;
  inventory: unknown;
  endpoints: unknown;
};

export type NodeListEntry = {
  id: string;
  name: string;
  online: boolean;
  endpoints: unknown;
  inventory: unknown;
  direct_capable: boolean;
  version: string | null;
};

export type NodeListHubInfo = { nodeId: string; publicUrl: string };

export type NodeListMessage = {
  t: 'node.list';
  version: number;
  key_log_head: { seq: number | string; hash: string };
  rtc: { stun: string[]; turn: HubTurnConfig };
  nodes: NodeListEntry[];
  hub?: NodeListHubInfo;
};

export type KeyLogReqMessage = {
  t: 'key.log.req';
  from_seq: number | string;
  id?: string;
  limit?: number;
};
export type KeyLogRecordWire = { seq: number | string; bytes: string; sig: string };
export type KeyLogResMessage = {
  t: 'key.log.res';
  records: KeyLogRecordWire[];
  id?: string;
  error?: string;
  has_more?: boolean;
  retry_after_ms?: number;
};
export type KeyLogAppendMessage = { t: 'key.log.append'; bytes: string; sig: string; id?: string };
export type KeyLogAckMessage = {
  t: 'key.log.ack';
  id: string;
  ok: boolean;
  seq?: number | string;
  error?: string;
};

export type RtcSignalFrom = 'browser' | 'node';
export type RtcSignalMessage = {
  t: 'rtc.signal';
  rtcSession: string;
  from: RtcSignalFrom;
  to: string;
  sdp?: string;
  candidate?: string;
};

export type EnrollRedeemedMessage = {
  t: 'enroll.redeemed';
  certificate: string;
  cert_sig: string;
  enroll_pk: string;
  node_id: string;
  entry_sid?: string;
};

export type UplinkCtlMessage =
  | AuthChallengeMessage
  | AuthResponseMessage
  | AuthOkMessage
  | PingMessage
  | PongMessage
  | NodeStatusMessage
  | NodeListMessage
  | KeyLogReqMessage
  | KeyLogResMessage
  | KeyLogAppendMessage
  | KeyLogAckMessage
  | RtcSignalMessage
  | EnrollRedeemedMessage;

const KNOWN_TYPES = new Set<string>(UPLINK_CTL_TYPES);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const UPLINK_CTL_MAX_BYTES = 64 * 1024;
export const UPLINK_CTL_MAX_DEPTH = 8;
export const UPLINK_CTL_MAX_ARRAY_LEN = 1024;
export const UPLINK_CTL_MAX_STRING_LEN = 4 * 1024;
export const UPLINK_CTL_MAX_ENDPOINTS = 32;
export const UPLINK_CTL_MAX_CERT_BYTES = 2048;
export const UPLINK_CTL_MAX_U64 = 18446744073709551615n;
export const KEY_LOG_PAGE_DEFAULT_LIMIT = 256;
export const KEY_LOG_PAGE_MAX_LIMIT = 256;
export const KEY_LOG_PAGE_MAX_BYTES = 1024 * 1024;
const NODE_ID_HEX_RE = /^[0-9a-f]{32}$/i;

export function seqToWire(seq: bigint | number): number | string {
  const value = typeof seq === 'bigint' ? seq : BigInt(seq);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

export function seqFromWire(value: number | string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new UplinkCtlError('invalid seq');
    }
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value)) {
    throw new UplinkCtlError('invalid seq');
  }
  const n = BigInt(value);
  if (n > UPLINK_CTL_MAX_U64) {
    throw new UplinkCtlError('invalid seq');
  }
  return n;
}

export function bytesToB64url(bytes: Uint8Array): string {
  return encodeBase64url(bytes);
}

export function b64urlToBytes(value: string, expectedLen?: number): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new UplinkCtlError('invalid b64url');
  }
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

export function encodeUplinkCtl(msg: UplinkCtlMessage): Uint8Array {
  return textEncoder.encode(JSON.stringify(msg));
}

export function decodeUplinkCtl(input: Uint8Array | string): UplinkCtlMessage {
  const byteLength =
    typeof input === 'string' ? textEncoder.encode(input).byteLength : input.byteLength;
  if (byteLength > KEY_LOG_PAGE_MAX_BYTES) {
    throw new UplinkCtlError('ctl too large');
  }
  const text = typeof input === 'string' ? input : textDecoder.decode(input);
  if (
    byteLength > UPLINK_CTL_MAX_BYTES &&
    !text.includes('"key.log.res"') &&
    !text.includes('"t":"key.log.res"')
  ) {
    throw new UplinkCtlError('ctl too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UplinkCtlError(byteLength > UPLINK_CTL_MAX_BYTES ? 'ctl too large' : 'invalid json');
  }
  const parsedT =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { t?: unknown }).t
      : undefined;
  if (parsedT !== 'key.log.res' && byteLength > UPLINK_CTL_MAX_BYTES) {
    throw new UplinkCtlError('ctl too large');
  }
  if (parsedT !== 'key.log.res') {
    assertCtlBounds(parsed, 0);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UplinkCtlError('invalid ctl');
  }
  const obj = parsed as Record<string, unknown>;
  const t = obj.t;
  if (typeof t !== 'string' || !KNOWN_TYPES.has(t)) {
    throw new UplinkCtlError(`unknown t: ${String(t)}`);
  }
  switch (t as UplinkCtlType) {
    case 'auth.challenge':
      return {
        t: 'auth.challenge',
        nonce: bytesToB64url(b64urlToBytes(requireString(obj, 'nonce'), 32)),
      };
    case 'auth.response':
      return {
        t: 'auth.response',
        node_id: requireNonEmptyString(obj, 'node_id'),
        sig: bytesToB64url(b64urlToBytes(requireString(obj, 'sig'), 64)),
      };
    case 'auth.ok':
      return { t: 'auth.ok' };
    case 'ping':
      return { t: 'ping' };
    case 'pong':
      return { t: 'pong' };
    case 'node.status':
      return {
        t: 'node.status',
        version: requireString(obj, 'version'),
        tmux: requireBoolean(obj, 'tmux'),
        direct_capable: requireBoolean(obj, 'direct_capable'),
        inventory: obj.inventory ?? null,
        endpoints: requireEndpoints(obj.endpoints),
      };
    case 'node.list':
      return decodeNodeList(obj);
    case 'key.log.req': {
      const req: KeyLogReqMessage = { t: 'key.log.req', from_seq: requireSeq(obj, 'from_seq') };
      if (obj.id !== undefined && obj.id !== null) req.id = requireNonEmptyString(obj, 'id');
      if (obj.limit !== undefined && obj.limit !== null) {
        req.limit = requireInt(obj, 'limit');
        if (req.limit < 1) {
          throw new UplinkCtlError('invalid limit');
        }
      }
      return req;
    }
    case 'key.log.res': {
      const records = requireKeyLogRecords(obj.records);
      if (records.length > KEY_LOG_PAGE_MAX_LIMIT) {
        throw new UplinkCtlError('key.log.res too many records');
      }
      const res: KeyLogResMessage = {
        t: 'key.log.res',
        records,
      };
      if (obj.id !== undefined && obj.id !== null) res.id = requireNonEmptyString(obj, 'id');
      if (obj.error !== undefined && obj.error !== null) {
        res.error = requireNonEmptyString(obj, 'error');
      }
      if (obj.has_more !== undefined && obj.has_more !== null) {
        res.has_more = requireBoolean(obj, 'has_more');
      }
      if (obj.retry_after_ms !== undefined && obj.retry_after_ms !== null) {
        res.retry_after_ms = requireInt(obj, 'retry_after_ms');
        if (res.retry_after_ms < 0) {
          throw new UplinkCtlError('invalid retry_after_ms');
        }
      }
      return res;
    }
    case 'key.log.append':
      return decodeKeyLogAppend(obj);
    case 'key.log.ack':
      return decodeKeyLogAck(obj);
    case 'rtc.signal':
      return decodeRtcSignal(obj);
    case 'enroll.redeemed':
      return decodeEnrollRedeemed(obj);
  }
  throw new UplinkCtlError(`unknown t: ${t}`);
}

function decodeNodeList(obj: Record<string, unknown>): NodeListMessage {
  const head = obj.key_log_head;
  if (!head || typeof head !== 'object' || Array.isArray(head)) {
    throw new UplinkCtlError('invalid key_log_head');
  }
  const headObj = head as Record<string, unknown>;
  const hashBytes = b64urlToBytes(requireString(headObj, 'hash'), 32);
  const rtc = obj.rtc;
  if (!rtc || typeof rtc !== 'object' || Array.isArray(rtc)) {
    throw new UplinkCtlError('invalid rtc');
  }
  const rtcObj = rtc as Record<string, unknown>;
  if (!Array.isArray(rtcObj.stun) || rtcObj.stun.some((s) => typeof s !== 'string')) {
    throw new UplinkCtlError('invalid rtc.stun');
  }
  const nodes = obj.nodes;
  if (!Array.isArray(nodes)) {
    throw new UplinkCtlError('invalid nodes');
  }
  const msg: NodeListMessage = {
    t: 'node.list',
    version: requireInt(obj, 'version'),
    key_log_head: { seq: requireSeq(headObj, 'seq'), hash: bytesToB64url(hashBytes) },
    rtc: {
      stun: rtcObj.stun as string[],
      turn: decodeTurn(rtcObj.turn),
    },
    nodes: nodes.map(decodeNodeListEntry),
  };
  if (obj.hub !== undefined && obj.hub !== null) {
    msg.hub = decodeHubInfo(obj.hub);
  }
  return msg;
}

function decodeHubInfo(value: unknown): NodeListHubInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UplinkCtlError('invalid hub');
  }
  const obj = value as Record<string, unknown>;
  return {
    nodeId: requireNonEmptyString(obj, 'nodeId'),
    publicUrl: requireNonEmptyString(obj, 'publicUrl'),
  };
}

function decodeKeyLogAppend(obj: Record<string, unknown>): KeyLogAppendMessage {
  const msg: KeyLogAppendMessage = {
    t: 'key.log.append',
    bytes: bytesToB64url(b64urlToBytes(requireString(obj, 'bytes'))),
    sig: bytesToB64url(b64urlToBytes(requireString(obj, 'sig'), 64)),
  };
  if (obj.id !== undefined && obj.id !== null) {
    msg.id = requireNonEmptyString(obj, 'id');
  }
  return msg;
}

function decodeKeyLogAck(obj: Record<string, unknown>): KeyLogAckMessage {
  const ok = requireBoolean(obj, 'ok');
  const msg: KeyLogAckMessage = {
    t: 'key.log.ack',
    id: requireNonEmptyString(obj, 'id'),
    ok,
  };
  if (ok) {
    msg.seq = requireSeq(obj, 'seq');
  } else {
    msg.error = requireNonEmptyString(obj, 'error');
  }
  return msg;
}

function decodeTurn(value: unknown): HubTurnConfig {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UplinkCtlError('invalid rtc.turn');
  }
  const obj = value as Record<string, unknown>;
  return {
    url: requireNonEmptyString(obj, 'url'),
    username: requireString(obj, 'username'),
    credential: requireString(obj, 'credential'),
  };
}

function decodeNodeListEntry(value: unknown): NodeListEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UplinkCtlError('invalid node entry');
  }
  const obj = value as Record<string, unknown>;
  const version = obj.version;
  if (version !== null && version !== undefined && typeof version !== 'string') {
    throw new UplinkCtlError('invalid node.version');
  }
  return {
    id: requireNonEmptyString(obj, 'id'),
    name: requireString(obj, 'name'),
    online: requireBoolean(obj, 'online'),
    endpoints: requireEndpoints(obj.endpoints),
    inventory: obj.inventory ?? null,
    direct_capable: requireBoolean(obj, 'direct_capable'),
    version: typeof version === 'string' ? version : null,
  };
}

function decodeEnrollRedeemed(obj: Record<string, unknown>): EnrollRedeemedMessage {
  const certBytes = b64urlToBytes(requireString(obj, 'certificate'));
  if (certBytes.byteLength > UPLINK_CTL_MAX_CERT_BYTES) {
    throw new UplinkCtlError('certificate too large');
  }
  const msg: EnrollRedeemedMessage = {
    t: 'enroll.redeemed',
    certificate: bytesToB64url(certBytes),
    cert_sig: bytesToB64url(b64urlToBytes(requireString(obj, 'cert_sig'), 64)),
    enroll_pk: bytesToB64url(b64urlToBytes(requireString(obj, 'enroll_pk'), 32)),
    node_id: requireNodeIdHex(obj, 'node_id'),
  };
  if (obj.entry_sid !== undefined && obj.entry_sid !== null) {
    msg.entry_sid = requireNonEmptyString(obj, 'entry_sid');
  }
  return msg;
}

function requireNodeIdHex(obj: Record<string, unknown>, key: string): string {
  const value = requireNonEmptyString(obj, key);
  if (!NODE_ID_HEX_RE.test(value)) {
    throw new UplinkCtlError(`invalid ${key}`);
  }
  return value;
}

function decodeRtcSignal(obj: Record<string, unknown>): RtcSignalMessage {
  const from = obj.from;
  if (from !== 'browser' && from !== 'node') {
    throw new UplinkCtlError('invalid rtc.from');
  }
  const sdp = obj.sdp;
  const candidate = obj.candidate;
  if (sdp !== undefined && sdp !== null && typeof sdp !== 'string') {
    throw new UplinkCtlError('invalid rtc.sdp');
  }
  if (candidate !== undefined && candidate !== null && typeof candidate !== 'string') {
    throw new UplinkCtlError('invalid rtc.candidate');
  }
  const msg: RtcSignalMessage = {
    t: 'rtc.signal',
    rtcSession: requireNonEmptyString(obj, 'rtcSession'),
    from,
    to: requireNonEmptyString(obj, 'to'),
  };
  if (typeof sdp === 'string') msg.sdp = sdp;
  if (typeof candidate === 'string') msg.candidate = candidate;
  return msg;
}

function requireKeyLogRecords(value: unknown): KeyLogRecordWire[] {
  if (!Array.isArray(value)) {
    throw new UplinkCtlError('invalid records');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new UplinkCtlError('invalid record');
    }
    const obj = item as Record<string, unknown>;
    return {
      seq: requireSeq(obj, 'seq'),
      bytes: bytesToB64url(b64urlToBytes(requireString(obj, 'bytes'))),
      sig: bytesToB64url(b64urlToBytes(requireString(obj, 'sig'), 64)),
    };
  });
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw new UplinkCtlError(`missing ${key}`);
  }
  return value;
}

function requireNonEmptyString(obj: Record<string, unknown>, key: string): string {
  const value = requireString(obj, key);
  if (value.length === 0) {
    throw new UplinkCtlError(`empty ${key}`);
  }
  return value;
}

function requireBoolean(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') {
    throw new UplinkCtlError(`missing ${key}`);
  }
  return value;
}

function requireInt(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new UplinkCtlError(`invalid ${key}`);
  }
  return value;
}

function requireSeq(obj: Record<string, unknown>, key: string): number | string {
  const value = obj[key];
  if (typeof value === 'number' || typeof value === 'string') {
    seqFromWire(value);
    return value;
  }
  throw new UplinkCtlError(`invalid ${key}`);
}

function requireEndpoints(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length > UPLINK_CTL_MAX_ENDPOINTS) {
    throw new UplinkCtlError('too many endpoints');
  }
  return value;
}

function assertCtlBounds(value: unknown, depth: number): void {
  if (depth > UPLINK_CTL_MAX_DEPTH) {
    throw new UplinkCtlError('ctl too deep');
  }
  if (typeof value === 'string' && value.length > UPLINK_CTL_MAX_STRING_LEN) {
    throw new UplinkCtlError('ctl string too long');
  }
  if (Array.isArray(value)) {
    if (value.length > UPLINK_CTL_MAX_ARRAY_LEN) {
      throw new UplinkCtlError('ctl array too long');
    }
    for (const item of value) {
      assertCtlBounds(item, depth + 1);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      assertCtlBounds(item, depth + 1);
    }
  }
}
