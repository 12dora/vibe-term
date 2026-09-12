import { RelayCtlError } from './codec';

const te = new TextEncoder();
const td = new TextDecoder();
const HEX_16 = /^[0-9a-f]{32}$/;

/** relay 流的 OPEN 首帧与 hub 一致：`{"to":"<nodeId>"}`。 */
export const RELAY_OPEN_STREAM_MAX_BYTES = 256;
export const RELAY_STATUS_BLOB_MAX_BYTES = 32 * 1024;
export const RELAY_RTC_BLOB_MAX_BYTES = 16 * 1024;
export const RELAY_STATUS_MAX_ENDPOINTS = 32;
export const RELAY_STATUS_MAX_NAME_LEN = 256;
export const RELAY_STATUS_MAX_PEER_REACH = 32;
export const PEER_REACH_PREFIX_LEN = 8;

export type RelayOpenStream = { to: string };

export type PeerReachVerdict = 'ok' | 'refused' | 'timeout';

/**
 * `relay.status` 信封里的明文：中继看不到，只有同租户节点解得开。
 * `direct_capable`（能否直连）也在封里——它是节点的网络指纹，属于元数据，不给中继。
 */
export type RelayStatusBlob = {
  name: string;
  version: string;
  tmux: boolean;
  direct_capable: boolean;
  inventory: unknown;
  endpoints: unknown;
  /** 发送方到「收到这块的那台中继」的 uplink 心跳 RTT；缺省表示未知（2.2.x 对端）。 */
  rtt_ms?: number;
  /** 本机对其他成员 peer 口的探测结论；键为 nodeId 前 8 位 hex，最多 32 条。缺省 = 2.3.0 对端。 */
  peer_reach?: Record<string, PeerReachVerdict>;
  /** 本机对「收到这块的那台中继」TURN 控制口的 Binding 结论；缺省 = 未探测。 */
  turn_ok?: boolean;
};

export type RelayRtcBlob = { sdp?: string; candidate?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(bytes: Uint8Array, max: number, label: string): Record<string, unknown> {
  if (bytes.byteLength > max) throw new RelayCtlError(`${label} too large`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(td.decode(bytes));
  } catch {
    throw new RelayCtlError(`invalid ${label}`);
  }
  if (!isRecord(parsed)) throw new RelayCtlError(`invalid ${label}`);
  return parsed;
}

function encodeJson(value: unknown, max: number, label: string): Uint8Array {
  const bytes = te.encode(JSON.stringify(value));
  if (bytes.byteLength > max) throw new RelayCtlError(`${label} too large`);
  return bytes;
}

export function encodeRelayOpenStream(open: RelayOpenStream): Uint8Array {
  if (typeof open?.to !== 'string' || !HEX_16.test(open.to)) {
    throw new RelayCtlError('relay open target must be a 32-hex node id');
  }
  return encodeJson({ to: open.to }, RELAY_OPEN_STREAM_MAX_BYTES, 'relay open');
}

export function decodeRelayOpenStream(bytes: Uint8Array): RelayOpenStream {
  const parsed = parseJson(bytes, RELAY_OPEN_STREAM_MAX_BYTES, 'relay open');
  const to = parsed.to;
  if (typeof to !== 'string' || !HEX_16.test(to)) {
    throw new RelayCtlError('relay open target must be a 32-hex node id');
  }
  return { to };
}

export function encodeRelayStatusBlob(blob: RelayStatusBlob): Uint8Array {
  if (typeof blob?.name !== 'string' || blob.name.length > RELAY_STATUS_MAX_NAME_LEN) {
    throw new RelayCtlError('invalid status name');
  }
  if (
    typeof blob.version !== 'string' ||
    typeof blob.tmux !== 'boolean' ||
    typeof blob.direct_capable !== 'boolean'
  ) {
    throw new RelayCtlError('invalid status blob');
  }
  if (Array.isArray(blob.endpoints) && blob.endpoints.length > RELAY_STATUS_MAX_ENDPOINTS) {
    throw new RelayCtlError('too many endpoints');
  }
  const rttMs = normalizeStatusRtt(blob.rtt_ms);
  const peerReach = normalizePeerReach(blob.peer_reach);
  const turnOk = normalizeTurnOk(blob.turn_ok);
  return encodeJson(
    {
      name: blob.name,
      version: blob.version,
      tmux: blob.tmux,
      direct_capable: blob.direct_capable,
      inventory: blob.inventory ?? null,
      endpoints: blob.endpoints ?? null,
      ...(rttMs !== undefined ? { rtt_ms: rttMs } : {}),
      ...(peerReach !== undefined ? { peer_reach: peerReach } : {}),
      ...(turnOk !== undefined ? { turn_ok: turnOk } : {}),
    },
    RELAY_STATUS_BLOB_MAX_BYTES,
    'status blob'
  );
}

export function decodeRelayStatusBlob(bytes: Uint8Array): RelayStatusBlob {
  const parsed = parseJson(bytes, RELAY_STATUS_BLOB_MAX_BYTES, 'status blob');
  const name = parsed.name;
  const version = parsed.version;
  if (typeof name !== 'string' || name.length > RELAY_STATUS_MAX_NAME_LEN) {
    throw new RelayCtlError('invalid status name');
  }
  if (
    typeof version !== 'string' ||
    typeof parsed.tmux !== 'boolean' ||
    typeof parsed.direct_capable !== 'boolean'
  ) {
    throw new RelayCtlError('invalid status blob');
  }
  if (Array.isArray(parsed.endpoints) && parsed.endpoints.length > RELAY_STATUS_MAX_ENDPOINTS) {
    throw new RelayCtlError('too many endpoints');
  }
  const rttMs = normalizeStatusRtt(parsed.rtt_ms);
  const peerReach = normalizePeerReach(parsed.peer_reach);
  const turnOk = normalizeTurnOk(parsed.turn_ok);
  return {
    name,
    version,
    tmux: parsed.tmux,
    direct_capable: parsed.direct_capable,
    inventory: parsed.inventory ?? null,
    endpoints: parsed.endpoints ?? null,
    ...(rttMs !== undefined ? { rtt_ms: rttMs } : {}),
    ...(peerReach !== undefined ? { peer_reach: peerReach } : {}),
    ...(turnOk !== undefined ? { turn_ok: turnOk } : {}),
  };
}

function normalizeStatusRtt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

const PEER_REACH_VERDICTS = new Set<PeerReachVerdict>(['ok', 'refused', 'timeout']);
const PEER_REACH_KEY_RE = new RegExp(`^[0-9a-f]{${PEER_REACH_PREFIX_LEN}}$`);

export function nodeIdPrefix8(nodeId: string): string {
  return nodeId.slice(0, PEER_REACH_PREFIX_LEN).toLowerCase();
}

/** 缺省 / 非法整体忽略；条目最多 32、键须 8-hex、值须 ok|refused|timeout。 */
export function normalizePeerReach(value: unknown): Record<string, PeerReachVerdict> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, PeerReachVerdict> = {};
  for (const [rawKey, raw] of Object.entries(value)) {
    if (Object.keys(out).length >= RELAY_STATUS_MAX_PEER_REACH) break;
    const key = rawKey.toLowerCase();
    if (!PEER_REACH_KEY_RE.test(key)) continue;
    if (typeof raw !== 'string' || !PEER_REACH_VERDICTS.has(raw as PeerReachVerdict)) continue;
    out[key] = raw as PeerReachVerdict;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeTurnOk(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function encodeRelayRtcBlob(blob: RelayRtcBlob): Uint8Array {
  if (blob?.sdp !== undefined && typeof blob.sdp !== 'string') {
    throw new RelayCtlError('invalid rtc sdp');
  }
  if (blob?.candidate !== undefined && typeof blob.candidate !== 'string') {
    throw new RelayCtlError('invalid rtc candidate');
  }
  return encodeJson(
    {
      ...(blob.sdp !== undefined ? { sdp: blob.sdp } : {}),
      ...(blob.candidate !== undefined ? { candidate: blob.candidate } : {}),
    },
    RELAY_RTC_BLOB_MAX_BYTES,
    'rtc blob'
  );
}

export function decodeRelayRtcBlob(bytes: Uint8Array): RelayRtcBlob {
  const parsed = parseJson(bytes, RELAY_RTC_BLOB_MAX_BYTES, 'rtc blob');
  const sdp = parsed.sdp;
  const candidate = parsed.candidate;
  if (sdp !== undefined && typeof sdp !== 'string') throw new RelayCtlError('invalid rtc sdp');
  if (candidate !== undefined && typeof candidate !== 'string') {
    throw new RelayCtlError('invalid rtc candidate');
  }
  return {
    ...(sdp !== undefined ? { sdp } : {}),
    ...(candidate !== undefined ? { candidate } : {}),
  };
}
