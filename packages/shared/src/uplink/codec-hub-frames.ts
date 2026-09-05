import { encodeBase64url } from '../auth/encoding';
import {
  type HubMode,
  type RtcSignalFrom,
  UPLINK_CTL_MAX_ARRAY_LEN,
  UPLINK_CTL_MAX_ATTACHMENT_ENTRIES,
  UPLINK_CTL_MAX_HUBS,
  UPLINK_CTL_MAX_TOKEN_JSON_LEN,
  ctlRead,
  encodeJsonBytes,
  isRecord,
} from './codec-fields';

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

export type HubTokensOp = 'upsert' | 'tombstone';
export type HubTokensRevision = { epoch: number; seq: number };
export type HubTokenRow = {
  id: string;
  user_id: string;
  enroll_public_key: string;
  authorization_json: string;
  authorization_sig: string;
  expires_at: number;
  used_at: number | null;
  node_id: string | null;
};
export type HubTokensMessage = {
  t: 'hub.tokens';
  op: HubTokensOp;
  revision: HubTokensRevision;
  id?: string;
  tokens?: HubTokenRow[];
  ack?: boolean;
  more?: boolean;
};
export type HubAttachmentsEntry = {
  nodeId: string;
  attached: boolean;
  hubId?: string;
};
export type HubAttachmentsMessage = {
  t: 'hub.attachments';
  revision: number;
  entries: HubAttachmentsEntry[];
  full?: boolean;
  snapshotId?: string;
  page?: number;
  final?: boolean;
};
export type HubForwardRtcSignal = {
  rtcSession: string;
  from: RtcSignalFrom;
  to: string;
  sdp?: string;
  candidate?: string;
};
export type HubForwardMessage = {
  t: 'hub.forward';
  kind: 'rtc.signal';
  originHubId: string;
  returnHubId: string;
  visitedHubIds: string[];
  signal: HubForwardRtcSignal;
};
export type HubWriteForwardHeaders = {
  'content-type'?: string;
  'x-tmex-force-keylog'?: string;
};
export type HubWriteForwardMessage = {
  t: 'hub.write-forward';
  id: string;
  ack?: boolean;
  method?: string;
  path?: string;
  headers?: HubWriteForwardHeaders;
  body?: string;
  uid?: string;
  status?: number;
  writerHubId?: string;
  writerEpoch?: number;
  part?: number;
  final?: boolean;
  bytes?: string;
};

export function parseHubEndpointInfo(value: unknown, label: string): HubEndpointInfo {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const info: HubEndpointInfo = {
    nodeId: ctlRead.nodeId(value.nodeId, `${label}.nodeId`),
    publicUrl: ctlRead.httpUrl(value.publicUrl, `${label}.publicUrl`),
    mode: ctlRead.hubMode(value.mode, `${label}.mode`),
    priority: ctlRead.nonNegInt(value.priority, `${label}.priority`),
    writerEpoch: ctlRead.nonNegInt(value.writerEpoch, `${label}.writerEpoch`),
  };
  const name = ctlRead.optStr(value.name, `${label}.name`);
  if (name) info.name = name;
  const caFingerprint = ctlRead.optNullStr(value.caFingerprint, `${label}.caFingerprint`);
  if (caFingerprint !== undefined) info.caFingerprint = caFingerprint;
  if (value.online !== undefined && value.online !== null) {
    info.online = ctlRead.bool(value.online, `${label}.online`);
  }
  if (value.lastSeenAt !== undefined) {
    info.lastSeenAt =
      value.lastSeenAt === null ? null : ctlRead.nonNegInt(value.lastSeenAt, `${label}.lastSeenAt`);
  }
  return info;
}

export function parseHubs(value: unknown): HubEndpointInfo[] {
  if (!Array.isArray(value)) throw new Error('node.list hubs must be an array');
  if (value.length > UPLINK_CTL_MAX_HUBS) throw new Error('node.list hubs too many');
  return value.map((item, i) => parseHubEndpointInfo(item, `hubs[${i}]`));
}

export function parseHubAdvertisement(value: unknown): HubAdvertisement {
  if (!isRecord(value)) throw new Error('node.status hub must be an object');
  const adv: HubAdvertisement = {
    publicUrl: ctlRead.httpUrl(value.publicUrl, 'hub.publicUrl'),
    mode: ctlRead.hubMode(value.mode, 'hub.mode'),
    priority: ctlRead.nonNegInt(value.priority, 'hub.priority'),
    writerEpoch: ctlRead.nonNegInt(value.writerEpoch, 'hub.writerEpoch'),
  };
  const caFingerprint = ctlRead.optNullStr(value.caFingerprint, 'hub.caFingerprint');
  if (caFingerprint !== undefined) adv.caFingerprint = caFingerprint;
  return adv;
}

export function compareTokenRevision(a: HubTokensRevision, b: HubTokensRevision): number {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch ? 1 : -1;
  if (a.seq !== b.seq) return a.seq > b.seq ? 1 : -1;
  return 0;
}

function parseHubTokensRevision(value: unknown): HubTokensRevision {
  if (!isRecord(value)) throw new Error('hub.tokens revision must be an object');
  return {
    epoch: ctlRead.nonNegInt(value.epoch, 'revision.epoch'),
    seq: ctlRead.nonNegInt(value.seq, 'revision.seq'),
  };
}

function parseHubTokenRow(value: unknown, label: string): HubTokenRow {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const json = ctlRead.str(value.authorization_json, `${label}.authorization_json`);
  if (json.length > UPLINK_CTL_MAX_TOKEN_JSON_LEN) {
    throw new Error(`${label}.authorization_json too long`);
  }
  const enrollPk = ctlRead.b64(value.enroll_public_key, `${label}.enroll_public_key`, 32);
  const authSig = ctlRead.b64(value.authorization_sig, `${label}.authorization_sig`, 64);
  const usedAt = value.used_at;
  if (
    usedAt !== null &&
    usedAt !== undefined &&
    (typeof usedAt !== 'number' || !Number.isInteger(usedAt))
  ) {
    throw new Error(`${label}.used_at must be an integer or null`);
  }
  const nodeId = value.node_id;
  if (nodeId !== null && nodeId !== undefined && typeof nodeId !== 'string') {
    throw new Error(`${label}.node_id must be a string or null`);
  }
  return {
    id: ctlRead.str(value.id, `${label}.id`),
    user_id: ctlRead.str(value.user_id, `${label}.user_id`),
    enroll_public_key: encodeBase64url(enrollPk),
    authorization_json: json,
    authorization_sig: encodeBase64url(authSig),
    expires_at: ctlRead.nonNegInt(value.expires_at, `${label}.expires_at`),
    used_at: usedAt === undefined ? null : (usedAt as number | null),
    node_id: nodeId === undefined ? null : (nodeId as string | null),
  };
}

export function parseHubTokensMessage(parsed: Record<string, unknown>): HubTokensMessage {
  const op = ctlRead.str(parsed.op, 'op');
  if (op !== 'upsert' && op !== 'tombstone') {
    throw new Error('hub.tokens op must be upsert|tombstone');
  }
  const msg: HubTokensMessage = {
    t: 'hub.tokens',
    op,
    revision: parseHubTokensRevision(parsed.revision),
  };
  const id = ctlRead.optStr(parsed.id, 'id');
  if (id) msg.id = id;
  if (parsed.ack !== undefined && parsed.ack !== null) {
    msg.ack = ctlRead.bool(parsed.ack, 'ack');
  }
  if (parsed.tokens !== undefined && parsed.tokens !== null) {
    if (!Array.isArray(parsed.tokens)) throw new Error('hub.tokens tokens must be an array');
    if (parsed.tokens.length > UPLINK_CTL_MAX_ARRAY_LEN) {
      throw new Error('hub.tokens tokens too many');
    }
    msg.tokens = parsed.tokens.map((row, i) => parseHubTokenRow(row, `tokens[${i}]`));
  }
  if (parsed.more !== undefined && parsed.more !== null) {
    msg.more = ctlRead.bool(parsed.more, 'more');
  }
  return msg;
}

export function encodeHubTokensMessage(msg: HubTokensMessage, legacy: boolean): Uint8Array {
  if (legacy) return encodeJsonBytes({ t: 'hub.tokens' });
  parseHubTokensRevision(msg.revision);
  if (msg.op !== 'upsert' && msg.op !== 'tombstone') {
    throw new Error('hub.tokens op must be upsert|tombstone');
  }
  return encodeJsonBytes({
    t: 'hub.tokens',
    op: msg.op,
    revision: msg.revision,
    ...(msg.id ? { id: msg.id } : {}),
    ...(msg.ack !== undefined ? { ack: msg.ack } : {}),
    ...(msg.more !== undefined ? { more: msg.more } : {}),
    ...(msg.tokens
      ? { tokens: msg.tokens.map((row, i) => parseHubTokenRow(row, `tokens[${i}]`)) }
      : {}),
  });
}

function parseAttachmentEntry(value: unknown, label: string): HubAttachmentsEntry {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const entry: HubAttachmentsEntry = {
    nodeId: ctlRead.nodeId(value.nodeId, `${label}.nodeId`),
    attached: ctlRead.bool(value.attached, `${label}.attached`),
  };
  if (value.hubId !== undefined && value.hubId !== null) {
    entry.hubId = ctlRead.nodeId(value.hubId, `${label}.hubId`);
  }
  return entry;
}

export function parseHubAttachmentsMessage(parsed: Record<string, unknown>): HubAttachmentsMessage {
  if (!Array.isArray(parsed.entries)) throw new Error('hub.attachments entries must be an array');
  if (parsed.entries.length > UPLINK_CTL_MAX_ATTACHMENT_ENTRIES) {
    throw new Error('hub.attachments entries too many');
  }
  const msg: HubAttachmentsMessage = {
    t: 'hub.attachments',
    revision: ctlRead.nonNegInt(parsed.revision, 'revision'),
    entries: parsed.entries.map((row, i) => parseAttachmentEntry(row, `entries[${i}]`)),
  };
  if (parsed.full !== undefined && parsed.full !== null) {
    msg.full = ctlRead.bool(parsed.full, 'full');
  }
  const snapshotId = ctlRead.optStr(parsed.snapshotId, 'snapshotId');
  if (snapshotId) msg.snapshotId = snapshotId;
  if (parsed.page !== undefined && parsed.page !== null) {
    msg.page = ctlRead.nonNegInt(parsed.page, 'page');
  }
  if (parsed.final !== undefined && parsed.final !== null) {
    msg.final = ctlRead.bool(parsed.final, 'final');
  }
  return msg;
}

export function encodeHubAttachmentsMessage(
  msg: HubAttachmentsMessage,
  legacy: boolean
): Uint8Array {
  if (legacy) return encodeJsonBytes({ t: 'hub.attachments' });
  return encodeJsonBytes(parseHubAttachmentsMessage({ ...msg, t: 'hub.attachments' }));
}

function parseForwardedRtcSignal(value: unknown): HubForwardRtcSignal {
  if (!isRecord(value)) throw new Error('hub.forward signal must be an object');
  const from = ctlRead.str(value.from, 'signal.from');
  if (from !== 'browser' && from !== 'node') {
    throw new Error('hub.forward signal.from must be browser|node');
  }
  const signal: HubForwardRtcSignal = {
    rtcSession: ctlRead.str(value.rtcSession, 'signal.rtcSession'),
    from,
    to: ctlRead.str(value.to, 'signal.to'),
  };
  const sdp = ctlRead.optStr(value.sdp, 'signal.sdp');
  if (sdp !== undefined) signal.sdp = sdp;
  const candidate = ctlRead.optStr(value.candidate, 'signal.candidate');
  if (candidate !== undefined) signal.candidate = candidate;
  return signal;
}

export function parseHubForwardMessage(parsed: Record<string, unknown>): HubForwardMessage {
  const kind = ctlRead.str(parsed.kind, 'kind');
  if (kind !== 'rtc.signal') throw new Error('hub.forward kind must be rtc.signal');
  if (!Array.isArray(parsed.visitedHubIds)) {
    throw new Error('hub.forward visitedHubIds must be an array');
  }
  if (parsed.visitedHubIds.length > UPLINK_CTL_MAX_HUBS) {
    throw new Error('hub.forward visitedHubIds too many');
  }
  return {
    t: 'hub.forward',
    kind: 'rtc.signal',
    originHubId: ctlRead.nodeId(parsed.originHubId, 'originHubId'),
    returnHubId: ctlRead.nodeId(parsed.returnHubId, 'returnHubId'),
    visitedHubIds: parsed.visitedHubIds.map((id, i) => ctlRead.nodeId(id, `visitedHubIds[${i}]`)),
    signal: parseForwardedRtcSignal(parsed.signal),
  };
}

export function encodeHubForwardMessage(msg: HubForwardMessage, legacy: boolean): Uint8Array {
  if (legacy) return encodeJsonBytes({ t: 'hub.forward' });
  return encodeJsonBytes(parseHubForwardMessage({ ...msg, t: 'hub.forward' }));
}

const WRITE_FORWARD_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const WRITE_FORWARD_HEADER_KEYS = new Set(['content-type', 'x-tmex-force-keylog']);

function parseWriteForwardHeaders(value: unknown): HubWriteForwardHeaders | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('hub.write-forward headers must be an object');
  const headers: HubWriteForwardHeaders = {};
  for (const [rawKey, rawVal] of Object.entries(value)) {
    const key = rawKey.toLowerCase();
    if (key === 'cookie' || key === 'authorization') continue;
    if (!WRITE_FORWARD_HEADER_KEYS.has(key)) continue;
    if (typeof rawVal !== 'string') {
      throw new Error(`hub.write-forward headers.${key} must be a string`);
    }
    if (key === 'content-type') headers['content-type'] = rawVal;
    else headers['x-tmex-force-keylog'] = rawVal;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseWriteForwardStatus(value: unknown): number {
  const status = ctlRead.nonNegInt(value, 'status');
  if (status < 100 || status > 599) throw new Error('hub.write-forward status out of range');
  return status;
}

function parseWriteForwardAck(
  parsed: Record<string, unknown>,
  id: string,
  headers: HubWriteForwardHeaders | undefined,
  body: string | undefined
): HubWriteForwardMessage {
  if (parsed.part === undefined || parsed.part === null) {
    const msg: HubWriteForwardMessage = {
      t: 'hub.write-forward',
      id,
      ack: true,
      status: parseWriteForwardStatus(parsed.status),
    };
    if (headers) msg.headers = headers;
    if (body !== undefined) msg.body = body;
    return msg;
  }
  const part = ctlRead.nonNegInt(parsed.part, 'part');
  const final =
    parsed.final === undefined || parsed.final === null
      ? false
      : ctlRead.bool(parsed.final, 'final');
  const msg: HubWriteForwardMessage = {
    t: 'hub.write-forward',
    id,
    ack: true,
    part,
    final,
    bytes: ctlRead.str(parsed.bytes, 'bytes'),
  };
  if (parsed.status !== undefined && parsed.status !== null) {
    msg.status = parseWriteForwardStatus(parsed.status);
  }
  if (headers) msg.headers = headers;
  if (body !== undefined) msg.body = body;
  return msg;
}

export function parseHubWriteForwardMessage(
  parsed: Record<string, unknown>
): HubWriteForwardMessage {
  const id = ctlRead.str(parsed.id, 'id');
  const ack =
    parsed.ack === undefined || parsed.ack === null ? undefined : ctlRead.bool(parsed.ack, 'ack');
  const headers = parseWriteForwardHeaders(parsed.headers);
  const body = ctlRead.optStr(parsed.body, 'body');
  if (ack === true) return parseWriteForwardAck(parsed, id, headers, body);
  const method = ctlRead.str(parsed.method, 'method').toUpperCase();
  if (!WRITE_FORWARD_METHODS.has(method)) throw new Error('hub.write-forward method not allowed');
  const path = ctlRead.str(parsed.path, 'path');
  if (!path.startsWith('/')) throw new Error('hub.write-forward path must be absolute');
  const msg: HubWriteForwardMessage = { t: 'hub.write-forward', id, method, path };
  if (ack === false) msg.ack = false;
  if (headers) msg.headers = headers;
  if (body !== undefined) msg.body = body;
  const uid = ctlRead.optStr(parsed.uid, 'uid');
  if (uid) msg.uid = uid;
  if (parsed.writerHubId !== undefined && parsed.writerHubId !== null) {
    msg.writerHubId = ctlRead.nodeId(parsed.writerHubId, 'writerHubId');
  }
  if (parsed.writerEpoch !== undefined && parsed.writerEpoch !== null) {
    msg.writerEpoch = ctlRead.nonNegInt(parsed.writerEpoch, 'writerEpoch');
  }
  return msg;
}

export function encodeHubWriteForwardMessage(
  msg: HubWriteForwardMessage,
  legacy: boolean
): Uint8Array {
  if (legacy) return encodeJsonBytes({ t: 'hub.write-forward' });
  return encodeJsonBytes(parseHubWriteForwardMessage({ ...msg, t: 'hub.write-forward' }));
}

export function stripAttachedHubId<T extends { attachedHubId?: string }>(
  node: T
): Omit<T, 'attachedHubId'> {
  const { attachedHubId: _id, ...rest } = node;
  return rest;
}

export function applyNodeListExtras<
  T extends { hubs?: HubEndpointInfo[]; writerHubId?: string; writerEpoch?: number },
>(target: T, parsed: Record<string, unknown>): T {
  if (parsed.hubs !== undefined && parsed.hubs !== null) target.hubs = parseHubs(parsed.hubs);
  if (parsed.writerHubId !== undefined && parsed.writerHubId !== null) {
    target.writerHubId = ctlRead.nodeId(parsed.writerHubId, 'writerHubId');
  }
  if (parsed.writerEpoch !== undefined && parsed.writerEpoch !== null) {
    target.writerEpoch = ctlRead.nonNegInt(parsed.writerEpoch, 'writerEpoch');
  }
  return target;
}
