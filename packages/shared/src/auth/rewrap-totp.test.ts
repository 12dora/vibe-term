import { describe, expect, it } from 'bun:test';
import { bytesEqual, bytesToHex, encodeTotpAad } from './encoding';
import { rewrapTotpSecret } from './rewrap-totp';
import {
  ARGON2ID_HASH_LENGTH,
  ARGON2ID_ITERATIONS,
  ARGON2ID_MEMORY_KIB,
  ARGON2ID_PARALLELISM,
  KDF_SALT_LENGTH,
} from './root-key';
import { TOTP_DEFAULT_DIGITS, TOTP_DEFAULT_STEP, TOTP_SALT_PREFIX, deriveTotpKey } from './totp';
import { TOTP_AEAD_ALG, decryptTotpSecret, encryptTotpSecret } from './totp-cipher';

const UID = 'user-1';
const SECRET = new Uint8Array(20).fill(0x7a);
const OLD_SEED = new Uint8Array(32).fill(0x11);
const NEW_SEED = new Uint8Array(32).fill(0x22);
const ROOT_EPOCH = 1;
const TOTP_RECORD_SEQ = 4n;
const NEXT_SEQ = 9n;

describe('locked totp rewrap parameters', () => {
  it('does not change KDF / AEAD / AAD / TOTP wire constants', () => {
    expect(TOTP_SALT_PREFIX).toBe('tmex-totp');
    expect(TOTP_AEAD_ALG).toBe('A256GCM');
    expect(TOTP_DEFAULT_DIGITS).toBe(6);
    expect(TOTP_DEFAULT_STEP).toBe(30);
    expect(KDF_SALT_LENGTH).toBe(16);
    expect(ARGON2ID_MEMORY_KIB).toBe(65536);
    expect(ARGON2ID_ITERATIONS).toBe(3);
    expect(ARGON2ID_PARALLELISM).toBe(1);
    expect(ARGON2ID_HASH_LENGTH).toBe(32);
    expect(bytesToHex(encodeTotpAad({ uid: UID, root_epoch: 2, seq: 9n }))).toBe(
      '06000000757365722d31020000000900000000000000'
    );
    expect(bytesToHex(deriveTotpKey(OLD_SEED, UID, 0))).toBe(
      'f5104f9232dae1a6b6d3a5b60b6263e8a55edf41484e66c7992a451555318e06'
    );
    expect(bytesToHex(deriveTotpKey(OLD_SEED, UID, 1))).toBe(
      '437adb4c3dc6cdaa0c8cc7cd4593aa0db668f1afb41abb9f1366cdd38b756513'
    );
  });
});

describe('rewrapTotpSecret', () => {
  async function wrapCurrent(secret: Uint8Array = SECRET) {
    const kOld = deriveTotpKey(OLD_SEED, UID, ROOT_EPOCH);
    const totp = await encryptTotpSecret(kOld, secret, {
      uid: UID,
      root_epoch: ROOT_EPOCH,
      seq: TOTP_RECORD_SEQ,
    });
    kOld.fill(0);
    return totp;
  }

  it('round-trips: new seed / epoch+1 / nextSeq decrypts with production decryptTotpSecret', async () => {
    const totp = await wrapCurrent();
    expect(totp.alg).toBe(TOTP_AEAD_ALG);
    expect(totp.nonce.length).toBe(12);
    expect(totp.tag.length).toBe(16);

    const rewrapped = await rewrapTotpSecret({
      uid: UID,
      oldSeed: OLD_SEED,
      newSeed: NEW_SEED,
      rootEpoch: ROOT_EPOCH,
      totpRecordSeq: TOTP_RECORD_SEQ,
      totp,
      nextSeq: NEXT_SEQ,
    });

    expect(rewrapped.root_epoch).toBe(ROOT_EPOCH + 1);
    expect(rewrapped.seq).toBe(NEXT_SEQ);
    expect(rewrapped.payload.alg).toBe(TOTP_AEAD_ALG);
    expect(rewrapped.payload.nonce.length).toBe(12);
    expect(rewrapped.payload.tag.length).toBe(16);

    const kNew = deriveTotpKey(NEW_SEED, UID, ROOT_EPOCH + 1);
    const plain = await decryptTotpSecret(kNew, rewrapped.payload, {
      uid: UID,
      root_epoch: ROOT_EPOCH + 1,
      seq: NEXT_SEQ,
    });
    expect(bytesEqual(plain, SECRET)).toBe(true);
  });

  it('rejects a wrong old seed', async () => {
    const totp = await wrapCurrent();
    const wrongOld = new Uint8Array(32).fill(0x99);
    await expect(
      rewrapTotpSecret({
        uid: UID,
        oldSeed: wrongOld,
        newSeed: NEW_SEED,
        rootEpoch: ROOT_EPOCH,
        totpRecordSeq: TOTP_RECORD_SEQ,
        totp,
        nextSeq: NEXT_SEQ,
      })
    ).rejects.toBeDefined();
  });

  it('old key and old AAD cannot decrypt the rewrapped payload', async () => {
    const totp = await wrapCurrent();
    const rewrapped = await rewrapTotpSecret({
      uid: UID,
      oldSeed: OLD_SEED,
      newSeed: NEW_SEED,
      rootEpoch: ROOT_EPOCH,
      totpRecordSeq: TOTP_RECORD_SEQ,
      totp,
      nextSeq: NEXT_SEQ,
    });
    const kOld = deriveTotpKey(OLD_SEED, UID, ROOT_EPOCH);
    await expect(
      decryptTotpSecret(kOld, rewrapped.payload, {
        uid: UID,
        root_epoch: ROOT_EPOCH,
        seq: TOTP_RECORD_SEQ,
      })
    ).rejects.toBeDefined();
    const kNew = deriveTotpKey(NEW_SEED, UID, ROOT_EPOCH + 1);
    await expect(
      decryptTotpSecret(kNew, rewrapped.payload, {
        uid: UID,
        root_epoch: ROOT_EPOCH,
        seq: TOTP_RECORD_SEQ,
      })
    ).rejects.toBeDefined();
  });
});
