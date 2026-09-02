import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@tmex/api-client';
import { AuthApi } from '@tmex/api-client/auth/index';
import {
  bytesEqual,
  decodeBase64url,
  decodeKeyLogRecord,
  decodeRotateRootKeepPayload,
  decodeRotateRootPayload,
  decodeSetTotpPayload,
  decryptTotpSecret,
  deriveSeed,
  deriveTotpKey,
  encodeBase64url,
  encodeSetTotpPayload,
  encryptTotpSecret,
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

interface TotpRecordFixture {
  record_seq: number;
  root_epoch: number;
  payload: string;
}

function mockApi(
  options: {
    keylogStatus?: number;
    totpRecord?: TotpRecordFixture;
    totpRecordError?: { status: number; code: string };
  } = {}
): { api: AuthApi; posted: Posted[]; totpRecordCalls: number } {
  const posted: Posted[] = [];
  const counters = { totpRecordCalls: 0 };
  const client = new ApiClient('', (url, init) => {
    if (url === '/api/auth/totp-record') {
      counters.totpRecordCalls += 1;
      const failure = options.totpRecordError ?? { status: 404, code: 'TOTP_NOT_ENABLED' };
      if (!options.totpRecord) {
        return Promise.resolve(Response.json({ code: failure.code }, { status: failure.status }));
      }
      return Promise.resolve(Response.json(options.totpRecord));
    }
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
  return {
    api: new AuthApi(client),
    posted,
    get totpRecordCalls() {
      return counters.totpRecordCalls;
    },
  };
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
  test('fullReset 生成的 rotate-root 记录由旧根钥签，payload 是新根公钥', async () => {
    const { api, posted } = mockApi();
    const result = await changePassword({
      api,
      uid: UID,
      oldPassword: 'old-secret',
      newPassword: 'new-secret',
      currentKdfParams: KDF_JSON,
      fullReset: true,
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

async function seedOf(password: string): Promise<Uint8Array> {
  return deriveSeed(password, {
    salt: decodeBase64url(KDF_JSON.salt),
    memory_kib: KDF_JSON.memory_kib,
    iterations: KDF_JSON.iterations,
    parallelism: KDF_JSON.parallelism,
  });
}

/** 造一条「当前已启用 TOTP」的服务端记录：用旧密码 + 当前 epoch 封装的密文。 */
async function totpRecordFixture(secret: Uint8Array, recordSeq: number) {
  const kOld = deriveTotpKey(await seedOf('old-secret'), UID, EPOCH);
  const payload = await encryptTotpSecret(kOld, secret, {
    uid: UID,
    root_epoch: EPOCH,
    seq: BigInt(recordSeq),
  });
  return {
    record_seq: recordSeq,
    root_epoch: EPOCH,
    payload: encodeBase64url(encodeSetTotpPayload(payload)),
  };
}

describe('常规改密（rotate-root-keep）', () => {
  test('没开 TOTP：payload 的 totp 为 null，且不去要 TOTP 记录', async () => {
    const mock = mockApi();
    const result = await changePassword({
      api: mock.api,
      uid: UID,
      oldPassword: 'old-secret',
      newPassword: 'new-secret',
      currentKdfParams: KDF_JSON,
    });
    expect(result).toMatchObject({ ok: true });
    expect(mock.totpRecordCalls).toBe(0);

    const record = decodeKeyLogRecord(mock.posted[0].bytes);
    expect(record.type).toBe('rotate-root-keep');
    expect(record.seq).toBe(BigInt(HEAD_SEQ) + 1n);
    expect(record.root_epoch).toBe(EPOCH);
    expect(decodeRotateRootKeepPayload(record.payload).totp).toBeNull();

    // 记录仍由旧根钥签名。
    const oldRoot = await rootKeyOf('old-secret');
    const verified = await verifyKeyLogRecord(mock.posted[0].bytes, mock.posted[0].sig, {
      head: { seq: BigInt(HEAD_SEQ), hash: HEAD_HASH },
      rootEpoch: EPOCH,
      rootPublicKey: oldRoot.publicKey,
      resolvePasskey: () => null,
    });
    expect(verified.ok).toBe(true);
  }, 20000);

  test('已开 TOTP：旧密文被解开，按新 seed / epoch+1 / 本条记录 seq 重新封装', async () => {
    const secret = new Uint8Array(20).fill(0x7a);
    const mock = mockApi({ totpRecord: await totpRecordFixture(secret, HEAD_SEQ - 1) });

    const result = await changePassword({
      api: mock.api,
      uid: UID,
      oldPassword: 'old-secret',
      newPassword: 'new-secret',
      currentKdfParams: KDF_JSON,
      totpEnabled: true,
    });
    expect(result).toMatchObject({ ok: true });
    expect(mock.totpRecordCalls).toBe(1);

    const record = decodeKeyLogRecord(mock.posted[0].bytes);
    const payload = decodeRotateRootKeepPayload(record.payload);
    expect(payload.totp?.root_epoch).toBe(EPOCH + 1);
    expect(payload.totp?.seq).toBe(record.seq);

    // 只有「新密码 + 新 kdf 参数」派生出的 k_totp 配上新 AAD 才解得开。
    const newSeed = await deriveSeed('new-secret', payload.kdf_params);
    const kNew = deriveTotpKey(newSeed, UID, EPOCH + 1);
    const plain = await decryptTotpSecret(
      kNew,
      payload.totp?.payload ?? {
        alg: '',
        nonce: new Uint8Array(),
        ciphertext: new Uint8Array(),
        tag: new Uint8Array(),
      },
      { uid: UID, root_epoch: EPOCH + 1, seq: record.seq }
    );
    expect(plain).toEqual(secret);

    // 旧 k_totp / 旧 AAD 一律解不开。
    const kOld = deriveTotpKey(await seedOf('old-secret'), UID, EPOCH);
    await expect(
      decryptTotpSecret(kOld, payload.totp?.payload as never, {
        uid: UID,
        root_epoch: EPOCH + 1,
        seq: record.seq,
      })
    ).rejects.toThrow();
  }, 30000);

  test('服务端说 TOTP 未启用（totpEnabled 已过期）时按没开处理，payload 的 totp 为 null', async () => {
    const mock = mockApi();
    const result = await changePassword({
      api: mock.api,
      uid: UID,
      oldPassword: 'old-secret',
      newPassword: 'new-secret',
      currentKdfParams: KDF_JSON,
      totpEnabled: true,
    });
    expect(result).toMatchObject({ ok: true });
    expect(mock.totpRecordCalls).toBe(1);
    const record = decodeKeyLogRecord(mock.posted[0].bytes);
    expect(record.type).toBe('rotate-root-keep');
    expect(decodeRotateRootKeepPayload(record.payload).totp).toBeNull();
  }, 20000);

  test('TOTP 记录拉不到时不写任何记录，两把根钥照样清零', async () => {
    const mock = mockApi({ totpRecordError: { status: 500, code: 'INTERNAL' } });
    const keys = [
      rootKeyFromSeed(new Uint8Array(32).fill(0x51)),
      rootKeyFromSeed(new Uint8Array(32).fill(0x52)),
    ];
    let calls = 0;

    await expect(
      changePassword({
        api: mock.api,
        uid: UID,
        oldPassword: 'old-secret',
        newPassword: 'new-secret',
        currentKdfParams: KDF_JSON,
        totpEnabled: true,
        deriveRootKey: () => Promise.resolve(keys[calls++]),
      })
    ).rejects.toThrow('INTERNAL');

    expect(mock.posted).toHaveLength(0);
    expect(keys[0].seed.every((byte) => byte === 0)).toBe(true);
    expect(keys[1].seed.every((byte) => byte === 0)).toBe(true);
  });
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
