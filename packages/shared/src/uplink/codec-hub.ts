import {
  type EncodeUplinkCtlOptions,
  KEY_LOG_PAGE_MAX_LIMIT,
  type RtcSignalFrom,
  TYPE_SET,
  UPLINK_CTL_MAX_BYTES,
  UPLINK_CTL_MAX_CERT_BYTES,
  UPLINK_CTL_MAX_ENDPOINTS,
  UplinkCtlError,
  type UplinkCtlType,
  assertCtlBounds,
  b64urlToBytes,
  bytesToB64url,
  ctlRead,
  decodeUtf8,
  encodeJsonBytes,
  hubRead,
  isRecord,
  skipsCtlBounds,
  utf8ByteLength,
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
  parseHubAttachmentsMessage,
  parseHubForwardMessage,
  parseHubTokensMessage,
  parseHubWriteForwardMessage,
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

function decodeHubKeyLogRes(parsed: Record<string, unknown>): KeyLogResMessage {
  if (!Array.isArray(parsed.records)) throw new UplinkCtlError('invalid records');
  const records = parsed.records.map((item) => {
    if (!isRecord(item)) throw new UplinkCtlError('invalid record');
    return {
      seq: hubRead.seqWire(item.seq, 'seq'),
      bytes: bytesToB64url(b64urlToBytes(hubRead.str(item.bytes, 'bytes'))),
      sig: bytesToB64url(b64urlToBytes(hubRead.str(item.sig, 'sig'), 64)),
    };
  });
  if (records.length > KEY_LOG_PAGE_MAX_LIMIT) {
    throw new UplinkCtlError('key.log.res too many records');
  }
  const res: KeyLogResMessage = { t: 'key.log.res', records };
  if (parsed.id !== undefined && parsed.id !== null) res.id = hubRead.nonEmptyStr(parsed.id, 'id');
  if (parsed.error !== undefined && parsed.error !== null) {
    res.error = hubRead.nonEmptyStr(parsed.error, 'error');
  }
  if (parsed.has_more !== undefined && parsed.has_more !== null) {
    res.has_more = hubRead.bool(parsed.has_more, 'has_more');
  }
  if (parsed.retry_after_ms !== undefined && parsed.retry_after_ms !== null) {
    res.retry_after_ms = hubRead.int(parsed.retry_after_ms, 'retry_after_ms');
    if (res.retry_after_ms < 0) throw new UplinkCtlError('invalid retry_after_ms');
  }
  return res;
}

function decodeHubRtcSignal(parsed: Record<string, unknown>): RtcSignalMessage {
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
    rtcSession: hubRead.nonEmptyStr(parsed.rtcSession, 'rtcSession'),
    from,
    to: hubRead.nonEmptyStr(parsed.to, 'to'),
  };
  if (typeof parsed.sdp === 'string') msg.sdp = parsed.sdp;
  if (typeof parsed.candidate === 'string') msg.candidate = parsed.candidate;
  return msg;
}

function decodeHubEnrollRedeemed(parsed: Record<string, unknown>): EnrollRedeemedMessage {
  const certBytes = b64urlToBytes(hubRead.str(parsed.certificate, 'certificate'));
  if (certBytes.byteLength > UPLINK_CTL_MAX_CERT_BYTES) {
    throw new UplinkCtlError('certificate too large');
  }
  const msg: EnrollRedeemedMessage = {
    t: 'enroll.redeemed',
    certificate: bytesToB64url(certBytes),
    cert_sig: bytesToB64url(b64urlToBytes(hubRead.str(parsed.cert_sig, 'cert_sig'), 64)),
    enroll_pk: bytesToB64url(b64urlToBytes(hubRead.str(parsed.enroll_pk, 'enroll_pk'), 32)),
    node_id: hubRead.nodeId(parsed.node_id, 'node_id'),
  };
  if (parsed.entry_sid !== undefined && parsed.entry_sid !== null) {
    msg.entry_sid = hubRead.nonEmptyStr(parsed.entry_sid, 'entry_sid');
  }
  if (parsed.already_admitted !== undefined && parsed.already_admitted !== null) {
    msg.already_admitted = hubRead.bool(parsed.already_admitted, 'already_admitted');
  }
  return msg;
}

function decodeHubInner(
  input: Uint8Array | string,
  opts?: { allowKeyLogRes?: boolean }
): HubUplinkCtlMessage {
  const byteLength = typeof input === 'string' ? utf8ByteLength(input) : input.byteLength;
  if (byteLength > UPLINK_CTL_MAX_BYTES) throw new UplinkCtlError('ctl too large');
  const text = typeof input === 'string' ? input : decodeUtf8(input);
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
  if (!skipsCtlBounds(parsedT)) assertCtlBounds(parsed, 0);
  if (!isRecord(parsed)) throw new UplinkCtlError('invalid ctl');
  const t = parsed.t;
  if (typeof t !== 'string' || !TYPE_SET.has(t))
    throw new UplinkCtlError(`unknown t: ${String(t)}`);
  switch (t as UplinkCtlType) {
    case 'auth.challenge':
      return {
        t: 'auth.challenge',
        nonce: bytesToB64url(b64urlToBytes(hubRead.str(parsed.nonce, 'nonce'), 32)),
      };
    case 'auth.response':
      return {
        t: 'auth.response',
        node_id: hubRead.nodeId(parsed.node_id, 'node_id'),
        sig: bytesToB64url(b64urlToBytes(hubRead.str(parsed.sig, 'sig'), 64)),
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
        version: hubRead.str(parsed.version, 'version'),
        tmux: hubRead.bool(parsed.tmux, 'tmux'),
        direct_capable: hubRead.bool(parsed.direct_capable, 'direct_capable'),
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
      const req: KeyLogReqMessage = {
        t: 'key.log.req',
        from_seq: hubRead.seqWire(parsed.from_seq, 'from_seq'),
      };
      if (parsed.id !== undefined && parsed.id !== null) {
        req.id = hubRead.nonEmptyStr(parsed.id, 'id');
      }
      if (parsed.limit !== undefined && parsed.limit !== null) {
        req.limit = hubRead.int(parsed.limit, 'limit');
        if (req.limit < 1) throw new UplinkCtlError('invalid limit');
      }
      return req;
    }
    case 'key.log.res':
      return decodeHubKeyLogRes(parsed);
    case 'key.log.append': {
      const msg: KeyLogAppendMessage = {
        t: 'key.log.append',
        bytes: bytesToB64url(b64urlToBytes(hubRead.str(parsed.bytes, 'bytes'))),
        sig: bytesToB64url(b64urlToBytes(hubRead.str(parsed.sig, 'sig'), 64)),
      };
      if (parsed.id !== undefined && parsed.id !== null) {
        msg.id = hubRead.nonEmptyStr(parsed.id, 'id');
      }
      if (parsed.force !== undefined && parsed.force !== null) {
        msg.force = hubRead.bool(parsed.force, 'force');
      }
      return msg;
    }
    case 'key.log.ack': {
      const ok = hubRead.bool(parsed.ok, 'ok');
      const msg: KeyLogAckMessage = {
        t: 'key.log.ack',
        id: hubRead.nonEmptyStr(parsed.id, 'id'),
        ok,
      };
      if (ok) msg.seq = hubRead.seqWire(parsed.seq, 'seq');
      else msg.error = hubRead.nonEmptyStr(parsed.error, 'error');
      return msg;
    }
    case 'rtc.signal':
      return decodeHubRtcSignal(parsed);
    case 'enroll.redeemed':
      return decodeHubEnrollRedeemed(parsed);
    case 'hub.tokens':
      return wrapFrame('invalid hub.tokens', () => parseHubTokensMessage(parsed));
    case 'hub.attachments':
      return wrapFrame('invalid hub.attachments', () => parseHubAttachmentsMessage(parsed));
    case 'hub.forward':
      return wrapFrame('invalid hub.forward', () => parseHubForwardMessage(parsed));
    case 'hub.write-forward':
      return wrapFrame('invalid hub.write-forward', () => parseHubWriteForwardMessage(parsed));
  }
  throw new UplinkCtlError(`unknown t: ${t}`);
}

export function decodeHubUplinkCtl(
  input: Uint8Array | string,
  opts?: { allowKeyLogRes?: boolean }
): HubUplinkCtlMessage {
  return wrapHub(() => decodeHubInner(input, opts));
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
