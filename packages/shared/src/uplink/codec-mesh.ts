import { encodeBase64url } from '../auth/encoding';
import { type CtlDecodeProfile, decodeUplinkCtl, parsePeerReachMap } from './codec-decode';
import {
  type EncodeUplinkCtlOptions,
  KEY_LOG_PAGE_MAX_BYTES,
  ctlRead,
  isRecord,
  seqToWire,
} from './codec-fields';
import { type PeerUplinkCtlMessage, encodePeerUplinkCtl } from './codec-peer';

type MeshNodeInfo = {
  id: string;
  name: string;
  online: boolean;
  endpoints: unknown;
  inventory: unknown;
  direct_capable: boolean;
  version: string | null;
  peer_reach?: Record<string, 'ok' | 'refused' | 'timeout'>;
};

export type MeshUplinkNodeList = {
  t: 'node.list';
  version: number;
  key_log_head: { seq: bigint; hash: Uint8Array };
  rtc: { stun: string[]; turn: unknown };
  nodes: MeshNodeInfo[];
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
      peer_reach?: Record<string, 'ok' | 'refused' | 'timeout'>;
      peer_reach_epoch?: number;
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
  | MeshUplinkEnrollRedeemed;

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
  const peerReach = parsePeerReachMap(value.peer_reach);
  if (peerReach) node.peer_reach = peerReach;
  return node;
}

function decodeMeshNodeList(parsed: Record<string, unknown>): MeshUplinkNodeList {
  if (!isRecord(parsed.key_log_head)) throw new Error('node.list key_log_head must be an object');
  if (!isRecord(parsed.rtc)) throw new Error('node.list rtc must be an object');
  if (!Array.isArray(parsed.nodes)) throw new Error('node.list nodes must be an array');
  const stun = parsed.rtc.stun;
  return {
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

function meshNodeListToWire(msg: MeshUplinkNodeList): PeerUplinkCtlMessage {
  return {
    t: 'node.list',
    version: msg.version,
    key_log_head: {
      seq: seqToWire(msg.key_log_head.seq),
      hash: encodeBase64url(msg.key_log_head.hash),
    },
    rtc: msg.rtc as { stun: string[]; turn: null },
    nodes: msg.nodes,
  };
}

function meshKeyLogReqToWire(
  msg: Extract<MeshUplinkCtlMessage, { t: 'key.log.req' }>
): PeerUplinkCtlMessage {
  return {
    t: 'key.log.req',
    from_seq: seqToWire(msg.from_seq),
    ...(msg.id ? { id: msg.id } : {}),
    ...(msg.limit != null ? { limit: msg.limit } : {}),
  };
}

function meshKeyLogResToWire(
  msg: Extract<MeshUplinkCtlMessage, { t: 'key.log.res' }>
): PeerUplinkCtlMessage {
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
): PeerUplinkCtlMessage {
  return {
    t: 'key.log.append',
    bytes: encodeBase64url(msg.bytes),
    sig: encodeBase64url(msg.sig),
    ...(msg.id ? { id: msg.id } : {}),
    ...(msg.force === true ? { force: true } : {}),
  };
}

function meshKeyLogAckToWire(msg: MeshUplinkKeyLogAck): PeerUplinkCtlMessage {
  return {
    t: 'key.log.ack',
    id: msg.id,
    ok: msg.ok,
    ...(msg.ok ? { seq: seqToWire(msg.seq ?? 0n) } : { error: msg.error ?? 'error' }),
  };
}

function meshEnrollRedeemedToWire(msg: MeshUplinkEnrollRedeemed): PeerUplinkCtlMessage {
  return {
    t: 'enroll.redeemed',
    certificate: encodeBase64url(msg.certificate),
    cert_sig: encodeBase64url(msg.cert_sig),
    enroll_pk: encodeBase64url(msg.enroll_pk),
    node_id: msg.nodeId,
    ...(msg.entrySid ? { entry_sid: msg.entrySid } : {}),
  };
}

function toPeerKeyLogCtl(msg: MeshUplinkCtlMessage): PeerUplinkCtlMessage | null {
  switch (msg.t) {
    case 'key.log.req':
      return meshKeyLogReqToWire(msg);
    case 'key.log.res':
      return meshKeyLogResToWire(msg);
    case 'key.log.append':
      return meshKeyLogAppendToWire(msg);
    case 'key.log.ack':
      return meshKeyLogAckToWire(msg);
    default:
      return null;
  }
}

/** mesh 侧消息先归一到 peer 线的线上表示，再复用 peer 的编码 / legacy 剥字段实现。 */
function toPeerWireCtl(msg: MeshUplinkCtlMessage): PeerUplinkCtlMessage {
  const keyLog = toPeerKeyLogCtl(msg);
  if (keyLog) return keyLog;
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
    case 'enroll.redeemed':
      return meshEnrollRedeemedToWire(msg);
    default:
      throw new Error(`unreachable uplink ctl t: ${msg.t}`);
  }
}

export function encodeMeshUplinkCtl(
  msg: MeshUplinkCtlMessage,
  opts?: EncodeUplinkCtlOptions
): Uint8Array {
  return encodePeerUplinkCtl(toPeerWireCtl(msg), opts);
}
