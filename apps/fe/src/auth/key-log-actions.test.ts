import { describe, expect, test } from 'bun:test';
import type { AuthenticationResponseJSON } from '@tmex/api-client/auth/index';
import {
  bytesEqual,
  decodeKeyLogRecord,
  decodePasskeyAssertion,
  decodeRotateRootPayload,
  encodeBase64url,
  generateKdfParams,
  rootKeyFromSeed,
  sha256,
  verifyKeyLogRecord,
} from '@tmex/shared/auth';
import {
  buildRemovePasskeyRecord,
  buildRotateRootRecord,
  headFromResponse,
} from './key-log-actions';

function fill(length: number, value: number): Uint8Array {
  const out = new Uint8Array(length);
  out.fill(value);
  return out;
}

const OLD_ROOT = rootKeyFromSeed(fill(32, 0x11));
const NEW_ROOT = rootKeyFromSeed(fill(32, 0x22));
const HEAD = { seq: 5n, hash: fill(32, 0x77) };
const EPOCH = 2;
const UID = 'alice';

describe('headFromResponse', () => {
  test('seq 支持字符串（u64 越过 Number 安全区时后端会发字符串）', () => {
    const head = headFromResponse({
      seq: '9007199254740993',
      hash: encodeBase64url(fill(32, 0x01)),
      rootEpoch: 3,
      uid: UID,
    });
    expect(head.seq).toBe(9007199254740993n);
    expect(head.hash).toHaveLength(32);
  });
});

describe('rotate-root 记录', () => {
  test('由旧根钥签名，可被共享验签器验证', async () => {
    const newKdfParams = generateKdfParams();
    const record = buildRotateRootRecord({
      head: HEAD,
      rootEpoch: EPOCH,
      uid: UID,
      oldRootKey: OLD_ROOT,
      newRootPublicKey: NEW_ROOT.publicKey,
      newKdfParams,
    });

    const result = await verifyKeyLogRecord(record.bytes, record.sig, {
      head: HEAD,
      rootEpoch: EPOCH,
      rootPublicKey: OLD_ROOT.publicKey,
      resolvePasskey: () => null,
    });
    expect(result.ok).toBe(true);

    const decoded = decodeKeyLogRecord(record.bytes);
    expect(decoded.type).toBe('rotate-root');
    expect(decoded.signer).toBe('root');
    expect(decoded.seq).toBe(6n);
    expect(bytesEqual(decoded.prev_hash, HEAD.hash)).toBe(true);

    const payload = decodeRotateRootPayload(decoded.payload);
    expect(bytesEqual(payload.root_public_key, NEW_ROOT.publicKey)).toBe(true);
    expect(payload.kdf_params.memory_kib).toBe(newKdfParams.memory_kib);
  });

  test('用新根钥验签必须失败（防止把 rotate 记成新钥自签）', async () => {
    const record = buildRotateRootRecord({
      head: HEAD,
      rootEpoch: EPOCH,
      uid: UID,
      oldRootKey: OLD_ROOT,
      newRootPublicKey: NEW_ROOT.publicKey,
      newKdfParams: generateKdfParams(),
    });
    const result = await verifyKeyLogRecord(record.bytes, record.sig, {
      head: HEAD,
      rootEpoch: EPOCH,
      rootPublicKey: NEW_ROOT.publicKey,
      resolvePasskey: () => null,
    });
    expect(result).toEqual({ ok: false, error: 'bad_signature' });
  });
});

describe('passkey 签名的记录', () => {
  test('sig 为 Borsh PasskeyAssertion，challenge = sha256(recordBytes)，只做一次仪式', async () => {
    const challenges: Uint8Array[] = [];
    const assert = async (
      challenge: Uint8Array,
      credentialId: string
    ): Promise<AuthenticationResponseJSON> => {
      challenges.push(challenge);
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: encodeBase64url(fill(4, 0xaa)),
          authenticatorData: encodeBase64url(fill(4, 0xbb)),
          signature: encodeBase64url(fill(64, 0xcc)),
        },
      };
    };

    const record = await buildRemovePasskeyRecord({
      head: HEAD,
      rootEpoch: EPOCH,
      uid: UID,
      credentialId: 'cred-1',
      signer: { kind: 'passkey', credentialId: 'cred-2', assert },
    });

    expect(challenges).toHaveLength(1);
    expect(bytesEqual(challenges[0], sha256(record.bytes))).toBe(true);

    const decoded = decodeKeyLogRecord(record.bytes);
    expect(decoded.signer).toBe('passkey');
    expect(decoded.credential_id).toBe('cred-2');

    const assertion = decodePasskeyAssertion(record.sig);
    expect(assertion.credential_id).toBe('cred-2');
    expect(assertion.client_data_json).toHaveLength(4);
    expect(assertion.signature).toHaveLength(64);
  });

  test('认证器返回了别的 credential 时报错', async () => {
    const assert = async (): Promise<AuthenticationResponseJSON> => ({
      id: 'other',
      rawId: 'other',
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: encodeBase64url(fill(1, 1)),
        authenticatorData: encodeBase64url(fill(1, 2)),
        signature: encodeBase64url(fill(1, 3)),
      },
    });

    await expect(
      buildRemovePasskeyRecord({
        head: HEAD,
        rootEpoch: EPOCH,
        uid: UID,
        credentialId: 'cred-1',
        signer: { kind: 'passkey', credentialId: 'cred-2', assert },
      })
    ).rejects.toThrow('passkey assertion credential mismatch');
  });
});
