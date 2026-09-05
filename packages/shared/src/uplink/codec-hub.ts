import { type CtlDecodeProfile, decodeUplinkCtl } from './codec-decode';
import {
  type EncodeUplinkCtlOptions,
  type RtcSignalFrom,
  UPLINK_CTL_MAX_BYTES,
  UPLINK_CTL_MAX_ENDPOINTS,
  UplinkCtlError,
  b64urlToBytes,
  bytesToB64url,
  ctlRead,
  encodeJsonBytes,
  hubRead,
  isRecord,
} from './codec-fields';
import {
  type HubAdvertisement,
  type HubAttachmentsMessage,
  type HubEndpointInfo,
  type HubForwardMessage,
  type HubTokensMessage,
  type HubWriteForwardMessage,
  applyNodeListExtras,
  encodeHubWriteForwardMessage,
  parseHubAdvertisement,
  parseHubs,
  stripAttachedHubId,
} from './codec-hub-frames';

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
  attachedHubId?: string;
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
  | EnrollRedeemedMessage
  | HubTokensMessage
  | HubAttachmentsMessage
  | HubForwardMessage
  | HubWriteForwardMessage;

function wrapHub<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof UplinkCtlError) throw e;
    throw new UplinkCtlError(e instanceof Error ? e.message : 'invalid ctl');
  }
}

function wrapFrame<T>(fallback: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new UplinkCtlError(err instanceof Error ? err.message : fallback);
  }
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
    url: hubRead.nonEmptyStr(value.url, 'url'),
    username: hubRead.str(value.username, 'username'),
    credential: hubRead.str(value.credential, 'credential'),
  };
}

function decodeHubNodeEntry(value: unknown): NodeListEntry {
  if (!isRecord(value)) throw new UplinkCtlError('invalid node entry');
  const version = value.version;
  if (version !== null && version !== undefined && typeof version !== 'string') {
    throw new UplinkCtlError('invalid node.version');
  }
  const entry: NodeListEntry = {
    id: hubRead.nonEmptyStr(value.id, 'id'),
    name: hubRead.str(value.name, 'name'),
    online: hubRead.bool(value.online, 'online'),
    endpoints: hEndpoints(value.endpoints),
    inventory: value.inventory ?? null,
    direct_capable: hubRead.bool(value.direct_capable, 'direct_capable'),
    version: typeof version === 'string' ? version : null,
  };
  if (value.attachedHubId !== undefined && value.attachedHubId !== null) {
    entry.attachedHubId = hubRead.nodeId(value.attachedHubId, 'attachedHubId');
  }
  return entry;
}

function decodeHubNodeList(obj: Record<string, unknown>): NodeListMessage {
  if (!isRecord(obj.key_log_head)) throw new UplinkCtlError('invalid key_log_head');
  const hashBytes = b64urlToBytes(hubRead.str(obj.key_log_head.hash, 'hash'), 32);
  if (!isRecord(obj.rtc)) throw new UplinkCtlError('invalid rtc');
  if (!Array.isArray(obj.rtc.stun) || obj.rtc.stun.some((s) => typeof s !== 'string')) {
    throw new UplinkCtlError('invalid rtc.stun');
  }
  if (!Array.isArray(obj.nodes)) throw new UplinkCtlError('invalid nodes');
  const msg: NodeListMessage = {
    t: 'node.list',
    version: hubRead.int(obj.version, 'version'),
    key_log_head: {
      seq: hubRead.seqWire(obj.key_log_head.seq, 'seq'),
      hash: bytesToB64url(hashBytes),
    },
    rtc: { stun: obj.rtc.stun as string[], turn: hTurn(obj.rtc.turn) },
    nodes: obj.nodes.map(decodeHubNodeEntry),
  };
  if (obj.hub !== undefined && obj.hub !== null) {
    if (!isRecord(obj.hub)) throw new UplinkCtlError('invalid hub');
    const info: NodeListHubInfo = {
      nodeId: hubRead.nonEmptyStr(obj.hub.nodeId, 'nodeId'),
      publicUrl: hubRead.nonEmptyStr(obj.hub.publicUrl, 'publicUrl'),
    };
    if (obj.hub.name !== undefined && obj.hub.name !== null) {
      info.name = hubRead.nonEmptyStr(obj.hub.name, 'name');
    }
    msg.hub = info;
  }
  return applyNodeListExtras(msg, obj);
}

const hubProfile: CtlDecodeProfile<
  string,
  number | string,
  NodeListMessage,
  EnrollRedeemedMessage
> = {
  readers: hubRead,
  fail: (message) => new UplinkCtlError(message),
  hardMaxBytes: UPLINK_CTL_MAX_BYTES,
  onJsonError: () => new UplinkCtlError('invalid json'),
  notObject: 'invalid ctl',
  unknownType: (t) => new UplinkCtlError(`unknown t: ${t}`),
  bytes(value, field, expectedLen, maxLen) {
    const raw = b64urlToBytes(hubRead.str(value, field), expectedLen);
    if (maxLen !== undefined && raw.byteLength > maxLen) {
      throw new UplinkCtlError(`${field} too large`);
    }
    return bytesToB64url(raw);
  },
  text: (value, field, expectedLen) =>
    bytesToB64url(b64urlToBytes(hubRead.str(value, field), expectedLen)),
  nodeIdText: (value, field) => hubRead.nodeId(value, field),
  optText: (value, field) =>
    value === undefined || value === null ? undefined : hubRead.nonEmptyStr(value, field),
  reqText: (value, field) => hubRead.nonEmptyStr(value, field),
  seq: (value, field) => hubRead.seqWire(value, field),
  inventory: (value) => value ?? null,
  endpoints: hEndpoints,
  keyLogSigLen: 64,
  keepAlreadyAdmitted: true,
  nodeList: decodeHubNodeList,
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
  frame: wrapFrame,
};

export function decodeHubUplinkCtl(
  input: Uint8Array | string,
  opts?: { allowKeyLogRes?: boolean }
): HubUplinkCtlMessage {
  return wrapHub(() => decodeUplinkCtl(input, hubProfile, opts));
}

function encodeHubLegacy(msg: HubUplinkCtlMessage): Uint8Array | null {
  if (msg.t === 'node.list') {
    const { hubs: _hubs, writerHubId: _id, writerEpoch: _epoch, ...rest } = msg;
    return encodeJsonBytes({ ...rest, nodes: rest.nodes.map(stripAttachedHubId) });
  }
  if (msg.t === 'node.status') {
    const { hub: _hub, ...rest } = msg;
    return encodeJsonBytes(rest);
  }
  if (
    msg.t === 'hub.tokens' ||
    msg.t === 'hub.attachments' ||
    msg.t === 'hub.forward' ||
    msg.t === 'hub.write-forward'
  ) {
    return encodeJsonBytes({ t: msg.t });
  }
  if (msg.t === 'key.log.append') {
    const { force: _force, ...rest } = msg;
    return encodeJsonBytes(rest);
  }
  return null;
}

export function encodeHubUplinkCtl(
  msg: HubUplinkCtlMessage,
  opts?: EncodeUplinkCtlOptions
): Uint8Array {
  if (opts?.legacy === true) {
    const legacy = encodeHubLegacy(msg);
    if (legacy) return legacy;
  }
  if (msg.t === 'node.list') {
    if (msg.hubs) parseHubs(msg.hubs);
    if (msg.writerHubId) ctlRead.nodeId(msg.writerHubId, 'writerHubId');
    if (msg.writerEpoch !== undefined) ctlRead.nonNegInt(msg.writerEpoch, 'writerEpoch');
  } else if (msg.t === 'node.status' && msg.hub) {
    parseHubAdvertisement(msg.hub);
  } else if (msg.t === 'hub.write-forward') {
    return encodeHubWriteForwardMessage(msg, false);
  }
  return encodeJsonBytes(msg);
}
