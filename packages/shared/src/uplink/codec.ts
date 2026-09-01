import { decodeBase64url, encodeBase64url } from '../auth/encoding';

export { HUB_NOT_WRITER, type HubNotWriterError } from './errors';

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

const TYPE_SET = new Set<string>(UPLINK_CTL_TYPES);
const te = new TextEncoder();
const td = new TextDecoder();
const NODE_ID_HEX = /^[0-9a-f]{32}$/;
const NODE_ID_HEX_I = /^[0-9a-f]{32}$/i;

export const UPLINK_CTL_MAX_BYTES = 64 * 1024;
export const UPLINK_CTL_MAX_DEPTH = 8;
export const UPLINK_CTL_MAX_ARRAY_LEN = 1024;
export const UPLINK_CTL_MAX_STRING_LEN = 4 * 1024;
export const UPLINK_CTL_MAX_ENDPOINTS = 32;
export const UPLINK_CTL_MAX_HUBS = 16;
export const UPLINK_CTL_MAX_HUB_URL_LEN = 512;
export const UPLINK_CTL_MAX_CERT_BYTES = 2048;
export const UPLINK_CTL_MAX_U64 = 18446744073709551615n;
export const KEY_LOG_PAGE_DEFAULT_LIMIT = 256;
export const KEY_LOG_PAGE_MAX_LIMIT = 256;
export const KEY_LOG_PAGE_MAX_BYTES = 1024 * 1024;

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

function wrapHub<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof UplinkCtlError) throw e;
    throw new UplinkCtlError(e instanceof Error ? e.message : 'invalid ctl');
  }
}

function mStr(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`ctl field ${field} must be a string`);
  return value;
}

function mOptStr(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return mStr(value, field);
}

function mBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`ctl field ${field} must be a boolean`);
  return value;
}

function mNum(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`ctl field ${field} must be a number`);
  }
  return value;
}

function mSeq(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value !== '') return BigInt(value);
  throw new Error(`ctl field ${field} must be a seq`);
}

function mB64(value: unknown, field: string, expectedLen?: number): Uint8Array {
  const bytes = decodeBase64url(mStr(value, field));
  if (expectedLen !== undefined && bytes.byteLength !== expectedLen) {
    throw new Error(`ctl field ${field} expected ${expectedLen} bytes`);
  }
  return bytes;
}

function mNodeId(value: unknown, field: string): string {
  const id = mStr(value, field);
  if (!NODE_ID_HEX_I.test(id)) throw new Error(`ctl field ${field} must be 32-hex`);
  return id;
}

function mHubMode(value: unknown, field: string): HubMode {
  if (value !== 'active' && value !== 'standby') {
    throw new Error(`ctl field ${field} must be active|standby`);
  }
  return value;
}

function mNonNegInt(value: unknown, field: string): number {
  const n = mNum(value, field);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`ctl field ${field} must be a non-negative integer`);
  }
  return n;
}

function mHttpUrl(value: unknown, field: string): string {
  const raw = mStr(value, field);
  if (raw.length > UPLINK_CTL_MAX_HUB_URL_LEN) {
    throw new Error(`ctl field ${field} too long`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`ctl field ${field} must be an http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`ctl field ${field} must be an http(s) URL`);
  }
  return raw;
}

function mOptNullStr(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return mStr(value, field);
}

function parseHubEndpointInfo(value: unknown, label: string): HubEndpointInfo {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const info: HubEndpointInfo = {
    nodeId: mNodeId(value.nodeId, `${label}.nodeId`),
    publicUrl: mHttpUrl(value.publicUrl, `${label}.publicUrl`),
    mode: mHubMode(value.mode, `${label}.mode`),
    priority: mNonNegInt(value.priority, `${label}.priority`),
    writerEpoch: mNonNegInt(value.writerEpoch, `${label}.writerEpoch`),
  };
  const name = mOptStr(value.name, `${label}.name`);
  if (name) info.name = name;
  const caFingerprint = mOptNullStr(value.caFingerprint, `${label}.caFingerprint`);
  if (caFingerprint !== undefined) info.caFingerprint = caFingerprint;
  if (value.online !== undefined && value.online !== null) {
    info.online = mBool(value.online, `${label}.online`);
  }
  if (value.lastSeenAt !== undefined) {
    info.lastSeenAt =
      value.lastSeenAt === null ? null : mNonNegInt(value.lastSeenAt, `${label}.lastSeenAt`);
  }
  return info;
}

function parseHubs(value: unknown): HubEndpointInfo[] {
  if (!Array.isArray(value)) throw new Error('node.list hubs must be an array');
  if (value.length > UPLINK_CTL_MAX_HUBS) throw new Error('node.list hubs too many');
  return value.map((item, i) => parseHubEndpointInfo(item, `hubs[${i}]`));
}

function parseHubAdvertisement(value: unknown): HubAdvertisement {
  if (!isRecord(value)) throw new Error('node.status hub must be an object');
  const adv: HubAdvertisement = {
    publicUrl: mHttpUrl(value.publicUrl, 'hub.publicUrl'),
    mode: mHubMode(value.mode, 'hub.mode'),
    priority: mNonNegInt(value.priority, 'hub.priority'),
    writerEpoch: mNonNegInt(value.writerEpoch, 'hub.writerEpoch'),
  };
  const caFingerprint = mOptNullStr(value.caFingerprint, 'hub.caFingerprint');
  if (caFingerprint !== undefined) adv.caFingerprint = caFingerprint;
  return adv;
}

function applyNodeListExtras<
  T extends { hubs?: HubEndpointInfo[]; writerHubId?: string; writerEpoch?: number },
>(target: T, parsed: Record<string, unknown>): T {
  if (parsed.hubs !== undefined && parsed.hubs !== null) target.hubs = parseHubs(parsed.hubs);
  if (parsed.writerHubId !== undefined && parsed.writerHubId !== null) {
    target.writerHubId = mNodeId(parsed.writerHubId, 'writerHubId');
  }
  if (parsed.writerEpoch !== undefined && parsed.writerEpoch !== null) {
    target.writerEpoch = mNonNegInt(parsed.writerEpoch, 'writerEpoch');
  }
  return target;
}

type MeshNodeInfo = {
  id: string;
  name: string;
  online: boolean;
  endpoints: unknown;
  inventory: unknown;
  direct_capable: boolean;
  version: string | null;
};

type MeshHubInfo = { nodeId: string; publicUrl: string; name?: string };

export type HubMode = 'active' | 'standby';

export interface HubEndpointInfo {
  nodeId: string;
  publicUrl: string;
  name?: string;
  mode: HubMode;
  priority: number;
  writerEpoch: number;
  caFingerprint?: string | null;
  online?: boolean;
  lastSeenAt?: number | null;
}

/** A node that runs the hub role advertises itself in node.status. */
export interface HubAdvertisement {
  publicUrl: string;
  mode: HubMode;
  priority: number;
  writerEpoch: number;
  caFingerprint?: string | null;
}

export type EncodeUplinkCtlOptions = { legacy?: boolean };

export type MeshUplinkNodeList = {
  t: 'node.list';
  version: number;
  key_log_head: { seq: bigint; hash: Uint8Array };
  rtc: { stun: string[]; turn: unknown };
  nodes: MeshNodeInfo[];
  hub?: MeshHubInfo;
  hubs?: HubEndpointInfo[];
  writerHubId?: string;
  writerEpoch?: number;
};

export type MeshUplinkKeyLogRecord = { seq: bigint; bytes: Uint8Array; sig: Uint8Array };
export type MeshUplinkKeyLogAck = {
  t: 'key.log.ack';
  id: string;
  ok: boolean;
  seq?: bigint;
  error?: string;
};
export type MeshUplinkRtcSignal = {
  t: 'rtc.signal';
  rtcSession: string;
  from: 'browser' | 'node';
  to: string;
  sdp?: string;
  candidate?: string;
};
export type MeshUplinkEnrollRedeemed = {
  t: 'enroll.redeemed';
  certificate: Uint8Array;
  cert_sig: Uint8Array;
  enroll_pk: Uint8Array;
  nodeId: string;
  entrySid?: string;
};

export type MeshUplinkCtlMessage =
  | { t: 'auth.challenge'; nonce: string }
  | { t: 'auth.response'; node_id: string; sig: string }
  | { t: 'auth.ok' }
  | { t: 'ping' }
  | { t: 'pong' }
  | {
      t: 'node.status';
      version: string;
      tmux: boolean;
      direct_capable: boolean;
      inventory: unknown;
      endpoints: unknown;
      hub?: HubAdvertisement;
    }
  | MeshUplinkNodeList
  | { t: 'key.log.req'; from_seq: bigint; id?: string; limit?: number }
  | {
      t: 'key.log.res';
      records: MeshUplinkKeyLogRecord[];
      id?: string;
      error?: string;
      has_more?: boolean;
      retry_after_ms?: number;
    }
  | { t: 'key.log.append'; bytes: Uint8Array; sig: Uint8Array; id?: string }
  | MeshUplinkKeyLogAck
  | MeshUplinkRtcSignal
  | MeshUplinkEnrollRedeemed;

function parseMeshNode(value: unknown): MeshNodeInfo {
  if (!isRecord(value)) throw new Error('node.list node must be an object');
  return {
    id: mStr(value.id, 'nodes[].id'),
    name: mStr(value.name, 'nodes[].name'),
    online: mBool(value.online, 'nodes[].online'),
    endpoints: value.endpoints ?? [],
    inventory: value.inventory ?? {},
    direct_capable: mBool(value.direct_capable, 'nodes[].direct_capable'),
    version: mOptStr(value.version, 'nodes[].version') ?? null,
  };
}

function parseMeshHub(value: unknown): MeshHubInfo {
  if (!isRecord(value)) throw new Error('node.list hub must be an object');
  const info: MeshHubInfo = {
    nodeId: mNodeId(value.nodeId, 'hub.nodeId'),
    publicUrl: mStr(value.publicUrl, 'hub.publicUrl'),
  };
  const name = mOptStr(value.name, 'hub.name');
  if (name) info.name = name;
  return info;
}

export function decodeMeshUplinkCtl(
  bytes: Uint8Array,
  opts?: { pendingKeyLogId?: string }
): MeshUplinkCtlMessage {
  if (bytes.byteLength > KEY_LOG_PAGE_MAX_BYTES) throw new Error('ctl too large');
  if (bytes.byteLength > UPLINK_CTL_MAX_BYTES && !opts?.pendingKeyLogId) {
    throw new Error('ctl too large');
  }
  const parsed = decodeJsonBytes(bytes);
  if (!isRecord(parsed) || typeof parsed.t !== 'string') {
    throw new Error('uplink ctl must be a JSON object with t');
  }
  if (parsed.t === 'key.log.res' && bytes.byteLength > UPLINK_CTL_MAX_BYTES) {
    const resId = mOptStr(parsed.id, 'id');
    if (!resId || resId !== opts?.pendingKeyLogId) throw new Error('ctl too large');
  } else if (parsed.t !== 'key.log.res') {
    if (bytes.byteLength > UPLINK_CTL_MAX_BYTES) throw new Error('ctl too large');
    assertCtlBounds(parsed, 0);
  }
  if (!TYPE_SET.has(parsed.t)) throw new Error(`unknown uplink ctl t: ${parsed.t}`);
  switch (parsed.t as UplinkCtlType) {
    case 'auth.challenge':
      return { t: 'auth.challenge', nonce: mStr(parsed.nonce, 'nonce') };
    case 'auth.response':
      return {
        t: 'auth.response',
        node_id: mStr(parsed.node_id, 'node_id'),
        sig: mStr(parsed.sig, 'sig'),
      };
    case 'auth.ok':
      return { t: 'auth.ok' };
    case 'ping':
      return { t: 'ping' };
    case 'pong':
      return { t: 'pong' };
    case 'node.status': {
      const status: Extract<MeshUplinkCtlMessage, { t: 'node.status' }> = {
        t: 'node.status',
        version: mStr(parsed.version, 'version'),
        tmux: mBool(parsed.tmux, 'tmux'),
        direct_capable: mBool(parsed.direct_capable, 'direct_capable'),
        inventory: parsed.inventory ?? {},
        endpoints: parsed.endpoints ?? [],
      };
      if (parsed.hub !== undefined && parsed.hub !== null) {
        status.hub = parseHubAdvertisement(parsed.hub);
      }
      return status;
    }
    case 'node.list': {
      if (!isRecord(parsed.key_log_head))
        throw new Error('node.list key_log_head must be an object');
      if (!isRecord(parsed.rtc)) throw new Error('node.list rtc must be an object');
      if (!Array.isArray(parsed.nodes)) throw new Error('node.list nodes must be an array');
      const stun = parsed.rtc.stun;
      const list: MeshUplinkNodeList = {
        t: 'node.list',
        version: mNum(parsed.version, 'version'),
        key_log_head: {
          seq: mSeq(parsed.key_log_head.seq, 'key_log_head.seq'),
          hash: mB64(parsed.key_log_head.hash, 'key_log_head.hash'),
        },
        rtc: {
          stun: Array.isArray(stun) ? stun.map((item, i) => mStr(item, `rtc.stun[${i}]`)) : [],
          turn: parsed.rtc.turn ?? null,
        },
        nodes: parsed.nodes.map(parseMeshNode),
      };
      if (parsed.hub !== undefined && parsed.hub !== null) list.hub = parseMeshHub(parsed.hub);
      return applyNodeListExtras(list, parsed);
    }
    case 'key.log.req': {
      const req: Extract<MeshUplinkCtlMessage, { t: 'key.log.req' }> = {
        t: 'key.log.req',
        from_seq: mSeq(parsed.from_seq, 'from_seq'),
      };
      const reqId = mOptStr(parsed.id, 'id');
      if (reqId) req.id = reqId;
      if (parsed.limit !== undefined && parsed.limit !== null) {
        const limit = mNum(parsed.limit, 'limit');
        if (!Number.isInteger(limit) || limit < 1) {
          throw new Error('ctl field limit must be a positive integer');
        }
        req.limit = limit;
      }
      return req;
    }
    case 'key.log.res': {
      if (!Array.isArray(parsed.records)) throw new Error('key.log.res records must be an array');
      if (parsed.records.length > KEY_LOG_PAGE_MAX_LIMIT) {
        throw new Error('key.log.res too many records');
      }
      const res: Extract<MeshUplinkCtlMessage, { t: 'key.log.res' }> = {
        t: 'key.log.res',
        records: parsed.records.map((row, i) => {
          if (!isRecord(row)) throw new Error(`key.log.res records[${i}] must be an object`);
          return {
            seq: mSeq(row.seq, `records[${i}].seq`),
            bytes: mB64(row.bytes, `records[${i}].bytes`),
            sig: mB64(row.sig, `records[${i}].sig`),
          };
        }),
      };
      const resId = mOptStr(parsed.id, 'id');
      if (resId) res.id = resId;
      const resError = mOptStr(parsed.error, 'error');
      if (resError) res.error = resError;
      if (parsed.has_more !== undefined && parsed.has_more !== null) {
        res.has_more = mBool(parsed.has_more, 'has_more');
      }
      if (parsed.retry_after_ms !== undefined && parsed.retry_after_ms !== null) {
        const retryAfter = mNum(parsed.retry_after_ms, 'retry_after_ms');
        if (!Number.isInteger(retryAfter) || retryAfter < 0) {
          throw new Error('ctl field retry_after_ms must be a non-negative integer');
        }
        res.retry_after_ms = retryAfter;
      }
      return res;
    }
    case 'key.log.append': {
      const append: Extract<MeshUplinkCtlMessage, { t: 'key.log.append' }> = {
        t: 'key.log.append',
        bytes: mB64(parsed.bytes, 'bytes'),
        sig: mB64(parsed.sig, 'sig'),
      };
      const id = mOptStr(parsed.id, 'id');
      if (id) append.id = id;
      return append;
    }
    case 'key.log.ack': {
      const ok = mBool(parsed.ok, 'ok');
      const ack: MeshUplinkKeyLogAck = { t: 'key.log.ack', id: mStr(parsed.id, 'id'), ok };
      if (ok) ack.seq = mSeq(parsed.seq, 'seq');
      else ack.error = mStr(parsed.error, 'error');
      return ack;
    }
    case 'rtc.signal': {
      const from = mStr(parsed.from, 'from');
      if (from !== 'browser' && from !== 'node') {
        throw new Error('rtc.signal from must be browser|node');
      }
      return {
        t: 'rtc.signal',
        rtcSession: mStr(parsed.rtcSession, 'rtcSession'),
        from,
        to: mStr(parsed.to, 'to'),
        sdp: mOptStr(parsed.sdp, 'sdp'),
        candidate: mOptStr(parsed.candidate, 'candidate'),
      };
    }
    case 'enroll.redeemed': {
      const certificate = mB64(parsed.certificate, 'certificate');
      if (certificate.byteLength > UPLINK_CTL_MAX_CERT_BYTES) {
        throw new Error('ctl field certificate too large');
      }
      const msg: MeshUplinkEnrollRedeemed = {
        t: 'enroll.redeemed',
        certificate,
        cert_sig: mB64(parsed.cert_sig, 'cert_sig', 64),
        enroll_pk: mB64(parsed.enroll_pk, 'enroll_pk', 32),
        nodeId: mNodeId(parsed.node_id, 'node_id'),
      };
      const entrySid = mOptStr(parsed.entry_sid, 'entry_sid');
      if (entrySid) msg.entrySid = entrySid;
      return msg;
    }
  }
}

export function encodeMeshUplinkCtl(
  msg: MeshUplinkCtlMessage,
  opts?: EncodeUplinkCtlOptions
): Uint8Array {
  const legacy = opts?.legacy === true;
  switch (msg.t) {
    case 'auth.challenge':
    case 'auth.response':
    case 'auth.ok':
    case 'ping':
    case 'pong':
      return encodeJsonBytes(msg);
    case 'node.status': {
      if (legacy) {
        const { hub: _hub, ...rest } = msg;
        return encodeJsonBytes(rest);
      }
      if (msg.hub) parseHubAdvertisement(msg.hub);
      return encodeJsonBytes(msg);
    }
    case 'node.list': {
      if (!legacy && msg.hubs) parseHubs(msg.hubs);
      if (!legacy && msg.writerHubId) mNodeId(msg.writerHubId, 'writerHubId');
      if (!legacy && msg.writerEpoch !== undefined) mNonNegInt(msg.writerEpoch, 'writerEpoch');
      return encodeJsonBytes({
        t: 'node.list',
        version: msg.version,
        key_log_head: {
          seq: seqToWire(msg.key_log_head.seq),
          hash: encodeBase64url(msg.key_log_head.hash),
        },
        rtc: msg.rtc,
        nodes: msg.nodes,
        ...(msg.hub ? { hub: msg.hub } : {}),
        ...(!legacy && msg.hubs ? { hubs: msg.hubs } : {}),
        ...(!legacy && msg.writerHubId ? { writerHubId: msg.writerHubId } : {}),
        ...(!legacy && msg.writerEpoch !== undefined ? { writerEpoch: msg.writerEpoch } : {}),
      });
    }
    case 'key.log.req':
      return encodeJsonBytes({
        t: 'key.log.req',
        from_seq: seqToWire(msg.from_seq),
        ...(msg.id ? { id: msg.id } : {}),
        ...(msg.limit != null ? { limit: msg.limit } : {}),
      });
    case 'key.log.res':
      return encodeJsonBytes({
        t: 'key.log.res',
        records: msg.records.map((row) => ({
          seq: seqToWire(row.seq),
          bytes: encodeBase64url(row.bytes),
          sig: encodeBase64url(row.sig),
        })),
        ...(msg.id ? { id: msg.id } : {}),
        ...(msg.error ? { error: msg.error } : {}),
        ...(msg.has_more != null ? { has_more: msg.has_more } : {}),
        ...(msg.retry_after_ms != null ? { retry_after_ms: msg.retry_after_ms } : {}),
      });
    case 'key.log.append':
      return encodeJsonBytes({
        t: 'key.log.append',
        bytes: encodeBase64url(msg.bytes),
        sig: encodeBase64url(msg.sig),
        ...(msg.id ? { id: msg.id } : {}),
      });
    case 'key.log.ack':
      return encodeJsonBytes({
        t: 'key.log.ack',
        id: msg.id,
        ok: msg.ok,
        ...(msg.ok ? { seq: seqToWire(msg.seq ?? 0n) } : { error: msg.error ?? 'error' }),
      });
    case 'rtc.signal':
      return encodeJsonBytes({
        t: 'rtc.signal',
        rtcSession: msg.rtcSession,
        from: msg.from,
        to: msg.to,
        ...(msg.sdp !== undefined ? { sdp: msg.sdp } : {}),
        ...(msg.candidate !== undefined ? { candidate: msg.candidate } : {}),
      });
    case 'enroll.redeemed':
      return encodeJsonBytes({
        t: 'enroll.redeemed',
        certificate: encodeBase64url(msg.certificate),
        cert_sig: encodeBase64url(msg.cert_sig),
        enroll_pk: encodeBase64url(msg.enroll_pk),
        node_id: msg.nodeId,
        ...(msg.entrySid ? { entry_sid: msg.entrySid } : {}),
      });
  }
}

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
  hub?: HubAdvertisement;
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
type NodeListHubInfo = { nodeId: string; publicUrl: string; name?: string };
export type NodeListMessage = {
  t: 'node.list';
  version: number;
  key_log_head: { seq: number | string; hash: string };
  rtc: { stun: string[]; turn: { url: string; username: string; credential: string } | null };
  nodes: NodeListEntry[];
  hub?: NodeListHubInfo;
  hubs?: HubEndpointInfo[];
  writerHubId?: string;
  writerEpoch?: number;
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
type KeyLogAckMessage = {
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
  already_admitted?: boolean;
};
export type HubUplinkCtlMessage =
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

function hStr(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') throw new UplinkCtlError(`missing ${key}`);
  return value;
}

function hNe(obj: Record<string, unknown>, key: string): string {
  const value = hStr(obj, key);
  if (value.length === 0) throw new UplinkCtlError(`empty ${key}`);
  return value;
}

function hBool(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') throw new UplinkCtlError(`missing ${key}`);
  return value;
}

function hInt(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new UplinkCtlError(`invalid ${key}`);
  return value;
}

function hSeq(obj: Record<string, unknown>, key: string): number | string {
  const value = obj[key];
  if (typeof value === 'number' || typeof value === 'string') {
    seqFromWire(value);
    return value;
  }
  throw new UplinkCtlError(`invalid ${key}`);
}

function hNodeId(obj: Record<string, unknown>, key: string): string {
  const value = hNe(obj, key);
  if (!NODE_ID_HEX.test(value)) throw new UplinkCtlError(`invalid ${key}`);
  return value;
}

function hEndpoints(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length > UPLINK_CTL_MAX_ENDPOINTS) {
    throw new UplinkCtlError('too many endpoints');
  }
  return value;
}

function hTurn(value: unknown): NodeListMessage['rtc']['turn'] {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new UplinkCtlError('invalid rtc.turn');
  return {
    url: hNe(value, 'url'),
    username: hStr(value, 'username'),
    credential: hStr(value, 'credential'),
  };
}

function decodeHubNodeList(obj: Record<string, unknown>): NodeListMessage {
  if (!isRecord(obj.key_log_head)) throw new UplinkCtlError('invalid key_log_head');
  const hashBytes = b64urlToBytes(hStr(obj.key_log_head, 'hash'), 32);
  if (!isRecord(obj.rtc)) throw new UplinkCtlError('invalid rtc');
  if (!Array.isArray(obj.rtc.stun) || obj.rtc.stun.some((s) => typeof s !== 'string')) {
    throw new UplinkCtlError('invalid rtc.stun');
  }
  if (!Array.isArray(obj.nodes)) throw new UplinkCtlError('invalid nodes');
  const msg: NodeListMessage = {
    t: 'node.list',
    version: hInt(obj, 'version'),
    key_log_head: { seq: hSeq(obj.key_log_head, 'seq'), hash: bytesToB64url(hashBytes) },
    rtc: { stun: obj.rtc.stun as string[], turn: hTurn(obj.rtc.turn) },
    nodes: obj.nodes.map((value) => {
      if (!isRecord(value)) throw new UplinkCtlError('invalid node entry');
      const version = value.version;
      if (version !== null && version !== undefined && typeof version !== 'string') {
        throw new UplinkCtlError('invalid node.version');
      }
      return {
        id: hNe(value, 'id'),
        name: hStr(value, 'name'),
        online: hBool(value, 'online'),
        endpoints: hEndpoints(value.endpoints),
        inventory: value.inventory ?? null,
        direct_capable: hBool(value, 'direct_capable'),
        version: typeof version === 'string' ? version : null,
      };
    }),
  };
  if (obj.hub !== undefined && obj.hub !== null) {
    if (!isRecord(obj.hub)) throw new UplinkCtlError('invalid hub');
    const info: NodeListHubInfo = {
      nodeId: hNe(obj.hub, 'nodeId'),
      publicUrl: hNe(obj.hub, 'publicUrl'),
    };
    if (obj.hub.name !== undefined && obj.hub.name !== null) info.name = hNe(obj.hub, 'name');
    msg.hub = info;
  }
  return applyNodeListExtras(msg, obj);
}

function decodeHubInner(
  input: Uint8Array | string,
  opts?: { allowKeyLogRes?: boolean }
): HubUplinkCtlMessage {
  const byteLength = typeof input === 'string' ? te.encode(input).byteLength : input.byteLength;
  if (byteLength > UPLINK_CTL_MAX_BYTES) throw new UplinkCtlError('ctl too large');
  const text = typeof input === 'string' ? input : td.decode(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UplinkCtlError('invalid json');
  }
  const parsedT = isRecord(parsed) ? parsed.t : undefined;
  if (parsedT === 'key.log.res' && !opts?.allowKeyLogRes) {
    throw new UplinkCtlError('unexpected key.log.res');
  }
  if (parsedT !== 'key.log.res') assertCtlBounds(parsed, 0);
  if (!isRecord(parsed)) throw new UplinkCtlError('invalid ctl');
  const t = parsed.t;
  if (typeof t !== 'string' || !TYPE_SET.has(t))
    throw new UplinkCtlError(`unknown t: ${String(t)}`);
  switch (t as UplinkCtlType) {
    case 'auth.challenge':
      return {
        t: 'auth.challenge',
        nonce: bytesToB64url(b64urlToBytes(hStr(parsed, 'nonce'), 32)),
      };
    case 'auth.response':
      return {
        t: 'auth.response',
        node_id: hNodeId(parsed, 'node_id'),
        sig: bytesToB64url(b64urlToBytes(hStr(parsed, 'sig'), 64)),
      };
    case 'auth.ok':
      return { t: 'auth.ok' };
    case 'ping':
      return { t: 'ping' };
    case 'pong':
      return { t: 'pong' };
    case 'node.status': {
      const status: NodeStatusMessage = {
        t: 'node.status',
        version: hStr(parsed, 'version'),
        tmux: hBool(parsed, 'tmux'),
        direct_capable: hBool(parsed, 'direct_capable'),
        inventory: parsed.inventory ?? null,
        endpoints: hEndpoints(parsed.endpoints),
      };
      if (parsed.hub !== undefined && parsed.hub !== null) {
        status.hub = parseHubAdvertisement(parsed.hub);
      }
      return status;
    }
    case 'node.list':
      return decodeHubNodeList(parsed);
    case 'key.log.req': {
      const req: KeyLogReqMessage = { t: 'key.log.req', from_seq: hSeq(parsed, 'from_seq') };
      if (parsed.id !== undefined && parsed.id !== null) req.id = hNe(parsed, 'id');
      if (parsed.limit !== undefined && parsed.limit !== null) {
        req.limit = hInt(parsed, 'limit');
        if (req.limit < 1) throw new UplinkCtlError('invalid limit');
      }
      return req;
    }
    case 'key.log.res': {
      if (!Array.isArray(parsed.records)) throw new UplinkCtlError('invalid records');
      const records = parsed.records.map((item) => {
        if (!isRecord(item)) throw new UplinkCtlError('invalid record');
        return {
          seq: hSeq(item, 'seq'),
          bytes: bytesToB64url(b64urlToBytes(hStr(item, 'bytes'))),
          sig: bytesToB64url(b64urlToBytes(hStr(item, 'sig'), 64)),
        };
      });
      if (records.length > KEY_LOG_PAGE_MAX_LIMIT)
        throw new UplinkCtlError('key.log.res too many records');
      const res: KeyLogResMessage = { t: 'key.log.res', records };
      if (parsed.id !== undefined && parsed.id !== null) res.id = hNe(parsed, 'id');
      if (parsed.error !== undefined && parsed.error !== null) res.error = hNe(parsed, 'error');
      if (parsed.has_more !== undefined && parsed.has_more !== null) {
        res.has_more = hBool(parsed, 'has_more');
      }
      if (parsed.retry_after_ms !== undefined && parsed.retry_after_ms !== null) {
        res.retry_after_ms = hInt(parsed, 'retry_after_ms');
        if (res.retry_after_ms < 0) throw new UplinkCtlError('invalid retry_after_ms');
      }
      return res;
    }
    case 'key.log.append': {
      const msg: KeyLogAppendMessage = {
        t: 'key.log.append',
        bytes: bytesToB64url(b64urlToBytes(hStr(parsed, 'bytes'))),
        sig: bytesToB64url(b64urlToBytes(hStr(parsed, 'sig'), 64)),
      };
      if (parsed.id !== undefined && parsed.id !== null) msg.id = hNe(parsed, 'id');
      return msg;
    }
    case 'key.log.ack': {
      const ok = hBool(parsed, 'ok');
      const msg: KeyLogAckMessage = { t: 'key.log.ack', id: hNe(parsed, 'id'), ok };
      if (ok) msg.seq = hSeq(parsed, 'seq');
      else msg.error = hNe(parsed, 'error');
      return msg;
    }
    case 'rtc.signal': {
      const from = parsed.from;
      if (from !== 'browser' && from !== 'node') throw new UplinkCtlError('invalid rtc.from');
      if (parsed.sdp !== undefined && parsed.sdp !== null && typeof parsed.sdp !== 'string') {
        throw new UplinkCtlError('invalid rtc.sdp');
      }
      if (
        parsed.candidate !== undefined &&
        parsed.candidate !== null &&
        typeof parsed.candidate !== 'string'
      ) {
        throw new UplinkCtlError('invalid rtc.candidate');
      }
      const msg: RtcSignalMessage = {
        t: 'rtc.signal',
        rtcSession: hNe(parsed, 'rtcSession'),
        from,
        to: hNe(parsed, 'to'),
      };
      if (typeof parsed.sdp === 'string') msg.sdp = parsed.sdp;
      if (typeof parsed.candidate === 'string') msg.candidate = parsed.candidate;
      return msg;
    }
    case 'enroll.redeemed': {
      const certBytes = b64urlToBytes(hStr(parsed, 'certificate'));
      if (certBytes.byteLength > UPLINK_CTL_MAX_CERT_BYTES)
        throw new UplinkCtlError('certificate too large');
      const msg: EnrollRedeemedMessage = {
        t: 'enroll.redeemed',
        certificate: bytesToB64url(certBytes),
        cert_sig: bytesToB64url(b64urlToBytes(hStr(parsed, 'cert_sig'), 64)),
        enroll_pk: bytesToB64url(b64urlToBytes(hStr(parsed, 'enroll_pk'), 32)),
        node_id: hNodeId(parsed, 'node_id'),
      };
      if (parsed.entry_sid !== undefined && parsed.entry_sid !== null) {
        msg.entry_sid = hNe(parsed, 'entry_sid');
      }
      if (parsed.already_admitted !== undefined && parsed.already_admitted !== null) {
        msg.already_admitted = hBool(parsed, 'already_admitted');
      }
      return msg;
    }
  }
  throw new UplinkCtlError(`unknown t: ${t}`);
}

export function decodeHubUplinkCtl(
  input: Uint8Array | string,
  opts?: { allowKeyLogRes?: boolean }
): HubUplinkCtlMessage {
  return wrapHub(() => decodeHubInner(input, opts));
}

export function encodeHubUplinkCtl(
  msg: HubUplinkCtlMessage,
  opts?: EncodeUplinkCtlOptions
): Uint8Array {
  if (opts?.legacy === true) {
    if (msg.t === 'node.list') {
      const { hubs: _hubs, writerHubId: _id, writerEpoch: _epoch, ...rest } = msg;
      return encodeJsonBytes(rest);
    }
    if (msg.t === 'node.status') {
      const { hub: _hub, ...rest } = msg;
      return encodeJsonBytes(rest);
    }
  }
  if (msg.t === 'node.list') {
    if (msg.hubs) parseHubs(msg.hubs);
    if (msg.writerHubId) mNodeId(msg.writerHubId, 'writerHubId');
    if (msg.writerEpoch !== undefined) mNonNegInt(msg.writerEpoch, 'writerEpoch');
  } else if (msg.t === 'node.status' && msg.hub) {
    parseHubAdvertisement(msg.hub);
  }
  return encodeJsonBytes(msg);
}
