import { describe, expect, test } from 'bun:test';
import { encodeLogin } from './encoding';
import { buildLogin, verifyLogin } from './login';
import { verifyEd25519 } from './root-key';
import { generateWebCryptoEd25519KeyPair, signWithWebCryptoEd25519 } from './webcrypto-ed25519';

function fill(length: number, value: number): Uint8Array {
  const out = new Uint8Array(length);
  out.fill(value);
  return out;
}

describe('webcrypto ed25519', () => {
  test('生成不可导出私钥与 32 字节 raw 公钥', async () => {
    const pair = await generateWebCryptoEd25519KeyPair();
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.privateKey.type).toBe('private');
    expect(pair.publicKey).toHaveLength(32);
  });

  test('签名与 @noble 实现互通：node 侧的 verifyEd25519 直接可验', async () => {
    const pair = await generateWebCryptoEd25519KeyPair();
    const message = new TextEncoder().encode('tmex/webcrypto/interop');
    const sig = await signWithWebCryptoEd25519(pair.privateKey, message);
    expect(sig).toHaveLength(64);
    expect(verifyEd25519(sig, message, pair.publicKey)).toBe(true);
    expect(verifyEd25519(sig, new TextEncoder().encode('other'), pair.publicKey)).toBe(false);
  });

  test('用它签的 login 能通过 verifyLogin（node 侧登录校验不需要任何改动）', async () => {
    const pair = await generateWebCryptoEd25519KeyPair();
    const expected = {
      challengeId: 'c-1',
      nonce: fill(32, 0x44),
      target: 'node-b',
      targetPk: fill(32, 0x22),
      uid: 'alice',
      entry: 'node-a',
    };
    const login = buildLogin(expected);
    const sig = await signWithWebCryptoEd25519(pair.privateKey, encodeLogin(login));
    expect(verifyLogin(login, sig, pair.publicKey, expected)).toEqual({ ok: true });
  });
});
