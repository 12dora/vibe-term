import { describe, expect, it } from 'bun:test';
import { bytesEqual } from './encoding';
import { decryptTotpSecret, encryptTotpSecret } from './totp-cipher';

const kTotp = new Uint8Array(32).fill(0x44);
const secret = new TextEncoder().encode('JBSWY3DPEHPK3PXP');
const aad = { uid: 'user-1', root_epoch: 0, seq: 1n };

describe('totp-cipher AES-256-GCM', () => {
  it('round-trips a TOTP secret', async () => {
    const record = await encryptTotpSecret(kTotp, secret, aad);
    expect(record.alg).toBe('A256GCM');
    expect(record.nonce.length).toBe(12);
    expect(record.tag.length).toBe(16);
    const plain = await decryptTotpSecret(kTotp, record, aad);
    expect(bytesEqual(plain, secret)).toBe(true);
  });

  it('rejects tampered ciphertext, tag, or AAD', async () => {
    const record = await encryptTotpSecret(kTotp, secret, aad);
    const tweakedCt = { ...record, ciphertext: new Uint8Array(record.ciphertext) };
    tweakedCt.ciphertext[0] ^= 0xff;
    await expect(decryptTotpSecret(kTotp, tweakedCt, aad)).rejects.toBeDefined();

    const tweakedTag = { ...record, tag: new Uint8Array(record.tag) };
    tweakedTag.tag[0] ^= 0xff;
    await expect(decryptTotpSecret(kTotp, tweakedTag, aad)).rejects.toBeDefined();

    await expect(
      decryptTotpSecret(kTotp, record, { uid: 'user-1', root_epoch: 1, seq: 1n })
    ).rejects.toBeDefined();
  });
});
