import { encodeBase64url } from '../auth/encoding';
import { type CtlDecodeProfile, decodeUplinkCtl, isHubFrameCtlType } from './codec-decode';
import {
  type EncodeUplinkCtlOptions,
  KEY_LOG_PAGE_MAX_BYTES,
  ctlRead,
  isRecord,
  seqToWire,
} from './codec-fields';
import { type HubUplinkCtlMessage, encodeHubUplinkCtl } from './codec-hub';
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

const meshProfile: CtlDecodeProfile<
  Uint8Array,
  bigint,
  MeshUplinkNodeList,
  MeshUplinkEnrollRedeemed
> = {
  readers: ctlRead,
  fail: (message) => new Error(message),
  hardMaxBytes: KEY_LOG_PAGE_MAX_BYTES,
  onJsonError: (err) => (err instanceof Error ? err : new Error('invalid json')),
  notObject: 'uplink ctl must be a JSON object with t',
  unknownType: (t) => new Error(`unknown uplink ctl t: ${t}`),
  notStringType: () => new Error('uplink ctl must be a JSON object with t'),
  bytes(value, field, expectedLen, maxLen) {
    const raw = ctlRead.b64(value, field, expectedLen);
    if (maxLen !== undefined && raw.byteLength > maxLen) {
      throw new Error(`ctl field ${field} too large`);
    }
    return raw;
  },
  text: (value, field) => ctlRead.str(value, field),
  nodeIdText: (value, field) => ctlRead.str(value, field),
  optText: (value, field) => ctlRead.optStr(value, field) || undefined,
  reqText: (value, field) => ctlRead.str(value, field),
  seq: (value, field) => ctlRead.seq(value, field),
  inventory: (value) => value ?? {},
  endpoints: (value) => value ?? [],
  keyLogRes: {
    notArray: 'key.log.res records must be an array',
    notObject: (index) => `key.log.res records[${index}] must be an object`,
    field: (index, name) => `records[${index}].${name}`,
  },
  rtcFrom(value) {
    const from = ctlRead.str(value, 'from');
    if (from !== 'browser' && from !== 'node') {
      throw new Error('rtc.signal from must be browser|node');
    }
    return from;
  },
  optSignalText: (value, field) => ctlRead.optStr(value, field),
  nodeList: decodeMeshNodeList,
  enrollRedeemed(fields) {
    const msg: MeshUplinkEnrollRedeemed = {
      t: 'enroll.redeemed',
      certificate: fields.certificate,
      cert_sig: fields.certSig,
      enroll_pk: fields.enrollPk,
      nodeId: fields.nodeId,
    };
    if (fields.entrySid !== undefined) msg.entrySid = fields.entrySid;
    return msg;
  },
  frame: (_fallback, fn) => fn(),
};

export function decodeMeshUplinkCtl(
  bytes: Uint8Array,
  opts?: { pendingKeyLogId?: string }
): MeshUplinkCtlMessage {
  return decodeUplinkCtl(bytes, meshProfile, {
    allowKeyLogRes: true,
    pendingKeyLogId: opts?.pendingKeyLogId,
  });
}

type HubFrameCtlMessage =
  | HubTokensMessage
  | HubAttachmentsMessage
  | HubForwardMessage
  | HubWriteForwardMessage;
type MeshCoreCtlMessage = Exclude<MeshUplinkCtlMessage, HubFrameCtlMessage>;

function isHubFrameCtl(msg: MeshUplinkCtlMessage): msg is HubFrameCtlMessage {
  return isHubFrameCtlType(msg.t);
}

function encodeMeshHubFrame(msg: HubFrameCtlMessage, legacy: boolean): Uint8Array {
  switch (msg.t) {
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

function meshNodeListToWire(msg: MeshUplinkNodeList): HubUplinkCtlMessage {
  return {
    t: 'node.list',
    version: msg.version,
    key_log_head: {
      seq: seqToWire(msg.key_log_head.seq),
      hash: encodeBase64url(msg.key_log_head.hash),
    },
    rtc: msg.rtc as { stun: string[]; turn: null },
    nodes: msg.nodes,
    ...(msg.hub ? { hub: msg.hub } : {}),
    ...(msg.hubs ? { hubs: msg.hubs } : {}),
    ...(msg.writerHubId ? { writerHubId: msg.writerHubId } : {}),
    ...(msg.writerEpoch !== undefined ? { writerEpoch: msg.writerEpoch } : {}),
  };
}

function meshKeyLogReqToWire(
  msg: Extract<MeshUplinkCtlMessage, { t: 'key.log.req' }>
): HubUplinkCtlMessage {
  return {
    t: 'key.log.req',
    from_seq: seqToWire(msg.from_seq),
    ...(msg.id ? { id: msg.id } : {}),
    ...(msg.limit != null ? { limit: msg.limit } : {}),
  };
}

function meshKeyLogResToWire(
  msg: Extract<MeshUplinkCtlMessage, { t: 'key.log.res' }>
): HubUplinkCtlMessage {
  return {
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
  };
}

function meshKeyLogAppendToWire(
  msg: Extract<MeshUplinkCtlMessage, { t: 'key.log.append' }>
): HubUplinkCtlMessage {
  return {
    t: 'key.log.append',
    bytes: encodeBase64url(msg.bytes),
    sig: encodeBase64url(msg.sig),
    ...(msg.id ? { id: msg.id } : {}),
    ...(msg.force === true ? { force: true } : {}),
  };
}

function meshKeyLogAckToWire(msg: MeshUplinkKeyLogAck): HubUplinkCtlMessage {
  return {
    t: 'key.log.ack',
    id: msg.id,
    ok: msg.ok,
    ...(msg.ok ? { seq: seqToWire(msg.seq ?? 0n) } : { error: msg.error ?? 'error' }),
  };
}

function meshEnrollRedeemedToWire(msg: MeshUplinkEnrollRedeemed): HubUplinkCtlMessage {
  return {
    t: 'enroll.redeemed',
    certificate: encodeBase64url(msg.certificate),
    cert_sig: encodeBase64url(msg.cert_sig),
    enroll_pk: encodeBase64url(msg.enroll_pk),
    node_id: msg.nodeId,
    ...(msg.entrySid ? { entry_sid: msg.entrySid } : {}),
  };
}

/** mesh 侧消息先归一到 hub 线的线上表示，再复用 hub 的编码 / legacy 剥字段实现。 */
function toHubWireCtl(msg: MeshCoreCtlMessage): HubUplinkCtlMessage {
  switch (msg.t) {
    case 'auth.challenge':
    case 'auth.response':
    case 'auth.ok':
    case 'ping':
    case 'pong':
    case 'node.status':
    case 'rtc.signal':
      return msg;
    case 'node.list':
      return meshNodeListToWire(msg);
    case 'key.log.req':
      return meshKeyLogReqToWire(msg);
    case 'key.log.res':
      return meshKeyLogResToWire(msg);
    case 'key.log.append':
      return meshKeyLogAppendToWire(msg);
    case 'key.log.ack':
      return meshKeyLogAckToWire(msg);
    case 'enroll.redeemed':
      return meshEnrollRedeemedToWire(msg);
  }
}

export function encodeMeshUplinkCtl(
  msg: MeshUplinkCtlMessage,
  opts?: EncodeUplinkCtlOptions
): Uint8Array {
  if (isHubFrameCtl(msg)) return encodeMeshHubFrame(msg, opts?.legacy === true);
  return encodeHubUplinkCtl(toHubWireCtl(msg), opts);
}
