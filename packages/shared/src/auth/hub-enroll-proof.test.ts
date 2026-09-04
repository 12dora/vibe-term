import { describe, expect, it } from 'bun:test';
import {
  DOMAIN_HUB_ENROLL,
  HUB_ENROLL_PROOF_MAX_SKEW_MS,
  decodeHubEnrollProof,
  encodeHubEnrollProof,
  signHubEnrollProof,
  verifyHubEnrollProof,
} from './hub-enroll-proof';
import { rootKeyFromSeed } from './root-key';

const rootKey = rootKeyFromSeed(new Uint8Array(32).fill(11));
const otherKey = rootKeyFromSeed(new Uint8Array(32).fill(22));
const HOST = 'hub.example.com';
const UID = 'user-1';
const ENROLL_PK = new Uint8Array(32).fill(7);
const TS = 1_760_000_000_000;

describe('hub enroll proof', () => {
  it('签名 → 验签通过并回带 payload', () => {
    const signed = signHubEnrollProof(rootKey, {
      hubHost: HOST,
      uid: UID,
      enrollPk: ENROLL_PK,
      ts: TS,
    });
    const result = verifyHubEnrollProof({
      bytes: signed.bytes,
      sig: signed.sig,
      hubHost: HOST,
      uid: UID,
      rootPublicKey: rootKey.publicKey,
      enrollPk: ENROLL_PK,
      now: TS + 1000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proof.domain).toBe(DOMAIN_HUB_ENROLL);
    expect(result.proof.hub_host).toBe(HOST);
    expect(result.proof.uid).toBe(UID);
    expect(result.proof.ts).toBe(BigInt(TS));
  });

  it('编解码 round-trip', () => {
    const bytes = encodeHubEnrollProof({
      hubHost: HOST,
      uid: UID,
      rootPublicKey: rootKey.publicKey,
      enrollPk: ENROLL_PK,
      ts: TS,
    });
    const decoded = decodeHubEnrollProof(bytes);
    expect(decoded.hub_host).toBe(HOST);
    expect(decoded.uid).toBe(UID);
  });

  it('换 host / uid / enroll_pk / 根公钥 / 改签名都失败', () => {
    const signed = signHubEnrollProof(rootKey, {
      hubHost: HOST,
      uid: UID,
      enrollPk: ENROLL_PK,
      ts: TS,
    });
    const base = {
      bytes: signed.bytes,
      sig: signed.sig,
      hubHost: HOST,
      uid: UID,
      rootPublicKey: rootKey.publicKey,
      enrollPk: ENROLL_PK,
    };
    expect(verifyHubEnrollProof({ ...base, hubHost: 'evil.example.com' })).toEqual({
      ok: false,
      error: 'hub_host_mismatch',
    });
    expect(verifyHubEnrollProof({ ...base, uid: 'other' })).toEqual({
      ok: false,
      error: 'uid_mismatch',
    });
    expect(verifyHubEnrollProof({ ...base, rootPublicKey: otherKey.publicKey })).toEqual({
      ok: false,
      error: 'root_public_key_mismatch',
    });
    expect(verifyHubEnrollProof({ ...base, enrollPk: new Uint8Array(32).fill(9) })).toEqual({
      ok: false,
      error: 'enroll_pk_mismatch',
    });
    const tampered = new Uint8Array(signed.sig);
    tampered[0] ^= 0xff;
    expect(verifyHubEnrollProof({ ...base, sig: tampered })).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });

  it('拿别人的根公钥签自己的名字也过不了', () => {
    const forged = signHubEnrollProof(
      { publicKey: rootKey.publicKey, sign: (msg) => otherKey.sign(msg) },
      { hubHost: HOST, uid: UID, enrollPk: ENROLL_PK, ts: TS }
    );
    expect(
      verifyHubEnrollProof({
        bytes: forged.bytes,
        sig: forged.sig,
        hubHost: HOST,
        rootPublicKey: rootKey.publicKey,
        enrollPk: ENROLL_PK,
      })
    ).toEqual({ ok: false, error: 'bad_signature' });
  });

  it('传 now 时按 ±5 分钟判定时间窗', () => {
    const signed = signHubEnrollProof(rootKey, {
      hubHost: HOST,
      uid: UID,
      enrollPk: ENROLL_PK,
      ts: TS,
    });
    const args = {
      bytes: signed.bytes,
      sig: signed.sig,
      hubHost: HOST,
      rootPublicKey: rootKey.publicKey,
      enrollPk: ENROLL_PK,
    };
    expect(verifyHubEnrollProof({ ...args, now: TS + HUB_ENROLL_PROOF_MAX_SKEW_MS }).ok).toBe(true);
    expect(verifyHubEnrollProof({ ...args, now: TS + HUB_ENROLL_PROOF_MAX_SKEW_MS + 1 })).toEqual({
      ok: false,
      error: 'ts_skew',
    });
    expect(verifyHubEnrollProof({ ...args, now: TS - HUB_ENROLL_PROOF_MAX_SKEW_MS - 1 })).toEqual({
      ok: false,
      error: 'ts_skew',
    });
    expect(verifyHubEnrollProof({ ...args }).ok).toBe(true);
  });

  it('畸形字节被识别', () => {
    expect(
      verifyHubEnrollProof({
        bytes: new Uint8Array([1, 2, 3]),
        sig: new Uint8Array(64),
        hubHost: HOST,
        rootPublicKey: rootKey.publicKey,
        enrollPk: ENROLL_PK,
      }).ok
    ).toBe(false);
    expect(() =>
      encodeHubEnrollProof({
        hubHost: '',
        uid: UID,
        rootPublicKey: rootKey.publicKey,
        enrollPk: ENROLL_PK,
        ts: 1,
      })
    ).toThrow();
    expect(() =>
      encodeHubEnrollProof({
        hubHost: HOST,
        uid: UID,
        rootPublicKey: new Uint8Array(31),
        enrollPk: ENROLL_PK,
        ts: 1,
      })
    ).toThrow();
  });
});
