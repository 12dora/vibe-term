import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { b } from '@zorsh/zorsh';
import {
  type KdfParams,
  concatBytes,
  decodeBase64url,
  encodeBase64url,
  hexToBytes,
  randomBytes,
} from '../auth/encoding';
import {
  KDF_BUDGET_ITERATIONS_MAX,
  KDF_BUDGET_MEMORY_KIB_MAX,
  KDF_BUDGET_PARALLELISM_MAX,
} from '../auth/root-key';

export const RELAY_PACK_VERSION = 1;
export const RELAY_PACK_HKDF_SALT = 'tmex-relay-pack/v1';
export const RELAY_PACK_NONCE_LENGTH = 12;
export const RELAY_PACK_KEK_LENGTH = 32;
export const RELAY_PACK_MAX_BYTES = 4096;
export const RELAY_PACK_KDF_SALT_LENGTH = 16;
const GCM_TAG_BITS = 128;
const TENANT_ID_HEX = /^[0-9a-f]{32}$/;

const te = new TextEncoder();

export class RelayPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayPackError';
  }
}

/** `{ v:u8=1, K_log(32), token(32), head_seq(u64), head_hash(32), issued_at(u64) }` */
export const RelayPackPlaintextSchema = b.struct({
  v: b.u8(),
  log_key: b.bytes(32),
  token: b.bytes(32),
  head_seq: b.u64(),
  head_hash: b.bytes(32),
  issued_at: b.u64(),
});
export type RelayPackPlaintext = b.infer<typeof RelayPackPlaintextSchema>;

export type RelayPackKdfJson = {
  salt: string;
  memory_kib: number;
  iterations: number;
  parallelism: number;
};

export type SealRelayPackInput = {
  rootSeed: Uint8Array;
  tenantId: string;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  plaintext: Omit<RelayPackPlaintext, 'v'> & { v?: number };
};

function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function u32le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RelayPackError('root_epoch must be a u32');
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export function tenantIdBytes(tenantId: string): Uint8Array {
  if (!TENANT_ID_HEX.test(tenantId)) {
    throw new RelayPackError('tenant_id must be 32 lowercase hex characters');
  }
  return hexToBytes(tenantId);
}

export function relayPackAad(input: {
  tenantId: string;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
}): Uint8Array {
  if (input.rootPublicKey.byteLength !== 32) {
    throw new RelayPackError('root public key must be 32 bytes');
  }
  return concatBytes(
    te.encode(RELAY_PACK_HKDF_SALT),
    tenantIdBytes(input.tenantId),
    input.rootPublicKey,
    u32le(input.rootEpoch)
  );
}

function derivePackKek(rootSeed: Uint8Array, tenantId: Uint8Array): Uint8Array {
  if (rootSeed.byteLength !== 32) {
    throw new RelayPackError('root seed must be 32 bytes');
  }
  return hkdf(sha256, rootSeed, te.encode(RELAY_PACK_HKDF_SALT), tenantId, RELAY_PACK_KEK_LENGTH);
}

function wipe(bytes: Uint8Array | undefined): void {
  bytes?.fill(0);
}

async function importAesKey(key: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  const raw = asBufferSource(key);
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
  } finally {
    wipe(raw);
  }
}

async function aesGcmSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await importAesKey(key, ['encrypt']);
  const pt = asBufferSource(plaintext);
  try {
    const sealed = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: asBufferSource(nonce),
        additionalData: asBufferSource(aad),
        tagLength: GCM_TAG_BITS,
      },
      cryptoKey,
      pt
    );
    return new Uint8Array(sealed);
  } finally {
    wipe(pt);
  }
}

async function aesGcmOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await importAesKey(key, ['decrypt']);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: asBufferSource(nonce),
        additionalData: asBufferSource(aad),
        tagLength: GCM_TAG_BITS,
      },
      cryptoKey,
      asBufferSource(ciphertext)
    );
  } catch {
    throw new RelayPackError('pack authentication failed');
  }
  return new Uint8Array(plain);
}

function encodePlaintext(value: RelayPackPlaintext): Uint8Array {
  if (value.v !== RELAY_PACK_VERSION) {
    throw new RelayPackError(`unsupported pack version: ${value.v}`);
  }
  if (value.log_key.byteLength !== 32 || value.token.byteLength !== 32) {
    throw new RelayPackError('log_key and token must be 32 bytes');
  }
  if (value.head_hash.byteLength !== 32) {
    throw new RelayPackError('head_hash must be 32 bytes');
  }
  return RelayPackPlaintextSchema.serialize({
    v: RELAY_PACK_VERSION,
    log_key: new Uint8Array(value.log_key),
    token: new Uint8Array(value.token),
    head_seq: value.head_seq,
    head_hash: new Uint8Array(value.head_hash),
    issued_at: value.issued_at,
  });
}

function decodePlaintext(bytes: Uint8Array): RelayPackPlaintext {
  let value: RelayPackPlaintext;
  try {
    value = RelayPackPlaintextSchema.deserialize(bytes);
  } catch {
    throw new RelayPackError('malformed pack plaintext');
  }
  if (value.v !== RELAY_PACK_VERSION) {
    throw new RelayPackError(`unsupported pack version: ${value.v}`);
  }
  return value;
}

/** `sealed_pack` 线格式：`nonce(12) ‖ AES-256-GCM(ct‖tag)`。 */
export async function sealRelayPack(input: SealRelayPackInput): Promise<Uint8Array> {
  const seed = new Uint8Array(input.rootSeed);
  let kek: Uint8Array | undefined;
  let encoded: Uint8Array | undefined;
  try {
    const tenantId = tenantIdBytes(input.tenantId);
    encoded = encodePlaintext({
      v: input.plaintext.v ?? RELAY_PACK_VERSION,
      log_key: input.plaintext.log_key,
      token: input.plaintext.token,
      head_seq:
        typeof input.plaintext.head_seq === 'bigint'
          ? input.plaintext.head_seq
          : BigInt(input.plaintext.head_seq),
      head_hash: input.plaintext.head_hash,
      issued_at:
        typeof input.plaintext.issued_at === 'bigint'
          ? input.plaintext.issued_at
          : BigInt(input.plaintext.issued_at),
    });
    const aad = relayPackAad({
      tenantId: input.tenantId,
      rootPublicKey: input.rootPublicKey,
      rootEpoch: input.rootEpoch,
    });
    kek = derivePackKek(seed, tenantId);
    const nonce = randomBytes(RELAY_PACK_NONCE_LENGTH);
    const ct = await aesGcmSeal(kek, nonce, encoded, aad);
    return concatBytes(nonce, ct);
  } finally {
    wipe(seed);
    wipe(kek);
    wipe(encoded);
    wipe(input.plaintext.log_key);
    wipe(input.plaintext.token);
  }
}

export async function openRelayPack(input: {
  rootSeed: Uint8Array;
  tenantId: string;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  sealedPack: Uint8Array;
}): Promise<RelayPackPlaintext> {
  if (input.sealedPack.byteLength < RELAY_PACK_NONCE_LENGTH + 16) {
    throw new RelayPackError('malformed sealed pack');
  }
  if (input.sealedPack.byteLength > RELAY_PACK_MAX_BYTES) {
    throw new RelayPackError('sealed pack exceeds size limit');
  }
  const tenantId = tenantIdBytes(input.tenantId);
  const aad = relayPackAad({
    tenantId: input.tenantId,
    rootPublicKey: input.rootPublicKey,
    rootEpoch: input.rootEpoch,
  });
  const nonce = input.sealedPack.subarray(0, RELAY_PACK_NONCE_LENGTH);
  const ct = input.sealedPack.subarray(RELAY_PACK_NONCE_LENGTH);
  const seed = new Uint8Array(input.rootSeed);
  const kek = derivePackKek(seed, tenantId);
  let plain: Uint8Array | undefined;
  try {
    plain = await aesGcmOpen(kek, nonce, ct, aad);
  } finally {
    wipe(seed);
    wipe(kek);
  }
  try {
    const decoded = decodePlaintext(plain);
    return {
      v: decoded.v,
      log_key: new Uint8Array(decoded.log_key),
      token: new Uint8Array(decoded.token),
      head_seq: decoded.head_seq,
      head_hash: new Uint8Array(decoded.head_hash),
      issued_at: decoded.issued_at,
    };
  } finally {
    wipe(plain);
  }
}

export function kdfParamsToWire(params: KdfParams): RelayPackKdfJson {
  return {
    salt: encodeBase64url(params.salt),
    memory_kib: params.memory_kib,
    iterations: params.iterations,
    parallelism: params.parallelism,
  };
}

function kdfIntInRange(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

export function kdfParamsFromWire(value: unknown): KdfParams | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.salt !== 'string') return null;
  const memoryKib = kdfIntInRange(rec.memory_kib, 8, KDF_BUDGET_MEMORY_KIB_MAX);
  const iterations = kdfIntInRange(rec.iterations, 1, KDF_BUDGET_ITERATIONS_MAX);
  const parallelism = kdfIntInRange(rec.parallelism, 1, KDF_BUDGET_PARALLELISM_MAX);
  if (memoryKib === null || iterations === null || parallelism === null) return null;
  let salt: Uint8Array;
  try {
    salt = decodeBase64url(rec.salt);
  } catch {
    return null;
  }
  if (salt.byteLength !== RELAY_PACK_KDF_SALT_LENGTH) return null;
  return {
    salt,
    memory_kib: memoryKib,
    iterations,
    parallelism,
  };
}
