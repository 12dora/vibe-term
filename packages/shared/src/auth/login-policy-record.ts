// 全网登录限流策略 `login-policy`：根钥 / passkey 签名，后写的一条覆盖前一条。
// 没有任何记录时各节点用预设 `standard`（见 `standardLoginPolicy`）。

import { b } from '@zorsh/zorsh';
import type { KeyLogRecord, KeyLogSigner } from './encoding';
import { encodeKeyLogRecord } from './encoding';
import type { ApplyKeyLogResult, KeyLogHead, UserKeyState } from './key-log';
import { buildKeyLogRecord, signKeyLogRecordWithRoot } from './key-log';
import type { RootKey } from './root-key';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** 载荷版本。改字段布局时递增，旧版本按畸形拒绝。 */
export const LOGIN_POLICY_PAYLOAD_VERSION = 1;

export const LOGIN_POLICY_PRESET_NAMES = ['relaxed', 'standard', 'strict', 'custom'] as const;
export type LoginPolicyPreset = (typeof LOGIN_POLICY_PRESET_NAMES)[number];
export type NamedLoginPolicyPreset = Exclude<LoginPolicyPreset, 'custom'>;

export type LoginPolicyNumbers = {
  ipFailThreshold: number;
  ipLockBaseMs: number;
  ipLockMaxMs: number;
  accountFailPerHour: number;
  accountLockMs: number;
};

export type LoginPolicy = LoginPolicyNumbers & {
  preset: LoginPolicyPreset;
  exemptLocal: boolean;
};

/** 命名预设的数值。`exemptLocal` 不在表里，缺省 true，命名预设也允许改它。 */
export const LOGIN_POLICY_PRESETS: Record<NamedLoginPolicyPreset, LoginPolicyNumbers> = {
  relaxed: {
    ipFailThreshold: 20,
    ipLockBaseMs: 5 * MINUTE_MS,
    ipLockMaxMs: HOUR_MS,
    accountFailPerHour: 100,
    accountLockMs: 5 * MINUTE_MS,
  },
  standard: {
    ipFailThreshold: 10,
    ipLockBaseMs: 15 * MINUTE_MS,
    ipLockMaxMs: DAY_MS,
    accountFailPerHour: 50,
    accountLockMs: 15 * MINUTE_MS,
  },
  strict: {
    ipFailThreshold: 5,
    ipLockBaseMs: 30 * MINUTE_MS,
    ipLockMaxMs: WEEK_MS,
    accountFailPerHour: 20,
    accountLockMs: HOUR_MS,
  },
};

export type LoginPolicyValidation =
  | { ok: true; policy: LoginPolicy }
  | { ok: false; error: 'invalid_login_policy' };

export type LoginPolicyBlocker = {
  nodeId: string;
  name: string;
  version: string | null;
};

export type LoginPolicyStatus = {
  policy: LoginPolicy;
  source: 'default' | 'keylog';
  writable: boolean;
  blockers: LoginPolicyBlocker[];
};

/** 字段顺序即 Borsh 编码顺序，改动等于换协议。 */
export const LoginPolicyPayloadSchema = b.struct({
  version: b.u32(),
  preset: b.string(),
  ip_fail_threshold: b.u32(),
  ip_lock_base_ms: b.u32(),
  ip_lock_max_ms: b.u32(),
  account_fail_per_hour: b.u32(),
  account_lock_ms: b.u32(),
  exempt_local: b.bool(),
});
export type LoginPolicyPayload = b.infer<typeof LoginPolicyPayloadSchema>;

export function encodeLoginPolicyPayload(value: LoginPolicyPayload): Uint8Array {
  return LoginPolicyPayloadSchema.serialize(value);
}

export function decodeLoginPolicyPayload(bytes: Uint8Array): LoginPolicyPayload {
  return LoginPolicyPayloadSchema.deserialize(bytes);
}

export function standardLoginPolicy(): LoginPolicy {
  return loginPolicyFromPreset('standard');
}

export function loginPolicyFromPreset(
  preset: NamedLoginPolicyPreset,
  exemptLocal = true
): LoginPolicy {
  return { preset, exemptLocal, ...LOGIN_POLICY_PRESETS[preset] };
}

export function validateLoginPolicy(value: unknown): LoginPolicyValidation {
  const policy = readLoginPolicy(value);
  if (!policy) return { ok: false, error: 'invalid_login_policy' };
  const numbersOk = policy.preset === 'custom' ? customInRange(policy) : namedPresetMatches(policy);
  if (!numbersOk) return { ok: false, error: 'invalid_login_policy' };
  return { ok: true, policy };
}

/** 校验通过后编码。网关 `signAndApply` / 客户端签名都走这条，避免绕过范围检查。 */
export function encodeLoginPolicy(policy: LoginPolicy): Uint8Array {
  const validated = validateLoginPolicy(policy);
  if (!validated.ok) throw new Error('invalid login policy');
  return encodeLoginPolicyPayload(payloadFromPolicy(validated.policy));
}

export type LoginPolicyRecordInput = {
  head: KeyLogHead;
  rootEpoch: number;
  uid: string;
  policy: LoginPolicy;
  signer: KeyLogSigner;
  /** `signer === 'passkey'` 时必填。 */
  credentialId?: string | null;
};

/** 未签名的下一条 `login-policy` 记录。FE / CLI 再用根钥或 passkey 对 `encodeKeyLogRecord` 的字节签名。 */
export function buildLoginPolicyRecord(input: LoginPolicyRecordInput): KeyLogRecord {
  const credentialId = input.signer === 'passkey' ? (input.credentialId ?? null) : null;
  if (input.signer === 'passkey' && !credentialId) {
    throw new Error('passkey credential id required');
  }
  return buildKeyLogRecord(input.head, input.rootEpoch, {
    uid: input.uid,
    type: 'login-policy',
    payload: encodeLoginPolicy(input.policy),
    signer: input.signer,
    credential_id: credentialId,
  });
}

export function signLoginPolicyRecordWithRoot(input: {
  head: KeyLogHead;
  rootEpoch: number;
  uid: string;
  policy: LoginPolicy;
  rootKey: RootKey;
}): { bytes: Uint8Array; sig: Uint8Array } {
  const record = buildLoginPolicyRecord({
    head: input.head,
    rootEpoch: input.rootEpoch,
    uid: input.uid,
    policy: input.policy,
    signer: 'root',
  });
  const bytes = encodeKeyLogRecord(record);
  return { bytes, sig: signKeyLogRecordWithRoot(input.rootKey, bytes) };
}

export function applyLoginPolicy(state: UserKeyState, record: KeyLogRecord): ApplyKeyLogResult {
  const policy = policyFromPayload(record.payload);
  if (!policy) return { ok: false, error: 'malformed_payload' };
  state.loginPolicy = policy;
  return { ok: true, state, effects: [] };
}

function policyFromPayload(bytes: Uint8Array): LoginPolicy | null {
  let payload: LoginPolicyPayload;
  try {
    payload = decodeLoginPolicyPayload(bytes);
  } catch {
    return null;
  }
  if (payload.version !== LOGIN_POLICY_PAYLOAD_VERSION) return null;
  const validated = validateLoginPolicy({
    preset: payload.preset,
    ipFailThreshold: payload.ip_fail_threshold,
    ipLockBaseMs: payload.ip_lock_base_ms,
    ipLockMaxMs: payload.ip_lock_max_ms,
    accountFailPerHour: payload.account_fail_per_hour,
    accountLockMs: payload.account_lock_ms,
    exemptLocal: payload.exempt_local,
  });
  return validated.ok ? validated.policy : null;
}

function payloadFromPolicy(policy: LoginPolicy): LoginPolicyPayload {
  return {
    version: LOGIN_POLICY_PAYLOAD_VERSION,
    preset: policy.preset,
    ip_fail_threshold: policy.ipFailThreshold,
    ip_lock_base_ms: policy.ipLockBaseMs,
    ip_lock_max_ms: policy.ipLockMaxMs,
    account_fail_per_hour: policy.accountFailPerHour,
    account_lock_ms: policy.accountLockMs,
    exempt_local: policy.exemptLocal,
  };
}

function readLoginPolicy(value: unknown): LoginPolicy | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const preset = readPreset(raw.preset);
  const ipFailThreshold = readInt(raw.ipFailThreshold);
  const ipLockBaseMs = readInt(raw.ipLockBaseMs);
  const ipLockMaxMs = readInt(raw.ipLockMaxMs);
  const accountFailPerHour = readInt(raw.accountFailPerHour);
  const accountLockMs = readInt(raw.accountLockMs);
  const exemptLocal = typeof raw.exemptLocal === 'boolean' ? raw.exemptLocal : null;
  if (
    preset === null ||
    ipFailThreshold === null ||
    ipLockBaseMs === null ||
    ipLockMaxMs === null ||
    accountFailPerHour === null ||
    accountLockMs === null ||
    exemptLocal === null
  ) {
    return null;
  }
  return {
    preset,
    ipFailThreshold,
    ipLockBaseMs,
    ipLockMaxMs,
    accountFailPerHour,
    accountLockMs,
    exemptLocal,
  };
}

function readPreset(value: unknown): LoginPolicyPreset | null {
  if (value === 'relaxed' || value === 'standard' || value === 'strict' || value === 'custom') {
    return value;
  }
  return null;
}

function readInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value;
}

function namedPresetMatches(policy: LoginPolicy): boolean {
  if (policy.preset === 'custom') return false;
  const spec = LOGIN_POLICY_PRESETS[policy.preset];
  return (
    policy.ipFailThreshold === spec.ipFailThreshold &&
    policy.ipLockBaseMs === spec.ipLockBaseMs &&
    policy.ipLockMaxMs === spec.ipLockMaxMs &&
    policy.accountFailPerHour === spec.accountFailPerHour &&
    policy.accountLockMs === spec.accountLockMs
  );
}

function customInRange(policy: LoginPolicy): boolean {
  return (
    inRange(policy.ipFailThreshold, 3, 100) &&
    inRange(policy.ipLockBaseMs, MINUTE_MS, DAY_MS) &&
    policy.ipLockMaxMs >= policy.ipLockBaseMs &&
    policy.ipLockMaxMs <= WEEK_MS &&
    inRange(policy.accountFailPerHour, 10, 1000) &&
    inRange(policy.accountLockMs, MINUTE_MS, DAY_MS)
  );
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}
