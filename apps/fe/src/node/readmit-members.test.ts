// 重新确认成员：签名者由授权字节决定、逐条串行、首条失败即停、空列表是无操作。

import { describe, expect, test } from 'bun:test';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { AuthApi, AuthenticationResponseJSON } from '@tmex/api-client/auth/index';
import { RelayApiError } from '@tmex/api-client/relay/admin-api';
import type { RelayReadmitEntry, RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import {
  DOMAIN_AUTHORIZATION,
  decodeAdmitNodePayload,
  decodeBase64url,
  decodeKeyLogRecord,
  decodePasskeyAssertion,
  deriveSeed,
  encodeAuthorization,
  encodeBase64url,
  rootKeyFromSeed,
  sha256,
  verifyEd25519,
} from '@tmex/shared/auth';
import {
  READMIT_CANCELLED,
  READMIT_MALFORMED,
  READMIT_PREPARE_FAILED,
  READMIT_ROOT_REQUIRED,
  readmitStaleMembers,
} from './readmit-members';

const KDF = { salt: new Uint8Array(16).fill(0x05), memory_kib: 64, iterations: 1, parallelism: 1 };

async function rootKey(password = 'pw') {
  return rootKeyFromSeed(await deriveSeed(password, KDF));
}

function authorization(signer: 'root' | 'passkey', credentialId: string | null = null): Uint8Array {
  return encodeAuthorization({
    domain: DOMAIN_AUTHORIZATION,
    uid: 'u1',
    enroll_pk: new Uint8Array(32).fill(9),
    exp: 1_700_000_000_000n,
    root_epoch: 1,
    signer,
    credential_id: credentialId,
  });
}

function entry(overrides: Partial<RelayReadmitEntry> = {}): RelayReadmitEntry {
  return {
    nodeId: 'ab'.repeat(8),
    name: 'node-1',
    admitSeq: 3,
    admitRootEpoch: 1,
    authorization_bytes: encodeBase64url(authorization('root')),
    certificate_bytes: encodeBase64url(new Uint8Array([1, 2, 3])),
    cert_sig: encodeBase64url(new Uint8Array(64).fill(4)),
    ...overrides,
  };
}

type Appended = { bytes: string; sig: string; hubSync?: boolean };

function authApi(appended: Appended[], results: unknown[] = []): AuthApi {
  let seq = 4;
  return {
    keyLogHead: () => {
      seq += 1;
      return Promise.resolve({ seq, hash: encodeBase64url(new Uint8Array(32).fill(7)) });
    },
    appendKeyLog: (body: { bytes: string; sig: string }, opts?: { hubSync?: boolean }) => {
      appended.push({ ...body, hubSync: opts?.hubSync });
      return Promise.resolve(results[appended.length - 1] ?? { ok: true, hubAck: true });
    },
  } as unknown as AuthApi;
}

function relayApi(entries: RelayReadmitEntry[], calls: { count: number } = { count: 0 }) {
  return {
    readmitPrepare: () => {
      calls.count += 1;
      return Promise.resolve({ rootEpoch: 4, entries });
    },
  } as unknown as RelayTenantApi;
}

const MODE = { uid: 'u1', rootEpoch: 4 };

async function rootSigner(password = 'pw'): Promise<RecordSigner> {
  return { kind: 'root', rootKey: await rootKey(password) };
}

/** 固定的假断言：只回显 challenge，够 `signWithPasskey` 编码成 `PasskeyAssertion`。 */
function passkeySigner(credentialId: string, seen: Uint8Array[]): RecordSigner {
  return {
    kind: 'passkey',
    credentialId,
    assert: (challenge, id) => {
      seen.push(challenge);
      return Promise.resolve({
        id,
        response: {
          clientDataJSON: encodeBase64url(new Uint8Array([1])),
          authenticatorData: encodeBase64url(new Uint8Array([2])),
          signature: encodeBase64url(new Uint8Array([3])),
        },
      } as unknown as AuthenticationResponseJSON);
    },
  };
}

describe('readmitStaleMembers', () => {
  test('逐条签 readmit-node：授权签名由当前根签，证书原样带过去', async () => {
    const appended: Appended[] = [];
    const signer = await rootSigner();
    const result = await readmitStaleMembers({
      api: authApi(appended),
      relayApi: relayApi([entry(), entry({ nodeId: 'cd'.repeat(8) })]),
      mode: MODE,
      lock: (run) => run(),
      signer,
    });

    expect(result).toEqual({ signed: 2, failed: 0, code: null });
    expect(appended).toHaveLength(2);
    expect(appended[0].hubSync).toBe(true);

    const record = decodeKeyLogRecord(decodeBase64url(appended[0].bytes));
    expect(record.type).toBe('readmit-node');
    expect(record.root_epoch).toBe(4);
    const payload = decodeAdmitNodePayload(record.payload);
    expect(payload.certificate_bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(payload.cert_sig).toEqual(new Uint8Array(64).fill(4));
    const pk = (await rootKey()).publicKey;
    expect(verifyEd25519(payload.authorization_sig, payload.authorization_bytes, pk)).toBe(true);

    // 头是逐条重取的：两条记录的 seq 必须连着走。
    const second = decodeKeyLogRecord(decodeBase64url(appended[1].bytes));
    expect(Number(second.seq)).toBe(Number(record.seq) + 1);
  });

  test('没有陈旧成员时不问凭据、不签任何记录', async () => {
    const appended: Appended[] = [];
    let asked = 0;
    const result = await readmitStaleMembers({
      api: authApi(appended),
      relayApi: relayApi([]),
      mode: MODE,
      lock: (run) => run(),
      prompt: {
        request: () => {
          asked += 1;
          return Promise.resolve(null);
        },
      },
    });
    expect(result).toEqual({ signed: 0, failed: 0, code: null });
    expect(asked).toBe(0);
    expect(appended).toHaveLength(0);
  });

  test('没有现成签名者时问一次凭据（admit 用途、可复用）', async () => {
    const appended: Appended[] = [];
    const asked: unknown[] = [];
    const signer = await rootSigner();
    const result = await readmitStaleMembers({
      api: authApi(appended),
      relayApi: relayApi([entry(), entry({ nodeId: 'cd'.repeat(8) })]),
      mode: MODE,
      lock: (run) => run(),
      prompt: {
        request: (options) => {
          asked.push(options);
          return Promise.resolve(signer);
        },
      },
    });
    expect(result.signed).toBe(2);
    expect(asked).toEqual([{ purpose: 'admit', reuse: true }]);
  });

  test('用户取消：一条都不签', async () => {
    const appended: Appended[] = [];
    const result = await readmitStaleMembers({
      api: authApi(appended),
      relayApi: relayApi([entry()]),
      mode: MODE,
      lock: (run) => run(),
      prompt: { request: () => Promise.resolve(null) },
    });
    expect(result).toEqual({ signed: 0, failed: 1, code: READMIT_CANCELLED });
    expect(appended).toHaveLength(0);
  });

  test('全程在写锁里', async () => {
    const order: string[] = [];
    const appended: Appended[] = [];
    await readmitStaleMembers({
      api: authApi(appended),
      relayApi: relayApi([entry()]),
      mode: MODE,
      lock: async (run) => {
        order.push('lock:in');
        const value = await run();
        order.push('lock:out');
        return value;
      },
      signer: await rootSigner(),
    });
    expect(order).toEqual(['lock:in', 'lock:out']);
    expect(appended).toHaveLength(1);
  });

  test('根签的授权不能用通行密钥重签', async () => {
    const appended: Appended[] = [];
    const result = await readmitStaleMembers({
      api: authApi(appended),
      relayApi: relayApi([entry()]),
      mode: MODE,
      lock: (run) => run(),
      signer: passkeySigner('cred-1', []),
    });
    expect(result).toEqual({ signed: 0, failed: 1, code: READMIT_ROOT_REQUIRED });
    expect(appended).toHaveLength(0);
  });

  test('通行密钥签的授权：用授权里那把 credential 断言 sha256(授权字节)', async () => {
    const appended: Appended[] = [];
    const seen: Uint8Array[] = [];
    const authorizationBytes = authorization('passkey', 'cred-1');
    const result = await readmitStaleMembers({
      api: authApi(appended),
      relayApi: relayApi([entry({ authorization_bytes: encodeBase64url(authorizationBytes) })]),
      mode: MODE,
      lock: (run) => run(),
      signer: passkeySigner('cred-1', seen),
    });
    expect(result.signed).toBe(1);
    expect(seen[0]).toEqual(sha256(authorizationBytes));
    const payload = decodeAdmitNodePayload(
      decodeKeyLogRecord(decodeBase64url(appended[0].bytes)).payload
    );
    expect(decodePasskeyAssertion(payload.authorization_sig).credential_id).toBe('cred-1');
  });

  test('授权字节畸形：报 MALFORMED，不签记录', async () => {
    const appended: Appended[] = [];
    const result = await readmitStaleMembers({
      api: authApi(appended),
      relayApi: relayApi([entry({ authorization_bytes: encodeBase64url(new Uint8Array([9])) })]),
      mode: MODE,
      lock: (run) => run(),
      signer: await rootSigner(),
    });
    expect(result).toEqual({ signed: 0, failed: 1, code: READMIT_MALFORMED });
    expect(appended).toHaveLength(0);
  });

  test('首条被拒即停：剩下的都不签，错误码原样带出', async () => {
    const appended: Appended[] = [];
    const result = await readmitStaleMembers({
      api: authApi(appended, [{ ok: false, code: 'KEY_LOG_FORK' }]),
      relayApi: relayApi([entry(), entry({ nodeId: 'cd'.repeat(8) })]),
      mode: MODE,
      lock: (run) => run(),
      signer: await rootSigner(),
    });
    expect(result).toEqual({ signed: 0, failed: 2, code: 'KEY_LOG_FORK' });
    expect(appended).toHaveLength(1);
  });

  test('上级没确认时按未确认报，后面的不再签', async () => {
    const appended: Appended[] = [];
    const result = await readmitStaleMembers({
      api: authApi(appended, [
        { ok: true, hubAck: true },
        { ok: true, hubAck: false, hubError: 'RELAY_OFFLINE' },
      ]),
      relayApi: relayApi([entry(), entry({ nodeId: 'cd'.repeat(8) })]),
      mode: MODE,
      lock: (run) => run(),
      signer: await rootSigner(),
    });
    expect(result).toEqual({ signed: 1, failed: 1, code: 'RELAY_OFFLINE' });
  });

  test('prepare 失败：错误码透传，没有则报 PREPARE_FAILED', async () => {
    const appended: Appended[] = [];
    const failing = (err: unknown) =>
      ({ readmitPrepare: () => Promise.reject(err) }) as unknown as RelayTenantApi;

    const typed = await readmitStaleMembers({
      api: authApi(appended),
      relayApi: failing(new RelayApiError('RELAY_NOT_CONFIGURED', 'none', 409)),
      mode: MODE,
      lock: (run) => run(),
      signer: await rootSigner(),
    });
    expect(typed).toEqual({ signed: 0, failed: 0, code: 'RELAY_NOT_CONFIGURED' });

    const plain = await readmitStaleMembers({
      api: authApi(appended),
      relayApi: failing(new Error('boom')),
      mode: MODE,
      lock: (run) => run(),
      signer: await rootSigner(),
    });
    expect(plain).toEqual({ signed: 0, failed: 0, code: READMIT_PREPARE_FAILED });
    expect(appended).toHaveLength(0);
  });
});
