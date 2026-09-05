import { encodeBase64url } from '../auth/encoding';
import {
  type EncodeUplinkCtlOptions,
  KEY_LOG_PAGE_MAX_BYTES,
  KEY_LOG_PAGE_MAX_LIMIT,
  TYPE_SET,
  UPLINK_CTL_MAX_BYTES,
  UPLINK_CTL_MAX_CERT_BYTES,
  type UplinkCtlType,
  assertCtlBounds,
  ctlRead,
  decodeJsonBytes,
  encodeJsonBytes,
  isRecord,
  seqToWire,
  skipsCtlBounds,
} from './codec-fields';
import {
  type HubAdvertisement,
  type HubAttachmentsMessage,
  type HubEndpointInfo,
  type HubForwardMessage,
  type HubTokensMessage,
  type HubWriteForwardMessage,
  applyNodeListExtras,
  encodeHubAttachmentsMessage,
  encodeHubForwardMessage,
  encodeHubTokensMessage,
  encodeHubWriteForwardMessage,
  parseHubAdvertisement,
  parseHubAttachmentsMessage,
  parseHubForwardMessage,
  parseHubTokensMessage,
  parseHubWriteForwardMessage,
  parseHubs,
  stripAttachedHubId,
} from './codec-hub-frames';

type MeshNodeInfo = {
  id: string;
  name: string;
  online: boolean;
  endpoints: unknown;
  inventory: unknown;
  direct_capable: boolean;
  version: string | null;
  attachedHubId?: string;
};

type MeshHubInfo = { nodeId: string; publicUrl: string; name?: string };

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
  | { t: 'key.log.append'; bytes: Uint8Array; sig: Uint8Array; id?: string; force?: boolean }
  | MeshUplinkKeyLogAck
  | MeshUplinkRtcSignal
  | MeshUplinkEnrollRedeemed
  | HubTokensMessage
  | HubAttachmentsMessage
  | HubForwardMessage
  | HubWriteForwardMessage;

function parseMeshNode(value: unknown): MeshNodeInfo {
  if (!isRecord(value)) throw new Error('node.list node must be an object');
  const node: MeshNodeInfo = {
    id: ctlRead.str(value.id, 'nodes[].id'),
    name: ctlRead.str(value.name, 'nodes[].name'),
    online: ctlRead.bool(value.online, 'nodes[].online'),
    endpoints: value.endpoints ?? [],
    inventory: value.inventory ?? {},
    direct_capable: ctlRead.bool(value.direct_capable, 'nodes[].direct_capable'),
    version: ctlRead.optStr(value.version, 'nodes[].version') ?? null,
  };
  if (value.attachedHubId !== undefined && value.attachedHubId !== null) {
    node.attachedHubId = ctlRead.nodeId(value.attachedHubId, 'nodes[].attachedHubId');
  }
  return node;
}

function parseMeshHub(value: unknown): MeshHubInfo {
  if (!isRecord(value)) throw new Error('node.list hub must be an object');
  const info: MeshHubInfo = {
    nodeId: ctlRead.nodeId(value.nodeId, 'hub.nodeId'),
    publicUrl: ctlRead.str(value.publicUrl, 'hub.publicUrl'),
  };
  const name = ctlRead.optStr(value.name, 'hub.name');
  if (name) info.name = name;
  return info;
}

function assertMeshCtlSize(
  bytes: Uint8Array,
  parsed: Record<string, unknown>,
  pendingKeyLogId?: string
): void {
  if (parsed.t === 'key.log.res' && bytes.byteLength > UPLINK_CTL_MAX_BYTES) {
    const resId = ctlRead.optStr(parsed.id, 'id');
    if (!resId || resId !== pendingKeyLogId) throw new Error('ctl too large');
    return;
  }
  if (bytes.byteLength > UPLINK_CTL_MAX_BYTES) throw new Error('ctl too large');
  if (!skipsCtlBounds(parsed.t)) assertCtlBounds(parsed, 0);
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
  assertMeshCtlSize(bytes, parsed, opts?.pendingKeyLogId);
  if (!TYPE_SET.has(parsed.t)) throw new Error(`unknown uplink ctl t: ${parsed.t}`);
  switch (parsed.t as UplinkCtlType) {
    case 'auth.challenge':
      return { t: 'auth.challenge', nonce: ctlRead.str(parsed.nonce, 'nonce') };
    case 'auth.response':
      return {
        t: 'auth.response',
        node_id: ctlRead.str(parsed.node_id, 'node_id'),
        sig: ctlRead.str(parsed.sig, 'sig'),
      };
    case 'auth.ok':
      return { t: 'auth.ok' };
    case 'ping':
      return { t: 'ping' };
    case 'pong':
      return { t: 'pong' };
    case 'node.status':
      return decodeMeshNodeStatus(parsed);
    case 'node.list':
      return decodeMeshNodeList(parsed);
    case 'key.log.req':
      return decodeMeshKeyLogReq(parsed);
    case 'key.log.res':
      return decodeMeshKeyLogRes(parsed);
    case 'key.log.append': {
      const append: Extract<MeshUplinkCtlMessage, { t: 'key.log.append' }> = {
        t: 'key.log.append',
        bytes: ctlRead.b64(parsed.bytes, 'bytes'),
        sig: ctlRead.b64(parsed.sig, 'sig'),
      };
      const id = ctlRead.optStr(parsed.id, 'id');
      if (id) append.id = id;
      if (parsed.force !== undefined && parsed.force !== null) {
        append.force = ctlRead.bool(parsed.force, 'force');
      }
      return append;
    }
    case 'key.log.ack': {
      const ok = ctlRead.bool(parsed.ok, 'ok');
      const ack: MeshUplinkKeyLogAck = { t: 'key.log.ack', id: ctlRead.str(parsed.id, 'id'), ok };
      if (ok) ack.seq = ctlRead.seq(parsed.seq, 'seq');
      else ack.error = ctlRead.str(parsed.error, 'error');
      return ack;
    }
    case 'rtc.signal': {
      const from = ctlRead.str(parsed.from, 'from');
      if (from !== 'browser' && from !== 'node') {
        throw new Error('rtc.signal from must be browser|node');
      }
      return {
        t: 'rtc.signal',
        rtcSession: ctlRead.str(parsed.rtcSession, 'rtcSession'),
        from,
        to: ctlRead.str(parsed.to, 'to'),
        sdp: ctlRead.optStr(parsed.sdp, 'sdp'),
        candidate: ctlRead.optStr(parsed.candidate, 'candidate'),
      };
    }
    case 'enroll.redeemed': {
      const certificate = ctlRead.b64(parsed.certificate, 'certificate');
      if (certificate.byteLength > UPLINK_CTL_MAX_CERT_BYTES) {
        throw new Error('ctl field certificate too large');
      }
      const msg: MeshUplinkEnrollRedeemed = {
        t: 'enroll.redeemed',
        certificate,
        cert_sig: ctlRead.b64(parsed.cert_sig, 'cert_sig', 64),
        enroll_pk: ctlRead.b64(parsed.enroll_pk, 'enroll_pk', 32),
        nodeId: ctlRead.nodeId(parsed.node_id, 'node_id'),
      };
      const entrySid = ctlRead.optStr(parsed.entry_sid, 'entry_sid');
      if (entrySid) msg.entrySid = entrySid;
      return msg;
    }
    case 'hub.tokens':
      return parseHubTokensMessage(parsed);
    case 'hub.attachments':
      return parseHubAttachmentsMessage(parsed);
    case 'hub.forward':
      return parseHubForwardMessage(parsed);
    case 'hub.write-forward':
      return parseHubWriteForwardMessage(parsed);
  }
}

function decodeMeshNodeStatus(
  parsed: Record<string, unknown>
): Extract<MeshUplinkCtlMessage, { t: 'node.status' }> {
  const status: Extract<MeshUplinkCtlMessage, { t: 'node.status' }> = {
    t: 'node.status',
    version: ctlRead.str(parsed.version, 'version'),
    tmux: ctlRead.bool(parsed.tmux, 'tmux'),
    direct_capable: ctlRead.bool(parsed.direct_capable, 'direct_capable'),
    inventory: parsed.inventory ?? {},
    endpoints: parsed.endpoints ?? [],
  };
  if (parsed.hub !== undefined && parsed.hub !== null) {
    status.hub = parseHubAdvertisement(parsed.hub);
  }
  return status;
}

function decodeMeshKeyLogReq(
  parsed: Record<string, unknown>
): Extract<MeshUplinkCtlMessage, { t: 'key.log.req' }> {
  const req: Extract<MeshUplinkCtlMessage, { t: 'key.log.req' }> = {
    t: 'key.log.req',
    from_seq: ctlRead.seq(parsed.from_seq, 'from_seq'),
  };
  const reqId = ctlRead.optStr(parsed.id, 'id');
  if (reqId) req.id = reqId;
  if (parsed.limit !== undefined && parsed.limit !== null) {
    const limit = ctlRead.num(parsed.limit, 'limit');
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('ctl field limit must be a positive integer');
    }
    req.limit = limit;
  }
  return req;
}

function decodeMeshNodeList(parsed: Record<string, unknown>): MeshUplinkNodeList {
  if (!isRecord(parsed.key_log_head)) throw new Error('node.list key_log_head must be an object');
  if (!isRecord(parsed.rtc)) throw new Error('node.list rtc must be an object');
  if (!Array.isArray(parsed.nodes)) throw new Error('node.list nodes must be an array');
  const stun = parsed.rtc.stun;
  const list: MeshUplinkNodeList = {
    t: 'node.list',
    version: ctlRead.num(parsed.version, 'version'),
    key_log_head: {
      seq: ctlRead.seq(parsed.key_log_head.seq, 'key_log_head.seq'),
      hash: ctlRead.b64(parsed.key_log_head.hash, 'key_log_head.hash'),
    },
    rtc: {
      stun: Array.isArray(stun) ? stun.map((item, i) => ctlRead.str(item, `rtc.stun[${i}]`)) : [],
      turn: parsed.rtc.turn ?? null,
    },
    nodes: parsed.nodes.map(parseMeshNode),
  };
  if (parsed.hub !== undefined && parsed.hub !== null) list.hub = parseMeshHub(parsed.hub);
  return applyNodeListExtras(list, parsed);
}

function decodeMeshKeyLogRes(
  parsed: Record<string, unknown>
): Extract<MeshUplinkCtlMessage, { t: 'key.log.res' }> {
  if (!Array.isArray(parsed.records)) throw new Error('key.log.res records must be an array');
  if (parsed.records.length > KEY_LOG_PAGE_MAX_LIMIT) {
    throw new Error('key.log.res too many records');
  }
  const res: Extract<MeshUplinkCtlMessage, { t: 'key.log.res' }> = {
    t: 'key.log.res',
    records: parsed.records.map((row, i) => {
      if (!isRecord(row)) throw new Error(`key.log.res records[${i}] must be an object`);
      return {
        seq: ctlRead.seq(row.seq, `records[${i}].seq`),
        bytes: ctlRead.b64(row.bytes, `records[${i}].bytes`),
        sig: ctlRead.b64(row.sig, `records[${i}].sig`),
      };
    }),
  };
  const resId = ctlRead.optStr(parsed.id, 'id');
  if (resId) res.id = resId;
  const resError = ctlRead.optStr(parsed.error, 'error');
  if (resError) res.error = resError;
  if (parsed.has_more !== undefined && parsed.has_more !== null) {
    res.has_more = ctlRead.bool(parsed.has_more, 'has_more');
  }
  if (parsed.retry_after_ms !== undefined && parsed.retry_after_ms !== null) {
    const retryAfter = ctlRead.num(parsed.retry_after_ms, 'retry_after_ms');
    if (!Number.isInteger(retryAfter) || retryAfter < 0) {
      throw new Error('ctl field retry_after_ms must be a non-negative integer');
    }
    res.retry_after_ms = retryAfter;
  }
  return res;
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
      if (!legacy && msg.writerHubId) ctlRead.nodeId(msg.writerHubId, 'writerHubId');
      if (!legacy && msg.writerEpoch !== undefined) {
        ctlRead.nonNegInt(msg.writerEpoch, 'writerEpoch');
      }
      return encodeJsonBytes({
        t: 'node.list',
        version: msg.version,
        key_log_head: {
          seq: seqToWire(msg.key_log_head.seq),
          hash: encodeBase64url(msg.key_log_head.hash),
        },
        rtc: msg.rtc,
        nodes: legacy ? msg.nodes.map(stripAttachedHubId) : msg.nodes,
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
        ...(!legacy && msg.force === true ? { force: true } : {}),
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
    case 'hub.tokens':
      return encodeHubTokensMessage(msg, legacy);
    case 'hub.attachments':
      return encodeHubAttachmentsMessage(msg, legacy);
    case 'hub.forward':
      return encodeHubForwardMessage(msg, legacy);
    case 'hub.write-forward':
      return encodeHubWriteForwardMessage(msg, legacy);
  }
}
