import { describe, expect, it } from 'bun:test';
import { encodeBase64url, hexToBytes, randomBytes } from '../auth/encoding';
import { generateKdfParams } from '../auth/root-key';
import {
  RELAY_PACK_HKDF_SALT,
  RELAY_PACK_MAX_BYTES,
  RelayPackError,
  kdfParamsFromWire,
  kdfParamsToWire,
  openRelayPack,
  relayPackAad,
  sealRelayPack,
  tenantIdBytes,
} from './relay-pack';

const TENANT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const te = new TextEncoder();

function plaintext(overrides?: Partial<Parameters<typeof sealRelayPack>[0]['plaintext']>) {
  return {
    log_key: randomBytes(32),
    token: randomBytes(32),
    head_seq: 4n,
    head_hash: randomBytes(32),
    issued_at: 1_700_000_000_000n,
    ...overrides,
  };
}

describe('relayPackAad', () => {
  it('绑定 salt 前缀、租户、根公钥与 epoch', () => {
    const rootPk = new Uint8Array(32).fill(7);
    const aad = relayPackAad({ tenantId: TENANT_ID, rootPublicKey: rootPk, rootEpoch: 3 });
    const prefix = te.encode(RELAY_PACK_HKDF_SALT);
    expect(aad.subarray(0, prefix.byteLength)).toEqual(prefix);
    expect(aad.subarray(prefix.byteLength, prefix.byteLength + 16)).toEqual(hexToBytes(TENANT_ID));
    expect(aad.subarray(prefix.byteLength + 16, prefix.byteLength + 48)).toEqual(rootPk);
    expect([...aad.subarray(prefix.byteLength + 48)]).toEqual([3, 0, 0, 0]);
  });

  it('拒绝非法 tenant_id / 根公钥', () => {
    expect(() => tenantIdBytes('ZZ')).toThrow(RelayPackError);
    expect(() =>
      relayPackAad({
        tenantId: TENANT_ID,
        rootPublicKey: new Uint8Array(31),
        rootEpoch: 0,
      })
    ).toThrow(RelayPackError);
  });
});

describe('sealRelayPack / openRelayPack', () => {
  it('round-trip', async () => {
    const seed = randomBytes(32);
    const rootPk = randomBytes(32);
    const body = plaintext();
    const expected = {
      log_key: new Uint8Array(body.log_key),
      token: new Uint8Array(body.token),
      head_hash: new Uint8Array(body.head_hash),
    };
    const sealed = await sealRelayPack({
      rootSeed: seed,
      tenantId: TENANT_ID,
      rootPublicKey: rootPk,
      rootEpoch: 1,
      plaintext: body,
    });
    expect(sealed.byteLength).toBeGreaterThan(12 + 16);
    expect(sealed.byteLength).toBeLessThan(RELAY_PACK_MAX_BYTES);
    const opened = await openRelayPack({
      rootSeed: seed,
      tenantId: TENANT_ID,
      rootPublicKey: rootPk,
      rootEpoch: 1,
      sealedPack: sealed,
    });
    expect(opened.v).toBe(1);
    expect(opened.log_key).toEqual(expected.log_key);
    expect(opened.token).toEqual(expected.token);
    expect(opened.head_seq).toBe(4n);
    expect(opened.head_hash).toEqual(expected.head_hash);
    expect(opened.issued_at).toBe(1_700_000_000_000n);
  });

  it('seal 结束后清零传入的明文密钥缓冲', async () => {
    const logKey = randomBytes(32);
    const token = randomBytes(32);
    expect(logKey.some((b) => b !== 0)).toBe(true);
    expect(token.some((b) => b !== 0)).toBe(true);
    await sealRelayPack({
      rootSeed: randomBytes(32),
      tenantId: TENANT_ID,
      rootPublicKey: randomBytes(32),
      rootEpoch: 0,
      plaintext: {
        log_key: logKey,
        token,
        head_seq: 1n,
        head_hash: randomBytes(32),
        issued_at: 1n,
      },
    });
    expect(logKey.every((b) => b === 0)).toBe(true);
    expect(token.every((b) => b === 0)).toBe(true);
  });

  it('AAD 不符则拒绝', async () => {
    const seed = randomBytes(32);
    const rootPk = randomBytes(32);
    const sealed = await sealRelayPack({
      rootSeed: seed,
      tenantId: TENANT_ID,
      rootPublicKey: rootPk,
      rootEpoch: 1,
      plaintext: plaintext(),
    });
    await expect(
      openRelayPack({
        rootSeed: seed,
        tenantId: TENANT_ID,
        rootPublicKey: rootPk,
        rootEpoch: 2,
        sealedPack: sealed,
      })
    ).rejects.toMatchObject({ name: 'RelayPackError', message: 'pack authentication failed' });
    await expect(
      openRelayPack({
        rootSeed: seed,
        tenantId: 'ffffffffffffffffffffffffffffffff',
        rootPublicKey: rootPk,
        rootEpoch: 1,
        sealedPack: sealed,
      })
    ).rejects.toMatchObject({ name: 'RelayPackError' });
    await expect(
      openRelayPack({
        rootSeed: seed,
        tenantId: TENANT_ID,
        rootPublicKey: randomBytes(32),
        rootEpoch: 1,
        sealedPack: sealed,
      })
    ).rejects.toMatchObject({ name: 'RelayPackError' });
  });

  it('错误 seed 无法解开', async () => {
    const rootPk = randomBytes(32);
    const sealed = await sealRelayPack({
      rootSeed: randomBytes(32),
      tenantId: TENANT_ID,
      rootPublicKey: rootPk,
      rootEpoch: 0,
      plaintext: plaintext(),
    });
    await expect(
      openRelayPack({
        rootSeed: randomBytes(32),
        tenantId: TENANT_ID,
        rootPublicKey: rootPk,
        rootEpoch: 0,
        sealedPack: sealed,
      })
    ).rejects.toMatchObject({ name: 'RelayPackError' });
  });

  it('截断或超大 blob 拒绝', async () => {
    await expect(
      openRelayPack({
        rootSeed: randomBytes(32),
        tenantId: TENANT_ID,
        rootPublicKey: randomBytes(32),
        rootEpoch: 0,
        sealedPack: new Uint8Array(10),
      })
    ).rejects.toMatchObject({ message: 'malformed sealed pack' });
    await expect(
      openRelayPack({
        rootSeed: randomBytes(32),
        tenantId: TENANT_ID,
        rootPublicKey: randomBytes(32),
        rootEpoch: 0,
        sealedPack: new Uint8Array(RELAY_PACK_MAX_BYTES + 1),
      })
    ).rejects.toMatchObject({ message: 'sealed pack exceeds size limit' });
  });
});

describe('kdfParams wire', () => {
  it('round-trip', () => {
    const params = generateKdfParams();
    const wire = kdfParamsToWire(params);
    expect(kdfParamsFromWire(wire)).toEqual(params);
    expect(typeof wire.salt).toBe('string');
    expect(encodeBase64url(params.salt)).toBe(wire.salt);
  });

  it('拒绝畸形入参', () => {
    expect(kdfParamsFromWire(null)).toBeNull();
    expect(
      kdfParamsFromWire({ salt: 'zz', memory_kib: 8, iterations: 1, parallelism: 1 })
    ).toBeNull();
    expect(
      kdfParamsFromWire({
        salt: encodeBase64url(randomBytes(15)),
        memory_kib: 8,
        iterations: 1,
        parallelism: 1,
      })
    ).toBeNull();
    expect(
      kdfParamsFromWire({
        salt: encodeBase64url(randomBytes(16)),
        memory_kib: 0,
        iterations: 1,
        parallelism: 1,
      })
    ).toBeNull();
    expect(
      kdfParamsFromWire({
        salt: encodeBase64url(randomBytes(16)),
        memory_kib: 8,
        iterations: 0,
        parallelism: 1,
      })
    ).toBeNull();
    expect(
      kdfParamsFromWire({
        salt: encodeBase64url(randomBytes(16)),
        memory_kib: 8,
        iterations: 1,
        parallelism: 17,
      })
    ).toBeNull();
    const ok = kdfParamsFromWire({
      salt: encodeBase64url(randomBytes(16)),
      memory_kib: 8,
      iterations: 1,
      parallelism: 1,
    });
    expect(ok?.memory_kib).toBe(8);
    expect(ok?.iterations).toBe(1);
    expect(ok?.parallelism).toBe(1);
  });

  it('rejects params above the client budget', () => {
    expect(
      kdfParamsFromWire({
        salt: encodeBase64url(randomBytes(16)),
        memory_kib: 262_145,
        iterations: 1,
        parallelism: 1,
      })
    ).toBeNull();
    expect(
      kdfParamsFromWire({
        salt: encodeBase64url(randomBytes(16)),
        memory_kib: 8,
        iterations: 11,
        parallelism: 1,
      })
    ).toBeNull();
    expect(
      kdfParamsFromWire({
        salt: encodeBase64url(randomBytes(16)),
        memory_kib: 8,
        iterations: 1,
        parallelism: 5,
      })
    ).toBeNull();
  });
});
