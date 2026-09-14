import { type CtlDecodeProfile, decodeUplinkCtl, parsePeerReachMap } from './codec-decode';
import {
  type EncodeUplinkCtlOptions,
  type RtcSignalFrom,
  UPLINK_CTL_MAX_BYTES,
  UPLINK_CTL_MAX_ENDPOINTS,
  UplinkCtlError,
  b64urlToBytes,
  bytesToB64url,
  encodeJsonBytes,
  isRecord,
  peerRead,
} from './codec-fields';

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
  peer_reach?: Record<string, 'ok' | 'refused' | 'timeout'>;
  peer_reach_epoch?: number;
};
export type NodeListEntry = {
  id: string;
  name: string;
  online: boolean;
  endpoints: unknown;
  inventory: unknown;
  direct_capable: boolean;
  version: string | null;
  peer_reach?: Record<string, 'ok' | 'refused' | 'timeout'>;
};
export type NodeListMessage = {
  t: 'node.list';
  version: number;
  key_log_head: { seq: number | string; hash: string };
  rtc: { stun: string[]; turn: { url: string; username: string; credential: string } | null };
  nodes: NodeListEntry[];
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
export type KeyLogAppendMessage = {
  t: 'key.log.append';
  bytes: string;
  sig: string;
  id?: string;
  force?: boolean;
};
type KeyLogAckMessage = {
  t: 'key.log.ack';
  id: string;
  ok: boolean;
  seq?: number | string;
  error?: string;
};
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
export type PeerUplinkCtlMessage =
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

function wrapPeer<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof UplinkCtlError) throw e;
    throw new UplinkCtlError(e instanceof Error ? e.message : 'invalid ctl');
  }
}

function pEndpoints(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length > UPLINK_CTL_MAX_ENDPOINTS) {
    throw new UplinkCtlError('too many endpoints');
  }
  return value;
}

function pTurn(value: unknown): NodeListMessage['rtc']['turn'] {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new UplinkCtlError('invalid rtc.turn');
  return {
    url: peerRead.nonEmptyStr(value.url, 'url'),
    username: peerRead.str(value.username, 'username'),
    credential: peerRead.str(value.credential, 'credential'),
  };
}

function decodePeerNodeEntry(value: unknown): NodeListEntry {
  if (!isRecord(value)) throw new UplinkCtlError('invalid node entry');
  const version = value.version;
  if (version !== null && version !== undefined && typeof version !== 'string') {
    throw new UplinkCtlError('invalid node.version');
  }
  const entry: NodeListEntry = {
    id: peerRead.nonEmptyStr(value.id, 'id'),
    name: peerRead.str(value.name, 'name'),
    online: peerRead.bool(value.online, 'online'),
    endpoints: pEndpoints(value.endpoints),
    inventory: value.inventory ?? null,
    direct_capable: peerRead.bool(value.direct_capable, 'direct_capable'),
    version: typeof version === 'string' ? version : null,
  };
  const peerReach = parsePeerReachMap(value.peer_reach);
  if (peerReach) entry.peer_reach = peerReach;
  return entry;
}

function decodePeerNodeList(obj: Record<string, unknown>): NodeListMessage {
  if (!isRecord(obj.key_log_head)) throw new UplinkCtlError('invalid key_log_head');
  const hashBytes = b64urlToBytes(peerRead.str(obj.key_log_head.hash, 'hash'), 32);
  if (!isRecord(obj.rtc)) throw new UplinkCtlError('invalid rtc');
  if (!Array.isArray(obj.rtc.stun) || obj.rtc.stun.some((s) => typeof s !== 'string')) {
    throw new UplinkCtlError('invalid rtc.stun');
  }
  if (!Array.isArray(obj.nodes)) throw new UplinkCtlError('invalid nodes');
  return {
    t: 'node.list',
    version: peerRead.int(obj.version, 'version'),
    key_log_head: {
      seq: peerRead.seqWire(obj.key_log_head.seq, 'seq'),
      hash: bytesToB64url(hashBytes),
    },
    rtc: { stun: obj.rtc.stun as string[], turn: pTurn(obj.rtc.turn) },
    nodes: obj.nodes.map(decodePeerNodeEntry),
  };
}

const peerProfile: CtlDecodeProfile<
  string,
  number | string,
  NodeListMessage,
  EnrollRedeemedMessage
> = {
  readers: peerRead,
  fail: (message) => new UplinkCtlError(message),
  hardMaxBytes: UPLINK_CTL_MAX_BYTES,
  onJsonError: () => new UplinkCtlError('invalid json'),
  notObject: 'invalid ctl',
  unknownType: (t) => new UplinkCtlError(`unknown t: ${t}`),
  notStringType: (value) => new UplinkCtlError(`unknown t: ${String(value)}`),
  bytes(value, field, expectedLen, maxLen) {
    const raw = b64urlToBytes(peerRead.str(value, field), expectedLen);
    if (maxLen !== undefined && raw.byteLength > maxLen) {
      throw new UplinkCtlError(`${field} too large`);
    }
    return bytesToB64url(raw);
  },
  text: (value, field, expectedLen) =>
    bytesToB64url(b64urlToBytes(peerRead.str(value, field), expectedLen)),
  nodeIdText: (value, field) => peerRead.nodeId(value, field),
  optText: (value, field) =>
    value === undefined || value === null ? undefined : peerRead.nonEmptyStr(value, field),
  reqText: (value, field) => peerRead.nonEmptyStr(value, field),
  seq: (value, field) => peerRead.seqWire(value, field),
  inventory: (value) => value ?? null,
  endpoints: pEndpoints,
  keyLogSigLen: 64,
  keepAlreadyAdmitted: true,
  keyLogRes: {
    notArray: 'invalid records',
    notObject: () => 'invalid record',
    field: (_index, name) => name,
  },
  rtcFrom(value) {
    if (value !== 'browser' && value !== 'node') throw new UplinkCtlError('invalid rtc.from');
    return value;
  },
  optSignalText(value, field) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new UplinkCtlError(`invalid rtc.${field}`);
    return value;
  },
  nodeList: decodePeerNodeList,
  enrollRedeemed(fields) {
    const msg: EnrollRedeemedMessage = {
      t: 'enroll.redeemed',
      certificate: fields.certificate,
      cert_sig: fields.certSig,
      enroll_pk: fields.enrollPk,
      node_id: fields.nodeId,
    };
    if (fields.entrySid !== undefined) msg.entry_sid = fields.entrySid;
    if (fields.alreadyAdmitted !== undefined) msg.already_admitted = fields.alreadyAdmitted;
    return msg;
  },
};

export function decodePeerUplinkCtl(
  input: Uint8Array | string,
  opts?: { allowKeyLogRes?: boolean }
): PeerUplinkCtlMessage {
  return wrapPeer(() => decodeUplinkCtl(input, peerProfile, opts));
}

function encodePeerLegacy(msg: PeerUplinkCtlMessage): Uint8Array | null {
  if (msg.t === 'key.log.append') {
    const { force: _force, ...rest } = msg;
    return encodeJsonBytes(rest);
  }
  return null;
}

export function encodePeerUplinkCtl(
  msg: PeerUplinkCtlMessage,
  opts?: EncodeUplinkCtlOptions
): Uint8Array {
  if (opts?.legacy === true) {
    const legacy = encodePeerLegacy(msg);
    if (legacy) return legacy;
  }
  return encodeJsonBytes(msg);
}
