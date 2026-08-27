import { describe, expect, it } from 'bun:test';
import { bytesEqual, bytesToHex } from './encoding';
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

  it('locks AES-256-GCM ciphertext/tag for a fixed nonce', async () => {
    const nonce = new Uint8Array(12).fill(0x07);
    const record = await encryptTotpSecret(kTotp, secret, aad, nonce);
    expect(bytesToHex(record.nonce)).toBe('070707070707070707070707');
    expect(bytesToHex(record.ciphertext)).toBe('7e89247d9ebf4abe7fdd0c54a0e2b3b7');
    expect(bytesToHex(record.tag)).toBe('8e0b6151d060e1b56bf7c0e3e614f241');
    expect(bytesEqual(await decryptTotpSecret(kTotp, record, aad), secret)).toBe(true);
  });
});
