import { type SetTotpPayload, type TotpAad, encodeTotpAad, randomBytes } from './encoding';

export const TOTP_AEAD_ALG = 'A256GCM';
const GCM_NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

async function importAesKey(kTotp: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (kTotp.length !== 32) {
    throw new Error('k_totp must be 32 bytes');
  }
  return crypto.subtle.importKey('raw', toBufferSource(kTotp), { name: 'AES-GCM' }, false, usages);
}

export function totpAadBytes(aad: TotpAad | Uint8Array): Uint8Array {
  return aad instanceof Uint8Array ? aad : encodeTotpAad(aad);
}

export async function encryptTotpSecret(
  kTotp: Uint8Array,
  secret: Uint8Array,
  aad: TotpAad | Uint8Array,
  nonce?: Uint8Array
): Promise<SetTotpPayload> {
  const iv = nonce ? new Uint8Array(nonce) : randomBytes(GCM_NONCE_LENGTH);
  if (iv.length !== GCM_NONCE_LENGTH) {
    throw new Error('AES-GCM nonce must be 12 bytes');
  }
  const key = await importAesKey(kTotp, ['encrypt']);
  const packed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toBufferSource(iv),
        additionalData: toBufferSource(totpAadBytes(aad)),
        tagLength: 128,
      },
      key,
      toBufferSource(secret)
    )
  );
  const ciphertext = packed.slice(0, packed.length - GCM_TAG_LENGTH);
  const tag = packed.slice(packed.length - GCM_TAG_LENGTH);
  return { alg: TOTP_AEAD_ALG, nonce: iv, ciphertext, tag };
}

export async function decryptTotpSecret(
  kTotp: Uint8Array,
  record: SetTotpPayload,
  aad: TotpAad | Uint8Array
): Promise<Uint8Array> {
  if (record.alg !== TOTP_AEAD_ALG) {
    throw new Error(`unsupported totp alg: ${record.alg}`);
  }
  const packed = new Uint8Array(new ArrayBuffer(record.ciphertext.length + record.tag.length));
  packed.set(record.ciphertext, 0);
  packed.set(record.tag, record.ciphertext.length);
  const key = await importAesKey(kTotp, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toBufferSource(record.nonce),
      additionalData: toBufferSource(totpAadBytes(aad)),
      tagLength: 128,
    },
    key,
    packed
  );
  return new Uint8Array(plain);
}
