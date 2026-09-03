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

export type RelayOpenStream = { to: string };

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
  return encodeJson(
    {
      name: blob.name,
      version: blob.version,
      tmux: blob.tmux,
      direct_capable: blob.direct_capable,
      inventory: blob.inventory ?? null,
      endpoints: blob.endpoints ?? null,
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
  return {
    name,
    version,
    tmux: parsed.tmux,
    direct_capable: parsed.direct_capable,
    inventory: parsed.inventory ?? null,
    endpoints: parsed.endpoints ?? null,
  };
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
