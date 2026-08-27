import { decodeBase64url, encodeBase64url } from '@tmex/shared/auth';
import {
  decodeJsonBytes,
  encodeCtlMessage,
  isRecord,
  optionalString,
  parseSeq,
  requireBoolean,
  requireString,
  seqToJson,
} from './ctl';

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

export type UplinkAuthChallenge = { t: 'auth.challenge'; nonce: string };
export type UplinkAuthResponse = { t: 'auth.response'; node_id: string; sig: string };
export type UplinkAuthOk = { t: 'auth.ok' };
export type UplinkPing = { t: 'ping' };
export type UplinkPong = { t: 'pong' };

export type UplinkNodeStatusMsg = {
  t: 'node.status';
  version: string;
  tmux: boolean;
  direct_capable: boolean;
  inventory: unknown;
  endpoints: unknown;
};

export type UplinkNodeInfo = {
  id: string;
  name: string;
  online: boolean;
  endpoints: unknown;
  inventory: unknown;
  direct_capable: boolean;
  version: string;
};

export type UplinkKeyLogHead = {
  seq: bigint;
  hash: Uint8Array;
};

export type UplinkHubInfo = { nodeId: string; publicUrl: string };

export type UplinkNodeList = {
  t: 'node.list';
  version: number;
  key_log_head: UplinkKeyLogHead;
  rtc: { stun: string[]; turn: unknown };
  nodes: UplinkNodeInfo[];
  hub?: UplinkHubInfo;
};

export type UplinkKeyLogReq = { t: 'key.log.req'; from_seq: bigint };
export type UplinkKeyLogRecord = { seq: bigint; bytes: Uint8Array; sig: Uint8Array };
export type UplinkKeyLogRes = { t: 'key.log.res'; records: UplinkKeyLogRecord[] };
export type UplinkKeyLogAppend = {
  t: 'key.log.append';
  bytes: Uint8Array;
  sig: Uint8Array;
  id?: string;
};
export type UplinkKeyLogAck = {
  t: 'key.log.ack';
  id: string;
  ok: boolean;
  seq?: bigint;
  error?: string;
};

export type UplinkRtcSignal = {
  t: 'rtc.signal';
  rtcSession: string;
  from: 'browser' | 'node';
  to: string;
  sdp?: string;
  candidate?: string;
};

export type UplinkEnrollRedeemed = {
  t: 'enroll.redeemed';
  certificate: Uint8Array;
  cert_sig: Uint8Array;
  enroll_pk: Uint8Array;
  nodeId: string;
  entrySid?: string;
};

export type UplinkCtlMessage =
  | UplinkAuthChallenge
  | UplinkAuthResponse
  | UplinkAuthOk
  | UplinkPing
  | UplinkPong
  | UplinkNodeStatusMsg
  | UplinkNodeList
  | UplinkKeyLogReq
  | UplinkKeyLogRes
  | UplinkKeyLogAppend
  | UplinkKeyLogAck
  | UplinkRtcSignal
  | UplinkEnrollRedeemed;

const TYPE_SET = new Set<string>(UPLINK_CTL_TYPES);
const NODE_ID_HEX_RE = /^[0-9a-f]{32}$/i;

export const UPLINK_CTL_MAX_BYTES = 64 * 1024;
export const UPLINK_CTL_MAX_DEPTH = 8;
export const UPLINK_CTL_MAX_ARRAY_LEN = 1024;
export const UPLINK_CTL_MAX_STRING_LEN = 4 * 1024;
export const UPLINK_CTL_MAX_CERT_BYTES = 2048;

function requireB64(value: unknown, field: string, expectedLen?: number): Uint8Array {
  const bytes = decodeBase64url(requireString(value, field));
  if (expectedLen !== undefined && bytes.byteLength !== expectedLen) {
    throw new Error(`ctl field ${field} expected ${expectedLen} bytes`);
  }
  return bytes;
}

function requireNodeIdHex(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!NODE_ID_HEX_RE.test(id)) {
    throw new Error(`ctl field ${field} must be 32-hex`);
  }
  return id;
}

function assertCtlBounds(value: unknown, depth: number): void {
  if (depth > UPLINK_CTL_MAX_DEPTH) {
    throw new Error('ctl too deep');
  }
  if (typeof value === 'string' && value.length > UPLINK_CTL_MAX_STRING_LEN) {
    throw new Error('ctl string too long');
  }
  if (Array.isArray(value)) {
    if (value.length > UPLINK_CTL_MAX_ARRAY_LEN) {
      throw new Error('ctl array too long');
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

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`ctl field ${field} must be a number`);
  }
  return value;
}

function parseNodeInfo(value: unknown): UplinkNodeInfo {
  if (!isRecord(value)) {
    throw new Error('node.list node must be an object');
  }
  return {
    id: requireString(value.id, 'nodes[].id'),
    name: requireString(value.name, 'nodes[].name'),
    online: requireBoolean(value.online, 'nodes[].online'),
    endpoints: value.endpoints ?? [],
    inventory: value.inventory ?? {},
    direct_capable: requireBoolean(value.direct_capable, 'nodes[].direct_capable'),
    version: requireString(value.version, 'nodes[].version'),
  };
}

export function decodeUplinkCtl(bytes: Uint8Array): UplinkCtlMessage {
  if (bytes.byteLength > UPLINK_CTL_MAX_BYTES) {
    throw new Error('ctl too large');
  }
  const parsed = decodeJsonBytes(bytes);
  assertCtlBounds(parsed, 0);
  if (!isRecord(parsed) || typeof parsed.t !== 'string') {
    throw new Error('uplink ctl must be a JSON object with t');
  }
  if (!TYPE_SET.has(parsed.t)) {
    throw new Error(`unknown uplink ctl t: ${parsed.t}`);
  }
  switch (parsed.t as UplinkCtlType) {
    case 'auth.challenge':
      return { t: 'auth.challenge', nonce: requireString(parsed.nonce, 'nonce') };
    case 'auth.response':
      return {
        t: 'auth.response',
        node_id: requireString(parsed.node_id, 'node_id'),
        sig: requireString(parsed.sig, 'sig'),
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
        version: requireString(parsed.version, 'version'),
        tmux: requireBoolean(parsed.tmux, 'tmux'),
        direct_capable: requireBoolean(parsed.direct_capable, 'direct_capable'),
        inventory: parsed.inventory ?? {},
        endpoints: parsed.endpoints ?? [],
      };
    case 'node.list': {
      if (!isRecord(parsed.key_log_head)) {
        throw new Error('node.list key_log_head must be an object');
      }
      if (!isRecord(parsed.rtc)) {
        throw new Error('node.list rtc must be an object');
      }
      if (!Array.isArray(parsed.nodes)) {
        throw new Error('node.list nodes must be an array');
      }
      const stun = parsed.rtc.stun;
      const list: UplinkNodeList = {
        t: 'node.list',
        version: requireNumber(parsed.version, 'version'),
        key_log_head: {
          seq: parseSeq(parsed.key_log_head.seq, 'key_log_head.seq'),
          hash: requireB64(parsed.key_log_head.hash, 'key_log_head.hash'),
        },
        rtc: {
          stun: Array.isArray(stun)
            ? stun.map((item, i) => requireString(item, `rtc.stun[${i}]`))
            : [],
          turn: parsed.rtc.turn ?? null,
        },
        nodes: parsed.nodes.map(parseNodeInfo),
      };
      if (parsed.hub !== undefined && parsed.hub !== null) {
        list.hub = parseHubInfo(parsed.hub);
      }
      return list;
    }
    case 'key.log.req':
      return { t: 'key.log.req', from_seq: parseSeq(parsed.from_seq, 'from_seq') };
    case 'key.log.res': {
      if (!Array.isArray(parsed.records)) {
        throw new Error('key.log.res records must be an array');
      }
      return {
        t: 'key.log.res',
        records: parsed.records.map((row, i) => {
          if (!isRecord(row)) throw new Error(`key.log.res records[${i}] must be an object`);
          return {
            seq: parseSeq(row.seq, `records[${i}].seq`),
            bytes: requireB64(row.bytes, `records[${i}].bytes`),
            sig: requireB64(row.sig, `records[${i}].sig`),
          };
        }),
      };
    }
    case 'key.log.append': {
      const append: UplinkKeyLogAppend = {
        t: 'key.log.append',
        bytes: requireB64(parsed.bytes, 'bytes'),
        sig: requireB64(parsed.sig, 'sig'),
      };
      const id = optionalString(parsed.id, 'id');
      if (id) append.id = id;
      return append;
    }
    case 'key.log.ack': {
      const ok = requireBoolean(parsed.ok, 'ok');
      const ack: UplinkKeyLogAck = {
        t: 'key.log.ack',
        id: requireString(parsed.id, 'id'),
        ok,
      };
      if (ok) {
        ack.seq = parseSeq(parsed.seq, 'seq');
      } else {
        ack.error = requireString(parsed.error, 'error');
      }
      return ack;
    }
    case 'rtc.signal': {
      const from = requireString(parsed.from, 'from');
      if (from !== 'browser' && from !== 'node') {
        throw new Error('rtc.signal from must be browser|node');
      }
      return {
        t: 'rtc.signal',
        rtcSession: requireString(parsed.rtcSession, 'rtcSession'),
        from,
        to: requireString(parsed.to, 'to'),
        sdp: optionalString(parsed.sdp, 'sdp'),
        candidate: optionalString(parsed.candidate, 'candidate'),
      };
    }
    case 'enroll.redeemed': {
      const certificate = requireB64(parsed.certificate, 'certificate');
      if (certificate.byteLength > UPLINK_CTL_MAX_CERT_BYTES) {
        throw new Error('ctl field certificate too large');
      }
      const msg: UplinkEnrollRedeemed = {
        t: 'enroll.redeemed',
        certificate,
        cert_sig: requireB64(parsed.cert_sig, 'cert_sig', 64),
        enroll_pk: requireB64(parsed.enroll_pk, 'enroll_pk', 32),
        nodeId: requireNodeIdHex(parsed.node_id, 'node_id'),
      };
      const entrySid = optionalString(parsed.entry_sid, 'entry_sid');
      if (entrySid) msg.entrySid = entrySid;
      return msg;
    }
  }
}

function parseHubInfo(value: unknown): UplinkHubInfo {
  if (!isRecord(value)) {
    throw new Error('node.list hub must be an object');
  }
  return {
    nodeId: requireNodeIdHex(value.nodeId, 'hub.nodeId'),
    publicUrl: requireString(value.publicUrl, 'hub.publicUrl'),
  };
}

export function encodeUplinkCtl(msg: UplinkCtlMessage): Uint8Array {
  switch (msg.t) {
    case 'auth.challenge':
    case 'auth.response':
    case 'auth.ok':
    case 'ping':
    case 'pong':
    case 'node.status':
      return encodeCtlMessage(msg);
    case 'node.list':
      return encodeCtlMessage({
        t: 'node.list',
        version: msg.version,
        key_log_head: {
          seq: seqToJson(msg.key_log_head.seq),
          hash: encodeBase64url(msg.key_log_head.hash),
        },
        rtc: msg.rtc,
        nodes: msg.nodes,
        ...(msg.hub ? { hub: msg.hub } : {}),
      });
    case 'key.log.req':
      return encodeCtlMessage({ t: 'key.log.req', from_seq: seqToJson(msg.from_seq) });
    case 'key.log.res':
      return encodeCtlMessage({
        t: 'key.log.res',
        records: msg.records.map((row) => ({
          seq: seqToJson(row.seq),
          bytes: encodeBase64url(row.bytes),
          sig: encodeBase64url(row.sig),
        })),
      });
    case 'key.log.append':
      return encodeCtlMessage({
        t: 'key.log.append',
        bytes: encodeBase64url(msg.bytes),
        sig: encodeBase64url(msg.sig),
        ...(msg.id ? { id: msg.id } : {}),
      });
    case 'key.log.ack':
      return encodeCtlMessage({
        t: 'key.log.ack',
        id: msg.id,
        ok: msg.ok,
        ...(msg.ok ? { seq: seqToJson(msg.seq ?? 0n) } : { error: msg.error ?? 'error' }),
      });
    case 'rtc.signal':
      return encodeCtlMessage({
        t: 'rtc.signal',
        rtcSession: msg.rtcSession,
        from: msg.from,
        to: msg.to,
        ...(msg.sdp !== undefined ? { sdp: msg.sdp } : {}),
        ...(msg.candidate !== undefined ? { candidate: msg.candidate } : {}),
      });
    case 'enroll.redeemed':
      return encodeCtlMessage({
        t: 'enroll.redeemed',
        certificate: encodeBase64url(msg.certificate),
        cert_sig: encodeBase64url(msg.cert_sig),
        enroll_pk: encodeBase64url(msg.enroll_pk),
        node_id: msg.nodeId,
        ...(msg.entrySid ? { entry_sid: msg.entrySid } : {}),
      });
  }
}

export function uplinkWsUrl(hubUrl: string): string {
  const url = new URL(hubUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  url.pathname = '/hub/uplink';
  url.search = '';
  url.hash = '';
  return url.toString();
}
