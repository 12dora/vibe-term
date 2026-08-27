import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@tmex/api-client';
import { AuthApi } from '@tmex/api-client/auth/index';
import {
  bytesEqual,
  decodeBase64url,
  decodeKeyLogRecord,
  decodeRotateRootPayload,
  decodeSetTotpPayload,
  decryptTotpSecret,
  deriveSeed,
  deriveTotpKey,
  encodeBase64url,
  rootKeyFromSeed,
  verifyKeyLogRecord,
} from '@tmex/shared/auth';
import { changePassword, setTotp } from './account-security-actions';

// 单测用便宜的 argon2 参数（真实参数 64 MiB / t=3 太慢）。
const KDF_JSON = {
  salt: encodeBase64url(new Uint8Array(16).fill(0x05)),
  memory_kib: 64,
  iterations: 1,
  parallelism: 1,
};
const HEAD_HASH = new Uint8Array(32).fill(0x66);
const HEAD_SEQ = 4;
const EPOCH = 3;
const UID = 'alice';

interface Posted {
  bytes: Uint8Array;
  sig: Uint8Array;
}

function mockApi(): { api: AuthApi; posted: Posted[] } {
  const posted: Posted[] = [];
  const client = new ApiClient('', (url, init) => {
    if (url === '/api/auth/keylog/head') {
      return Promise.resolve(
        Response.json({
          seq: HEAD_SEQ,
          hash: encodeBase64url(HEAD_HASH),
          rootEpoch: EPOCH,
          uid: UID,
        })
      );
    }
    if (url === '/api/auth/keylog') {
      const body = JSON.parse(String(init?.body)) as { bytes: string; sig: string };
      posted.push({ bytes: decodeBase64url(body.bytes), sig: decodeBase64url(body.sig) });
      return Promise.resolve(new Response('', { status: 200 }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
  return { api: new AuthApi(client), posted };
}

async function rootKeyOf(password: string) {
  return rootKeyFromSeed(
    await deriveSeed(password, {
      salt: decodeBase64url(KDF_JSON.salt),
      memory_kib: KDF_JSON.memory_kib,
      iterations: KDF_JSON.iterations,
      parallelism: KDF_JSON.parallelism,
    })
  );
}

describe('changePassword', () => {
  test('生成的 rotate-root 记录由旧根钥签，payload 是新根公钥', async () => {
    const { api, posted } = mockApi();
    const result = await changePassword({
      api,
      uid: UID,
      oldPassword: 'old-secret',
      newPassword: 'new-secret',
      currentKdfParams: KDF_JSON,
    });
    expect(result).toEqual({ ok: true });
    expect(posted).toHaveLength(1);

    const oldRoot = await rootKeyOf('old-secret');
    const verified = await verifyKeyLogRecord(posted[0].bytes, posted[0].sig, {
      head: { seq: BigInt(HEAD_SEQ), hash: HEAD_HASH },
      rootEpoch: EPOCH,
      rootPublicKey: oldRoot.publicKey,
      resolvePasskey: () => null,
    });
    expect(verified.ok).toBe(true);

    const record = decodeKeyLogRecord(posted[0].bytes);
    expect(record.type).toBe('rotate-root');
    expect(record.seq).toBe(BigInt(HEAD_SEQ) + 1n);
    const payload = decodeRotateRootPayload(record.payload);
    // 新根公钥必须由「新密码 + payload 里的新 kdf 参数」重新派生得到。
    const newSeed = await deriveSeed('new-secret', payload.kdf_params);
    expect(bytesEqual(payload.root_public_key, rootKeyFromSeed(newSeed).publicKey)).toBe(true);
  }, 20000);
});

describe('setTotp', () => {
  test('密钥用 k_totp 加密，AAD 绑定 uid/epoch/seq，且返回可扫的 otpauth URI', async () => {
    const { api, posted } = mockApi();
    const secret = new Uint8Array(20).fill(0x0f);
    const { result, otpauthUri } = await setTotp({
      api,
      uid: UID,
      password: 'old-secret',
      currentKdfParams: KDF_JSON,
      secret,
    });
    expect(result).toEqual({ ok: true });
    expect(otpauthUri.startsWith('otpauth://totp/tmex:alice?')).toBe(true);

    const record = decodeKeyLogRecord(posted[0].bytes);
    expect(record.type).toBe('set-totp');
    expect(record.signer).toBe('root');

    const seed = await deriveSeed('old-secret', {
      salt: decodeBase64url(KDF_JSON.salt),
      memory_kib: KDF_JSON.memory_kib,
      iterations: KDF_JSON.iterations,
      parallelism: KDF_JSON.parallelism,
    });
    const kTotp = deriveTotpKey(seed, UID, EPOCH);
    const plain = await decryptTotpSecret(kTotp, decodeSetTotpPayload(record.payload), {
      uid: UID,
      root_epoch: EPOCH,
      seq: BigInt(HEAD_SEQ) + 1n,
    });
    expect(plain).toEqual(new Uint8Array(20).fill(0x0f));
  }, 20000);
});
