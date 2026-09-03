import { describe, expect, it } from 'bun:test';
import { rootKeyFromSeed } from '../auth/root-key';
import {
  DOMAIN_RELAY_ENROLL,
  RELAY_ENROLL_PROOF_MAX_SKEW_MS,
  decodeRelayEnrollProof,
  encodeRelayEnrollProof,
  signRelayEnrollProof,
  verifyRelayEnrollProof,
} from './enroll-proof';

const rootKey = rootKeyFromSeed(new Uint8Array(32).fill(11));
const otherKey = rootKeyFromSeed(new Uint8Array(32).fill(22));
const HOST = 'relay.example.com';
const TS = 1_760_000_000_000;

describe('relay enroll proof', () => {
  it('签名 → 验签通过并回带 payload', () => {
    const signed = signRelayEnrollProof(rootKey, { relayHost: HOST, ts: TS });
    const result = verifyRelayEnrollProof({
      bytes: signed.bytes,
      sig: signed.sig,
      relayHost: HOST,
      rootPublicKey: rootKey.publicKey,
      now: TS + 1000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proof.domain).toBe(DOMAIN_RELAY_ENROLL);
    expect(result.proof.relay_host).toBe(HOST);
    expect(result.proof.ts).toBe(BigInt(TS));
  });

  it('编解码 round-trip', () => {
    const bytes = encodeRelayEnrollProof({
      relayHost: HOST,
      rootPublicKey: rootKey.publicKey,
      ts: TS,
    });
    expect(decodeRelayEnrollProof(bytes).relay_host).toBe(HOST);
  });

  it('换 host / 换根公钥 / 改签名都失败', () => {
    const signed = signRelayEnrollProof(rootKey, { relayHost: HOST, ts: TS });
    expect(
      verifyRelayEnrollProof({
        bytes: signed.bytes,
        sig: signed.sig,
        relayHost: 'evil.example.com',
        rootPublicKey: rootKey.publicKey,
      })
    ).toEqual({ ok: false, error: 'relay_host_mismatch' });
    expect(
      verifyRelayEnrollProof({
        bytes: signed.bytes,
        sig: signed.sig,
        relayHost: HOST,
        rootPublicKey: otherKey.publicKey,
      })
    ).toEqual({ ok: false, error: 'root_public_key_mismatch' });
    const tampered = new Uint8Array(signed.sig);
    tampered[0] ^= 0xff;
    expect(
      verifyRelayEnrollProof({
        bytes: signed.bytes,
        sig: tampered,
        relayHost: HOST,
        rootPublicKey: rootKey.publicKey,
      })
    ).toEqual({ ok: false, error: 'bad_signature' });
  });

  it('拿别人的根公钥签自己的名字也过不了', () => {
    const forged = signRelayEnrollProof(
      { publicKey: rootKey.publicKey, sign: (msg) => otherKey.sign(msg) },
      { relayHost: HOST, ts: TS }
    );
    expect(
      verifyRelayEnrollProof({
        bytes: forged.bytes,
        sig: forged.sig,
        relayHost: HOST,
        rootPublicKey: rootKey.publicKey,
      })
    ).toEqual({ ok: false, error: 'bad_signature' });
  });

  it('传 now 时按 ±5 分钟判定时间窗', () => {
    const signed = signRelayEnrollProof(rootKey, { relayHost: HOST, ts: TS });
    const args = {
      bytes: signed.bytes,
      sig: signed.sig,
      relayHost: HOST,
      rootPublicKey: rootKey.publicKey,
    };
    expect(verifyRelayEnrollProof({ ...args, now: TS + RELAY_ENROLL_PROOF_MAX_SKEW_MS }).ok).toBe(
      true
    );
    expect(
      verifyRelayEnrollProof({ ...args, now: TS + RELAY_ENROLL_PROOF_MAX_SKEW_MS + 1 })
    ).toEqual({ ok: false, error: 'ts_skew' });
    expect(
      verifyRelayEnrollProof({ ...args, now: TS - RELAY_ENROLL_PROOF_MAX_SKEW_MS - 1 })
    ).toEqual({ ok: false, error: 'ts_skew' });
    expect(verifyRelayEnrollProof({ ...args }).ok).toBe(true);
  });

  it('畸形字节被识别', () => {
    expect(
      verifyRelayEnrollProof({
        bytes: new Uint8Array([1, 2, 3]),
        sig: new Uint8Array(64),
        relayHost: HOST,
        rootPublicKey: rootKey.publicKey,
      }).ok
    ).toBe(false);
    expect(() =>
      encodeRelayEnrollProof({ relayHost: '', rootPublicKey: rootKey.publicKey, ts: 1 })
    ).toThrow();
    expect(() =>
      encodeRelayEnrollProof({ relayHost: HOST, rootPublicKey: new Uint8Array(31), ts: 1 })
    ).toThrow();
  });
});
