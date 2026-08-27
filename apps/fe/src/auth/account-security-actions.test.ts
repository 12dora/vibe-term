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
import { totpCode } from '@tmex/shared/auth';
import {
  beginTotpSetup,
  changePassword,
  confirmTotpSetup,
  isPasskeyUsableHere,
  passkeysForOrigin,
  withRootSigner,
} from './account-security-actions';

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

function mockApi(options: { keylogStatus?: number } = {}): { api: AuthApi; posted: Posted[] } {
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
      return Promise.resolve(new Response('', { status: options.keylogStatus ?? 200 }));
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

describe('TOTP 两段式设置', () => {
  const secret = new Uint8Array(20).fill(0x0f);
  const NOW_SEC = 1_700_000_000;

  test('第一段只生成密钥与 URI，不写任何 key-log 记录', () => {
    const { api, posted } = mockApi();
    void api;
    const draft = beginTotpSetup({ uid: UID, issuer: 'tmex', secret });
    expect(draft.otpauthUri.startsWith('otpauth://totp/tmex:alice?')).toBe(true);
    expect(posted).toHaveLength(0);
  });

  test('验证码不对时直接拒绝，仍然不写记录', async () => {
    const { api, posted } = mockApi();
    const outcome = await confirmTotpSetup({
      api,
      uid: UID,
      password: 'old-secret',
      currentKdfParams: KDF_JSON,
      secret,
      code: '000000',
      now: NOW_SEC,
    });
    expect(outcome).toEqual({ ok: false, code: 'TOTP_INVALID' });
    expect(posted).toHaveLength(0);
  }, 20000);

  test('验证码正确后才追加 set-totp：密钥用 k_totp 加密，AAD 绑定 uid/epoch/seq', async () => {
    const { api, posted } = mockApi();
    const outcome = await confirmTotpSetup({
      api,
      uid: UID,
      password: 'old-secret',
      currentKdfParams: KDF_JSON,
      secret,
      code: totpCode(secret, NOW_SEC),
      now: NOW_SEC,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toMatchObject({ ok: true });
    expect(posted).toHaveLength(1);

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

describe('withRootSigner', () => {
  test('回调返回后 seed 立刻清零', async () => {
    let captured: Uint8Array | null = null;
    await withRootSigner('old-secret', KDF_JSON, (signer) => {
      expect(signer.kind).toBe('root');
      if (signer.kind === 'root') captured = signer.rootKey.seed;
      return Promise.resolve(1);
    });
    expect(captured).not.toBeNull();
    expect((captured as unknown as Uint8Array).every((byte) => byte === 0)).toBe(true);
  }, 20000);

  test('回调抛异常也照样清零', async () => {
    let captured: Uint8Array | null = null;
    await expect(
      withRootSigner('old-secret', KDF_JSON, (signer) => {
        if (signer.kind === 'root') captured = signer.rootKey.seed;
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect((captured as unknown as Uint8Array).every((byte) => byte === 0)).toBe(true);
  }, 20000);
});

describe('passkeysForOrigin', () => {
  const rows = [
    { credential_id: 'a', name: 'A', rp_id: 'a.example', origin: 'https://a.example' },
    { credential_id: 'b', name: 'B', rp_id: 'b.example', origin: 'https://b.example' },
  ];

  test('只留当前 origin 的凭证', () => {
    expect(passkeysForOrigin(rows, 'https://b.example').map((row) => row.credential_id)).toEqual([
      'b',
    ]);
  });

  test('rp_id 相同但端口不同（origin 不等）也不算可用——没有 rp_id 回退', () => {
    expect(passkeysForOrigin(rows, 'https://b.example:8443')).toEqual([]);
    expect(passkeysForOrigin(rows, 'https://c.example')).toEqual([]);
  });

  test('服务端下发的 usableHere 优先于前端自己比 origin', () => {
    const served = [
      { ...rows[0], usableHere: true },
      { ...rows[1], usableHere: false },
    ];
    // 反代之后浏览器看到的 origin 未必是断言真正用的那个：服务端说了算。
    expect(passkeysForOrigin(served, 'https://b.example').map((row) => row.credential_id)).toEqual([
      'a',
    ]);
  });

  test('isPasskeyUsableHere：没有 usableHere 时退回 origin 全等', () => {
    expect(isPasskeyUsableHere(rows[0], 'https://a.example')).toBe(true);
    expect(isPasskeyUsableHere(rows[0], 'https://a.example:8443')).toBe(false);
    expect(isPasskeyUsableHere({ ...rows[0], usableHere: false }, 'https://a.example')).toBe(false);
  });
});

describe('changePassword 的根钥所有权', () => {
  test('第二次 Argon2 失败时，旧根钥的 seed 仍然被清零', async () => {
    const { api } = mockApi();
    const oldRootKey = rootKeyFromSeed(new Uint8Array(32).fill(0x21));
    let calls = 0;

    await expect(
      changePassword({
        api,
        uid: UID,
        oldPassword: 'old-secret',
        newPassword: 'new-secret',
        currentKdfParams: KDF_JSON,
        deriveRootKey: (_password, _params) => {
          calls += 1;
          // 第二次派生（新密码）在内存压力下抛出——旧实现的 finally 那时还没建立
          if (calls === 2) return Promise.reject(new Error('argon2 out of memory'));
          return Promise.resolve(oldRootKey);
        },
      })
    ).rejects.toThrow('argon2 out of memory');

    expect(calls).toBe(2);
    expect(oldRootKey.seed.every((byte) => byte === 0)).toBe(true);
  });

  test('成功路径同样清零新旧两把根钥', async () => {
    const { api, posted } = mockApi();
    const keys = [
      rootKeyFromSeed(new Uint8Array(32).fill(0x31)),
      rootKeyFromSeed(new Uint8Array(32).fill(0x32)),
    ];
    let calls = 0;

    const result = await changePassword({
      api,
      uid: UID,
      oldPassword: 'old-secret',
      newPassword: 'new-secret',
      currentKdfParams: KDF_JSON,
      deriveRootKey: () => Promise.resolve(keys[calls++]),
    });

    expect(result).toMatchObject({ ok: true });
    expect(posted).toHaveLength(1);
    expect(keys[0].seed.every((byte) => byte === 0)).toBe(true);
    expect(keys[1].seed.every((byte) => byte === 0)).toBe(true);
  });

  test('append 失败也照样清零', async () => {
    const { api } = mockApi({ keylogStatus: 500 });
    const keys = [
      rootKeyFromSeed(new Uint8Array(32).fill(0x41)),
      rootKeyFromSeed(new Uint8Array(32).fill(0x42)),
    ];
    let calls = 0;

    await changePassword({
      api,
      uid: UID,
      oldPassword: 'old-secret',
      newPassword: 'new-secret',
      currentKdfParams: KDF_JSON,
      deriveRootKey: () => Promise.resolve(keys[calls++]),
    });

    expect(keys[0].seed.every((byte) => byte === 0)).toBe(true);
    expect(keys[1].seed.every((byte) => byte === 0)).toBe(true);
  });
});
