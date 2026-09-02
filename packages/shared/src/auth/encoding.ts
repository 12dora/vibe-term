import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import {
  bytesToHex as nobleBytesToHex,
  concatBytes as nobleConcatBytes,
  hexToBytes as nobleHexToBytes,
  randomBytes as nobleRandomBytes,
} from '@noble/hashes/utils.js';
import { b } from '@zorsh/zorsh';

export const DOMAIN_DELEGATION = 'tmex/delegation/v1';
export const DOMAIN_LOGIN = 'tmex/login/v1';
export const DOMAIN_AUTHORIZATION = 'tmex/enroll/v1';
export const DOMAIN_CERTIFICATE = 'tmex/nodecert/v1';
export const DOMAIN_KEY_LOG = 'tmex/keylog/v1';
export const DOMAIN_PEER = 'tmex/peer/v1';

export const DelegationMethod = {
  root: 'root',
  passkey: 'passkey',
} as const;
export type DelegationMethod = (typeof DelegationMethod)[keyof typeof DelegationMethod];

export const KeyLogSigner = {
  root: 'root',
  passkey: 'passkey',
} as const;
export type KeyLogSigner = (typeof KeyLogSigner)[keyof typeof KeyLogSigner];

export const KeyLogType = {
  'add-passkey': 'add-passkey',
  'remove-passkey': 'remove-passkey',
  'rotate-root': 'rotate-root',
  'set-totp': 'set-totp',
  'clear-totp': 'clear-totp',
  'admit-node': 'admit-node',
  'revoke-node': 'revoke-node',
  'reset-root': 'reset-root',
  'admit-hub': 'admit-hub',
  'retire-hub': 'retire-hub',
  'rotate-root-keep': 'rotate-root-keep',
} as const;
export type KeyLogType = (typeof KeyLogType)[keyof typeof KeyLogType];

export const PeerPath = {
  dc: 'dc',
  relay: 'relay',
} as const;
export type PeerPath = (typeof PeerPath)[keyof typeof PeerPath];

const DelegationMethodSchema = b.nativeEnum(DelegationMethod);
const KeyLogSignerSchema = b.nativeEnum(KeyLogSigner);
const KeyLogTypeSchema = b.nativeEnum(KeyLogType);
const PeerPathSchema = b.nativeEnum(PeerPath);

export const KdfParamsSchema = b.struct({
  salt: b.bytes(16),
  memory_kib: b.u32(),
  iterations: b.u32(),
  parallelism: b.u32(),
});
export type KdfParams = b.infer<typeof KdfParamsSchema>;

export const DtlsFingerprintSchema = b.struct({
  algorithm: b.string(),
  value: b.string(),
});
export type DtlsFingerprint = b.infer<typeof DtlsFingerprintSchema>;

export const PeerHelloSchema = b.struct({
  node_id: b.bytes(16),
  nonce: b.bytes(32),
  eph_x25519_pk: b.option(b.bytes(32)),
  dtls_fingerprint: b.option(DtlsFingerprintSchema),
});
export type PeerHello = b.infer<typeof PeerHelloSchema>;

export const DelegationSchema = b.struct({
  domain: b.string(),
  uid: b.string(),
  sess_pk: b.bytes(32),
  issued_at: b.u64(),
  exp: b.u64(),
  method: DelegationMethodSchema,
  credential_id: b.option(b.string()),
});
export type Delegation = b.infer<typeof DelegationSchema>;

export const LoginSchema = b.struct({
  domain: b.string(),
  challenge_id: b.string(),
  nonce: b.bytes(32),
  target: b.string(),
  target_pk: b.bytes(32),
  uid: b.string(),
  entry: b.string(),
});
export type Login = b.infer<typeof LoginSchema>;

export const AuthorizationSchema = b.struct({
  domain: b.string(),
  uid: b.string(),
  enroll_pk: b.bytes(32),
  exp: b.u64(),
  root_epoch: b.u32(),
  signer: KeyLogSignerSchema,
  credential_id: b.option(b.string()),
});
export type Authorization = b.infer<typeof AuthorizationSchema>;

export const PasskeyAssertionSchema = b.struct({
  credential_id: b.string(),
  client_data_json: b.bytes(),
  authenticator_data: b.bytes(),
  signature: b.bytes(),
});
export type PasskeyAssertion = b.infer<typeof PasskeyAssertionSchema>;

export const CertificateSchema = b.struct({
  domain: b.string(),
  uid: b.string(),
  node_id: b.bytes(16),
  ed_pk: b.bytes(32),
  x25519_pk: b.bytes(32),
  enroll_pk: b.bytes(32),
  issued_at: b.u64(),
});
export type Certificate = b.infer<typeof CertificateSchema>;

export const KeyLogRecordSchema = b.struct({
  domain: b.string(),
  uid: b.string(),
  seq: b.u64(),
  prev_hash: b.bytes(32),
  root_epoch: b.u32(),
  type: KeyLogTypeSchema,
  payload: b.bytes(),
  signer: KeyLogSignerSchema,
  credential_id: b.option(b.string()),
});
export type KeyLogRecord = b.infer<typeof KeyLogRecordSchema>;

export const PeerTranscriptSchema = b.struct({
  domain: b.string(),
  path: PeerPathSchema,
  hello_lo: PeerHelloSchema,
  hello_hi: PeerHelloSchema,
});
export type PeerTranscript = b.infer<typeof PeerTranscriptSchema>;

export const TotpAadSchema = b.struct({
  uid: b.string(),
  root_epoch: b.u32(),
  seq: b.u64(),
});
export type TotpAad = b.infer<typeof TotpAadSchema>;

export const AddPasskeyPayloadSchema = b.struct({
  credential_id: b.string(),
  public_key: b.bytes(),
  rp_id: b.string(),
  origin: b.string(),
  counter: b.u32(),
  transports: b.vec(b.string()),
  backup_eligible: b.bool(),
  backup_state: b.bool(),
  device_type: b.string(),
  name: b.string(),
});
export type AddPasskeyPayload = b.infer<typeof AddPasskeyPayloadSchema>;

export const RemovePasskeyPayloadSchema = b.struct({
  credential_id: b.string(),
});
export type RemovePasskeyPayload = b.infer<typeof RemovePasskeyPayloadSchema>;

export const RotateRootPayloadSchema = b.struct({
  root_public_key: b.bytes(32),
  kdf_params: KdfParamsSchema,
});
export type RotateRootPayload = b.infer<typeof RotateRootPayloadSchema>;
export const ResetRootPayloadSchema = RotateRootPayloadSchema;
export type ResetRootPayload = RotateRootPayload;

export const SetTotpPayloadSchema = b.struct({
  alg: b.string(),
  nonce: b.bytes(12),
  ciphertext: b.bytes(),
  tag: b.bytes(16),
});
export type SetTotpPayload = b.infer<typeof SetTotpPayloadSchema>;

/**
 * 常规改密（保留 passkey / TOTP / 会话）随带的 TOTP 重封装：
 * `root_epoch` 必须等于记录 `root_epoch + 1`，`seq` 必须等于记录自身 `seq`（即 AAD 的取值）。
 */
export const RotateRootKeepTotpSchema = b.struct({
  root_epoch: b.u32(),
  seq: b.u64(),
  payload: SetTotpPayloadSchema,
});
export type RotateRootKeepTotp = b.infer<typeof RotateRootKeepTotpSchema>;

export const RotateRootKeepPayloadSchema = b.struct({
  root_public_key: b.bytes(32),
  kdf_params: KdfParamsSchema,
  totp: b.option(RotateRootKeepTotpSchema),
});
export type RotateRootKeepPayload = b.infer<typeof RotateRootKeepPayloadSchema>;

export const ClearTotpPayloadSchema = b.struct({});
export type ClearTotpPayload = b.infer<typeof ClearTotpPayloadSchema>;

export const AdmitNodePayloadSchema = b.struct({
  authorization_bytes: b.bytes(),
  authorization_sig: b.bytes(),
  certificate_bytes: b.bytes(),
  cert_sig: b.bytes(64),
});
export type AdmitNodePayload = b.infer<typeof AdmitNodePayloadSchema>;

export const RevokeNodePayloadSchema = b.struct({
  node_id: b.bytes(16),
  reason: b.string(),
});
export type RevokeNodePayload = b.infer<typeof RevokeNodePayloadSchema>;

export const AdmitHubPayloadSchema = b.struct({
  hub_node_id: b.bytes(16),
  public_url: b.option(b.string()),
  priority: b.option(b.u32()),
});
export type AdmitHubPayload = b.infer<typeof AdmitHubPayloadSchema>;

export const RetireHubPayloadSchema = b.struct({
  hub_node_id: b.bytes(16),
});
export type RetireHubPayload = b.infer<typeof RetireHubPayloadSchema>;

function assertDomain(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`domain mismatch: expected ${expected}, got ${actual}`);
  }
}

export function encodeDelegation(value: Delegation): Uint8Array {
  return DelegationSchema.serialize({ ...value, domain: DOMAIN_DELEGATION });
}

export function decodeDelegation(bytes: Uint8Array): Delegation {
  const value = DelegationSchema.deserialize(bytes);
  assertDomain(value.domain, DOMAIN_DELEGATION);
  return value;
}

export function encodeLogin(value: Login): Uint8Array {
  return LoginSchema.serialize({ ...value, domain: DOMAIN_LOGIN });
}

export function decodeLogin(bytes: Uint8Array): Login {
  const value = LoginSchema.deserialize(bytes);
  assertDomain(value.domain, DOMAIN_LOGIN);
  return value;
}

export function encodePasskeyAssertion(value: PasskeyAssertion): Uint8Array {
  return PasskeyAssertionSchema.serialize(value);
}

export function decodePasskeyAssertion(bytes: Uint8Array): PasskeyAssertion {
  return PasskeyAssertionSchema.deserialize(bytes);
}

export function encodeAuthorization(value: Authorization): Uint8Array {
  return AuthorizationSchema.serialize({ ...value, domain: DOMAIN_AUTHORIZATION });
}

export function decodeAuthorization(bytes: Uint8Array): Authorization {
  const value = AuthorizationSchema.deserialize(bytes);
  assertDomain(value.domain, DOMAIN_AUTHORIZATION);
  return value;
}

export function encodeCertificate(value: Certificate): Uint8Array {
  return CertificateSchema.serialize({ ...value, domain: DOMAIN_CERTIFICATE });
}

export function decodeCertificate(bytes: Uint8Array): Certificate {
  const value = CertificateSchema.deserialize(bytes);
  assertDomain(value.domain, DOMAIN_CERTIFICATE);
  return value;
}

export function encodeKeyLogRecord(value: KeyLogRecord): Uint8Array {
  return KeyLogRecordSchema.serialize({ ...value, domain: DOMAIN_KEY_LOG });
}

export function decodeKeyLogRecord(bytes: Uint8Array): KeyLogRecord {
  const value = KeyLogRecordSchema.deserialize(bytes);
  assertDomain(value.domain, DOMAIN_KEY_LOG);
  return value;
}

export function encodePeerTranscript(value: PeerTranscript): Uint8Array {
  return PeerTranscriptSchema.serialize({ ...value, domain: DOMAIN_PEER });
}

export function decodePeerTranscript(bytes: Uint8Array): PeerTranscript {
  const value = PeerTranscriptSchema.deserialize(bytes);
  assertDomain(value.domain, DOMAIN_PEER);
  return value;
}

export function encodeTotpAad(value: TotpAad): Uint8Array {
  return TotpAadSchema.serialize(value);
}

export function decodeTotpAad(bytes: Uint8Array): TotpAad {
  return TotpAadSchema.deserialize(bytes);
}

export function encodeAddPasskeyPayload(value: AddPasskeyPayload): Uint8Array {
  return AddPasskeyPayloadSchema.serialize(value);
}
export function decodeAddPasskeyPayload(bytes: Uint8Array): AddPasskeyPayload {
  return AddPasskeyPayloadSchema.deserialize(bytes);
}

export function encodeRemovePasskeyPayload(value: RemovePasskeyPayload): Uint8Array {
  return RemovePasskeyPayloadSchema.serialize(value);
}
export function decodeRemovePasskeyPayload(bytes: Uint8Array): RemovePasskeyPayload {
  return RemovePasskeyPayloadSchema.deserialize(bytes);
}

export function encodeRotateRootPayload(value: RotateRootPayload): Uint8Array {
  return RotateRootPayloadSchema.serialize(value);
}
export function encodeRotateRootKeepPayload(value: RotateRootKeepPayload): Uint8Array {
  return RotateRootKeepPayloadSchema.serialize(value);
}
export function decodeRotateRootKeepPayload(bytes: Uint8Array): RotateRootKeepPayload {
  return RotateRootKeepPayloadSchema.deserialize(bytes);
}
export function decodeRotateRootPayload(bytes: Uint8Array): RotateRootPayload {
  return RotateRootPayloadSchema.deserialize(bytes);
}

export function encodeResetRootPayload(value: ResetRootPayload): Uint8Array {
  return encodeRotateRootPayload(value);
}
export function decodeResetRootPayload(bytes: Uint8Array): ResetRootPayload {
  return decodeRotateRootPayload(bytes);
}

export function encodeSetTotpPayload(value: SetTotpPayload): Uint8Array {
  return SetTotpPayloadSchema.serialize(value);
}
export function decodeSetTotpPayload(bytes: Uint8Array): SetTotpPayload {
  return SetTotpPayloadSchema.deserialize(bytes);
}

export function encodeClearTotpPayload(value: ClearTotpPayload = {}): Uint8Array {
  return ClearTotpPayloadSchema.serialize(value);
}
export function decodeClearTotpPayload(bytes: Uint8Array): ClearTotpPayload {
  return ClearTotpPayloadSchema.deserialize(bytes);
}

export function encodeAdmitNodePayload(value: AdmitNodePayload): Uint8Array {
  return AdmitNodePayloadSchema.serialize(value);
}
export function decodeAdmitNodePayload(bytes: Uint8Array): AdmitNodePayload {
  return AdmitNodePayloadSchema.deserialize(bytes);
}

export function encodeRevokeNodePayload(value: RevokeNodePayload): Uint8Array {
  return RevokeNodePayloadSchema.serialize(value);
}
export function decodeRevokeNodePayload(bytes: Uint8Array): RevokeNodePayload {
  return RevokeNodePayloadSchema.deserialize(bytes);
}

export function encodeAdmitHubPayload(value: AdmitHubPayload): Uint8Array {
  return AdmitHubPayloadSchema.serialize(value);
}
export function decodeAdmitHubPayload(bytes: Uint8Array): AdmitHubPayload {
  return AdmitHubPayloadSchema.deserialize(bytes);
}

export function encodeRetireHubPayload(value: RetireHubPayload): Uint8Array {
  return RetireHubPayloadSchema.serialize(value);
}
export function decodeRetireHubPayload(bytes: Uint8Array): RetireHubPayload {
  return RetireHubPayloadSchema.deserialize(bytes);
}

export function buildAdmitHubPayload(input: {
  hubNodeId: Uint8Array;
  publicUrl?: string | null;
  priority?: number | null;
}): Uint8Array {
  return encodeAdmitHubPayload({
    hub_node_id: input.hubNodeId,
    public_url: input.publicUrl ?? null,
    priority: input.priority ?? null,
  });
}

export function buildRetireHubPayload(input: { hubNodeId: Uint8Array }): Uint8Array {
  return encodeRetireHubPayload({ hub_node_id: input.hubNodeId });
}

export function encodeKdfParams(value: KdfParams): Uint8Array {
  return KdfParamsSchema.serialize(value);
}
export function decodeKdfParams(bytes: Uint8Array): KdfParams {
  return KdfParamsSchema.deserialize(bytes);
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes);
}

export function bytesToHex(bytes: Uint8Array): string {
  return nobleBytesToHex(bytes);
}

export function hexToBytes(hex: string): Uint8Array {
  return nobleHexToBytes(hex);
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  return nobleConcatBytes(...arrays);
}

export function randomBytes(n: number): Uint8Array {
  return nobleRandomBytes(n);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return a.length - b.length;
}

export function u32ToLe(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

export function encodeBase64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeBase64url(input: string): Uint8Array {
  const padLen = (4 - (input.length % 4)) % 4;
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function nodeIdToHex(nodeId: Uint8Array): string {
  return bytesToHex(nodeId);
}
