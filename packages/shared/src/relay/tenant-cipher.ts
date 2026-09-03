import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeBase64url, encodeBase64url, hexToBytes, randomBytes } from '../auth/encoding';

export const RELAY_TENANT_KEY_LENGTH = 32;
export const RELAY_ENVELOPE_VERSION = 1;
export const RELAY_ENVELOPE_NONCE_LENGTH = 12;
export const RELAY_WRAP_NONCE_LENGTH = 12;
/** AES-256-GCM(32 字节租户密钥) = 32 密文 + 16 tag。 */
export const RELAY_WRAP_CIPHERTEXT_LENGTH = 48;
export const RELAY_WRAP_HKDF_SALT = 'tmex-relay-wrap/v1';
export const RELAY_ENVELOPE_AAD_PREFIX = 'tmex-relay/';
export const RELAY_ENVELOPE_AAD_SUFFIX = '/v1';

const te = new TextEncoder();
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const NODE_ID_HEX = /^[0-9a-f]{32}$/;
const GCM_TAG_BITS = 128;

export class RelayCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayCipherError';
  }
}

/** 中继看得到的密文信封：`v` 固定 1，`epoch` 是 K_meta 的世代（K_log 信封不带）。 */
export type RelayEnvelope = {
  v: 1;
  epoch?: number;
  n: string;
  ct: string;
};

/** 按节点 X25519 公钥封装的租户密钥，`node_id` 为 32 位小写 hex。 */
export type WrapEntry = {
  node_id: string;
  eph_pk: string;
  nonce: string;
  ct: string;
};

function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function assertKey(key: Uint8Array, label: string): void {
  if (key.byteLength !== RELAY_TENANT_KEY_LENGTH) {
    throw new RelayCipherError(`${label} must be ${RELAY_TENANT_KEY_LENGTH} bytes`);
  }
}

function assertKind(kind: string): void {
  if (!KIND_PATTERN.test(kind)) {
    throw new RelayCipherError(`invalid envelope kind: ${kind}`);
  }
}

function nodeIdBytes(nodeId: string): Uint8Array {
  if (!NODE_ID_HEX.test(nodeId)) {
    throw new RelayCipherError('node_id must be 32 lowercase hex characters');
  }
  return hexToBytes(nodeId);
}

export function relayEnvelopeAad(kind: string): Uint8Array {
  assertKind(kind);
  return te.encode(`${RELAY_ENVELOPE_AAD_PREFIX}${kind}${RELAY_ENVELOPE_AAD_SUFFIX}`);
}

export function generateTenantKey(): Uint8Array {
  return randomBytes(RELAY_TENANT_KEY_LENGTH);
}

async function importAesKey(key: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asBufferSource(key), { name: 'AES-GCM' }, false, usages);
}

async function aesGcmSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await importAesKey(key, ['encrypt']);
  const sealed = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: asBufferSource(nonce),
      ...(aad ? { additionalData: asBufferSource(aad) } : {}),
      tagLength: GCM_TAG_BITS,
    },
    cryptoKey,
    asBufferSource(plaintext)
  );
  return new Uint8Array(sealed);
}

async function aesGcmOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await importAesKey(key, ['decrypt']);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: asBufferSource(nonce),
        ...(aad ? { additionalData: asBufferSource(aad) } : {}),
        tagLength: GCM_TAG_BITS,
      },
      cryptoKey,
      asBufferSource(ciphertext)
    );
  } catch {
    throw new RelayCipherError('envelope authentication failed');
  }
  return new Uint8Array(plain);
}

export async function sealEnvelope(
  key: Uint8Array,
  kind: string,
  plaintext: Uint8Array,
  epoch?: number
): Promise<RelayEnvelope> {
  assertKey(key, 'tenant key');
  const aad = relayEnvelopeAad(kind);
  if (epoch !== undefined && (!Number.isInteger(epoch) || epoch < 0)) {
    throw new RelayCipherError('envelope epoch must be a non-negative integer');
  }
  const nonce = randomBytes(RELAY_ENVELOPE_NONCE_LENGTH);
  const ct = await aesGcmSeal(key, nonce, plaintext, aad);
  return {
    v: RELAY_ENVELOPE_VERSION,
    ...(epoch !== undefined ? { epoch } : {}),
    n: encodeBase64url(nonce),
    ct: encodeBase64url(ct),
  };
}

export async function openEnvelope(
  key: Uint8Array,
  kind: string,
  envelope: RelayEnvelope
): Promise<Uint8Array> {
  assertKey(key, 'tenant key');
  const aad = relayEnvelopeAad(kind);
  if (!envelope || envelope.v !== RELAY_ENVELOPE_VERSION) {
    throw new RelayCipherError('unsupported envelope version');
  }
  let nonce: Uint8Array;
  let ct: Uint8Array;
  try {
    nonce = decodeBase64url(envelope.n);
    ct = decodeBase64url(envelope.ct);
  } catch {
    throw new RelayCipherError('malformed envelope');
  }
  if (nonce.byteLength !== RELAY_ENVELOPE_NONCE_LENGTH) {
    throw new RelayCipherError('malformed envelope');
  }
  return aesGcmOpen(key, nonce, ct, aad);
}

function deriveWrapKey(sharedSecret: Uint8Array, nodeId: Uint8Array): Uint8Array {
  return hkdf(
    sha256,
    sharedSecret,
    te.encode(RELAY_WRAP_HKDF_SALT),
    nodeId,
    RELAY_TENANT_KEY_LENGTH
  );
}

export async function wrapKeyForNode(input: {
  key: Uint8Array;
  nodeId: string;
  nodeX25519Pk: Uint8Array;
}): Promise<WrapEntry> {
  assertKey(input.key, 'tenant key');
  const nodeId = nodeIdBytes(input.nodeId);
  if (input.nodeX25519Pk.byteLength !== 32) {
    throw new RelayCipherError('node x25519 public key must be 32 bytes');
  }
  const eph = x25519.keygen();
  let wrapKey: Uint8Array;
  try {
    wrapKey = deriveWrapKey(x25519.getSharedSecret(eph.secretKey, input.nodeX25519Pk), nodeId);
  } catch {
    throw new RelayCipherError('invalid node x25519 public key');
  }
  const nonce = randomBytes(RELAY_WRAP_NONCE_LENGTH);
  const ct = await aesGcmSeal(wrapKey, nonce, input.key);
  eph.secretKey.fill(0);
  wrapKey.fill(0);
  return {
    node_id: input.nodeId,
    eph_pk: encodeBase64url(eph.publicKey),
    nonce: encodeBase64url(nonce),
    ct: encodeBase64url(ct),
  };
}

export async function wrapKeyForNodes(input: {
  key: Uint8Array;
  nodes: readonly { nodeId: string; x25519Pk: Uint8Array }[];
}): Promise<WrapEntry[]> {
  const entries: WrapEntry[] = [];
  for (const node of input.nodes) {
    entries.push(
      await wrapKeyForNode({ key: input.key, nodeId: node.nodeId, nodeX25519Pk: node.x25519Pk })
    );
  }
  return entries;
}

export function findWrapEntry(
  entries: readonly WrapEntry[],
  nodeId: string
): WrapEntry | undefined {
  return entries.find((entry) => entry.node_id === nodeId);
}

export async function unwrapKeyForNode(input: {
  entry: WrapEntry;
  nodeX25519Sk: Uint8Array;
}): Promise<Uint8Array> {
  const nodeId = nodeIdBytes(input.entry.node_id);
  if (input.nodeX25519Sk.byteLength !== 32) {
    throw new RelayCipherError('node x25519 secret key must be 32 bytes');
  }
  let ephPk: Uint8Array;
  let nonce: Uint8Array;
  let ct: Uint8Array;
  try {
    ephPk = decodeBase64url(input.entry.eph_pk);
    nonce = decodeBase64url(input.entry.nonce);
    ct = decodeBase64url(input.entry.ct);
  } catch {
    throw new RelayCipherError('malformed wrap entry');
  }
  if (
    ephPk.byteLength !== 32 ||
    nonce.byteLength !== RELAY_WRAP_NONCE_LENGTH ||
    ct.byteLength !== RELAY_WRAP_CIPHERTEXT_LENGTH
  ) {
    throw new RelayCipherError('malformed wrap entry');
  }
  let wrapKey: Uint8Array;
  try {
    wrapKey = deriveWrapKey(x25519.getSharedSecret(input.nodeX25519Sk, ephPk), nodeId);
  } catch {
    throw new RelayCipherError('malformed wrap entry');
  }
  const key = await aesGcmOpen(wrapKey, nonce, ct);
  wrapKey.fill(0);
  if (key.byteLength !== RELAY_TENANT_KEY_LENGTH) {
    throw new RelayCipherError('wrapped key must be 32 bytes');
  }
  return key;
}
