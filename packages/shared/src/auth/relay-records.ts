import { b } from '@zorsh/zorsh';
import type { WrapEntry } from '../relay/tenant-cipher';
import { bytesToHex, decodeBase64url, encodeBase64url, hexToBytes } from './encoding';
import type { KeyLogRecord } from './encoding';
import { canonicalHubUrl } from './hub-url';
import type { ApplyKeyLogError, ApplyKeyLogResult, UserKeyState } from './key-log';

/** 写入 `set-relays` / `meta-key` 前，所有未吊销节点须达到该版本；不允许 force 绕过。 */
export const MIN_RELAY_RECORD_VERSION = '1.1.23';
export const RELAY_RECORD_MAX_RELAYS = 16;
export const RELAY_RECORD_MAX_URL_LEN = 512;
export const RELAY_RECORD_MAX_WRAP_ENTRIES = 1024;

export const RelayListMode = { ordered: 'ordered' } as const;
export type RelayListMode = (typeof RelayListMode)[keyof typeof RelayListMode];

/** 字段顺序即 Borsh 编码顺序，改动等于换协议。 */
export const RelayWrapEntrySchema = b.struct({
  node_id: b.bytes(16),
  eph_pk: b.bytes(32),
  nonce: b.bytes(12),
  ct: b.bytes(48),
});
export type RelayWrapEntryBytes = b.infer<typeof RelayWrapEntrySchema>;

export const RelayTargetSchema = b.struct({
  url: b.string(),
  tenant_id: b.bytes(16),
  token: b.bytes(32),
  priority: b.u8(),
});
export type RelayTargetPayload = b.infer<typeof RelayTargetSchema>;

export const MetaKeyPayloadSchema = b.struct({
  epoch: b.u32(),
  entries: b.vec(RelayWrapEntrySchema),
});
export type MetaKeyPayload = b.infer<typeof MetaKeyPayloadSchema>;

export const SetRelaysPayloadSchema = b.struct({
  mode: b.nativeEnum(RelayListMode),
  relays: b.vec(RelayTargetSchema),
  log_key: b.vec(RelayWrapEntrySchema),
  meta_key: MetaKeyPayloadSchema,
});
export type SetRelaysPayload = b.infer<typeof SetRelaysPayloadSchema>;

export function encodeSetRelaysPayload(value: SetRelaysPayload): Uint8Array {
  return SetRelaysPayloadSchema.serialize(value);
}
export function decodeSetRelaysPayload(bytes: Uint8Array): SetRelaysPayload {
  return SetRelaysPayloadSchema.deserialize(bytes);
}
export function encodeMetaKeyPayload(value: MetaKeyPayload): Uint8Array {
  return MetaKeyPayloadSchema.serialize(value);
}
export function decodeMetaKeyPayload(bytes: Uint8Array): MetaKeyPayload {
  return MetaKeyPayloadSchema.deserialize(bytes);
}

export function wrapEntryToBytes(entry: WrapEntry): RelayWrapEntryBytes {
  return {
    node_id: hexToBytes(entry.node_id),
    eph_pk: decodeBase64url(entry.eph_pk),
    nonce: decodeBase64url(entry.nonce),
    ct: decodeBase64url(entry.ct),
  };
}

export function wrapEntryFromBytes(entry: RelayWrapEntryBytes): WrapEntry {
  return {
    node_id: bytesToHex(entry.node_id),
    eph_pk: encodeBase64url(entry.eph_pk),
    nonce: encodeBase64url(entry.nonce),
    ct: encodeBase64url(entry.ct),
  };
}

export type StoredRelayTarget = {
  url: string;
  tenantId: string;
  token: Uint8Array;
  priority: number;
};

/** 密钥日志投影出的中继列表；`relays` 为空表示离开中继（状态里直接置 null）。 */
export type StoredRelayList = {
  mode: RelayListMode;
  relays: StoredRelayTarget[];
  logKeyEntries: WrapEntry[];
  seq: bigint;
};

export function cloneRelayList(list: StoredRelayList | null): StoredRelayList | null {
  if (!list) return null;
  return {
    mode: list.mode,
    relays: list.relays.map((relay) => ({ ...relay, token: new Uint8Array(relay.token) })),
    logKeyEntries: list.logKeyEntries.map((entry) => ({ ...entry })),
    seq: list.seq,
  };
}

type ApplyResult = { ok: true } | { ok: false; error: ApplyKeyLogError };

const MALFORMED: ApplyResult = { ok: false, error: 'malformed_payload' };
const EPOCH_REGRESSION: ApplyResult = { ok: false, error: 'relay_epoch_regression' };

function checkWrapEntries(entries: readonly RelayWrapEntryBytes[]): boolean {
  return entries.length <= RELAY_RECORD_MAX_WRAP_ENTRIES;
}

function toStoredTargets(payload: SetRelaysPayload): StoredRelayTarget[] | null {
  if (payload.relays.length > RELAY_RECORD_MAX_RELAYS) return null;
  const targets: StoredRelayTarget[] = [];
  for (const relay of payload.relays) {
    if (relay.url.length > RELAY_RECORD_MAX_URL_LEN) return null;
    let url: string;
    try {
      url = canonicalHubUrl(relay.url);
    } catch {
      return null;
    }
    targets.push({
      url,
      tenantId: bytesToHex(relay.tenant_id),
      token: new Uint8Array(relay.token),
      priority: relay.priority,
    });
  }
  return targets;
}

/**
 * `meta-key` 的 epoch 必须严格递增；`set-relays` 携带的 `meta_key` 允许等于当前 epoch
 * （同一世代补发给新节点）。
 */
function applyMetaKeyPayload(
  state: UserKeyState,
  payload: MetaKeyPayload,
  strictlyIncreasing: boolean
): ApplyResult {
  if (!checkWrapEntries(payload.entries)) return MALFORMED;
  if (payload.entries.length > 0 && payload.epoch < 1) return MALFORMED;
  const regressed = strictlyIncreasing
    ? payload.epoch <= state.metaKeyEpoch
    : payload.epoch < state.metaKeyEpoch;
  if (regressed) return EPOCH_REGRESSION;
  state.metaKeyEpoch = payload.epoch;
  state.metaKeyEntries = payload.entries.map(wrapEntryFromBytes);
  return { ok: true };
}

function applySetRelays(state: UserKeyState, record: KeyLogRecord): ApplyResult {
  let payload: SetRelaysPayload;
  try {
    payload = decodeSetRelaysPayload(record.payload);
  } catch {
    return MALFORMED;
  }
  if (!checkWrapEntries(payload.log_key)) return MALFORMED;
  const targets = toStoredTargets(payload);
  if (!targets) return MALFORMED;
  const meta = applyMetaKeyPayload(state, payload.meta_key, false);
  if (!meta.ok) return meta;
  state.relays =
    targets.length === 0
      ? null
      : {
          mode: payload.mode,
          relays: targets,
          logKeyEntries: payload.log_key.map(wrapEntryFromBytes),
          seq: record.seq,
        };
  return { ok: true };
}

function applyMetaKeyRecord(state: UserKeyState, record: KeyLogRecord): ApplyResult {
  let payload: MetaKeyPayload;
  try {
    payload = decodeMetaKeyPayload(record.payload);
  } catch {
    return MALFORMED;
  }
  return applyMetaKeyPayload(state, payload, true);
}

/** `set-relays` / `meta-key` 的状态投影；调用方保证 record.type 是这两者之一。 */
export function applyRelayKeyLogRecord(
  state: UserKeyState,
  record: KeyLogRecord
): ApplyKeyLogResult {
  const applied =
    record.type === 'set-relays'
      ? applySetRelays(state, record)
      : applyMetaKeyRecord(state, record);
  return applied.ok ? { ok: true, state, effects: [] } : applied;
}
