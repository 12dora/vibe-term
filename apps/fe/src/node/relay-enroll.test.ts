// 中继流程：记录类型 / 锁的用法 / proof 由根钥签 / 密码错不发任何请求 / 错误码透传。

import { describe, expect, test } from 'bun:test';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { RelayApiError } from '@tmex/api-client/relay/admin-api';
import type { RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  deriveSeed,
  encodeBase64url,
  rootKeyFromSeed,
  verifyEd25519,
} from '@tmex/shared/auth';
import { decodeRelayEnrollProof } from '@tmex/shared/relay';
import {
  ROOT_PASSWORD_INVALID,
  alreadyLocked,
  appendMetaKey,
  appendRelayRecord,
  enrollRelay,
  leaveRelay,
} from './relay-enroll';

// 单测用便宜的 argon2 参数（真实参数 64 MiB / t=3 太慢）。
const KDF_JSON = {
  salt: encodeBase64url(new Uint8Array(16).fill(0x05)),
  memory_kib: 64,
  iterations: 1,
  parallelism: 1,
};

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

type Appended = { bytes: string; sig: string; hubSync?: boolean };

function authApi(appended: Appended[], result: unknown = { ok: true, hubAck: true }): AuthApi {
  return {
    keyLogHead: () =>
      Promise.resolve({ seq: 4, hash: encodeBase64url(new Uint8Array(32).fill(7)) }),
    appendKeyLog: (body: { bytes: string; sig: string }, opts?: { hubSync?: boolean }) => {
      appended.push({ ...body, hubSync: opts?.hubSync });
      return Promise.resolve(result);
    },
  } as unknown as AuthApi;
}

const PAYLOAD = encodeBase64url(new Uint8Array([1, 2, 3]));

async function rootSigner(password = 'pw'): Promise<RecordSigner> {
  return { kind: 'root', rootKey: await rootKeyOf(password) };
}

async function modeOf(password = 'pw') {
  const rootKey = await rootKeyOf(password);
  return {
    uid: 'u1',
    rootEpoch: 3,
    kdfParams: KDF_JSON,
    rootPublicKey: encodeBase64url(rootKey.publicKey),
  };
}

describe('appendRelayRecord', () => {
  test('签出的是 set-relays 记录，走 hub=sync，并且在锁里跑', async () => {
    const appended: Appended[] = [];
    let locked = 0;
    const result = await appendRelayRecord(
      {
        api: authApi(appended),
        relayApi: {} as RelayTenantApi,
        mode: await modeOf(),
        lock: (run) => {
          locked += 1;
          return run();
        },
      },
      { type: 'set-relays', payload: PAYLOAD, signer: await rootSigner() }
    );
    expect(result).toEqual({ ok: true });
    expect(locked).toBe(1);
    expect(appended[0].hubSync).toBe(true);
    const record = decodeKeyLogRecord(decodeBase64url(appended[0].bytes));
    expect(record.type).toBe('set-relays');
    expect(record.payload).toEqual(new Uint8Array([1, 2, 3]));
    expect(Number(record.seq)).toBe(5);
  });

  test('hubAck 明确为 false 时报未确认', async () => {
    const appended: Appended[] = [];
    const result = await appendRelayRecord(
      {
        api: authApi(appended, { ok: true, hubAck: false, hubError: 'RELAY_OFFLINE' }),
        relayApi: {} as RelayTenantApi,
        mode: await modeOf(),
        lock: alreadyLocked,
      },
      { type: 'meta-key', payload: PAYLOAD, signer: await rootSigner() }
    );
    expect(result).toEqual({ ok: false, code: 'RELAY_OFFLINE' });
  });

  test('append 被拒时原样带出 code', async () => {
    const result = await appendRelayRecord(
      {
        api: authApi([], { ok: false, code: 'KEY_LOG_FORK' }),
        relayApi: {} as RelayTenantApi,
        mode: await modeOf(),
        lock: alreadyLocked,
      },
      { type: 'meta-key', payload: PAYLOAD, signer: await rootSigner() }
    );
    expect(result).toEqual({ ok: false, code: 'KEY_LOG_FORK' });
  });
});

describe('appendMetaKey', () => {
  test('prepare 的 op 原样送出，payload 包成 meta-key 记录', async () => {
    const appended: Appended[] = [];
    const ops: unknown[] = [];
    const relayApi = {
      metaKeyPrepare: (op: unknown) => {
        ops.push(op);
        return Promise.resolve({ payload: PAYLOAD, payloadHash: 'h' });
      },
    } as unknown as RelayTenantApi;
    const result = await appendMetaKey(
      { api: authApi(appended), relayApi, mode: await modeOf(), lock: alreadyLocked },
      { op: 'rotate', exclude: ['cd'.repeat(16)] },
      await rootSigner()
    );
    expect(result).toEqual({ ok: true });
    expect(ops).toEqual([{ op: 'rotate', exclude: ['cd'.repeat(16)] }]);
    expect(decodeKeyLogRecord(decodeBase64url(appended[0].bytes)).type).toBe('meta-key');
  });

  test('prepare 失败时不签任何记录，错误码透传', async () => {
    const appended: Appended[] = [];
    const relayApi = {
      metaKeyPrepare: () => Promise.reject(new RelayApiError('NO_ADMITTED_NODES', 'none', 409)),
    } as unknown as RelayTenantApi;
    const result = await appendMetaKey(
      { api: authApi(appended), relayApi, mode: await modeOf(), lock: alreadyLocked },
      { op: 'admit', node_id: 'ab'.repeat(16) },
      await rootSigner()
    );
    expect(result).toEqual({ ok: false, code: 'NO_ADMITTED_NODES' });
    expect(appended).toHaveLength(0);
  });
});

describe('enrollRelay', () => {
  test('proof 由根钥签且绑定 relayHost，随后签一条 set-relays', async () => {
    const appended: Appended[] = [];
    const mode = await modeOf();
    const calls: Record<string, unknown> = {};
    const relayApi = {
      proofMaterial: (url: string) => {
        calls.url = url;
        return Promise.resolve({
          url: 'https://r.example',
          relayHost: 'r.example',
          ts: 1_700_000_000_000,
          maxSkewMs: 300_000,
          rootPublicKey: mode.rootPublicKey,
          rootEpoch: 3,
        });
      },
      enroll: (body: unknown) => {
        calls.enroll = body;
        return Promise.resolve({
          tenantId: 'cd'.repeat(16),
          token: 'dA',
          passwordEpoch: 1,
          metaEpoch: 1,
          payload: PAYLOAD,
          payloadHash: 'h',
        });
      },
    } as unknown as RelayTenantApi;

    const result = await enrollRelay(
      { api: authApi(appended), relayApi, mode, lock: alreadyLocked },
      { url: 'https://r.example/', password: 'relay-pw', rootPassword: 'pw' }
    );
    expect(result).toEqual({ ok: true });

    const body = calls.enroll as {
      url: string;
      password: string;
      proof: { bytes: string; sig: string };
    };
    expect(body.url).toBe('https://r.example');
    expect(body.password).toBe('relay-pw');
    const proof = decodeRelayEnrollProof(decodeBase64url(body.proof.bytes));
    expect(proof.relay_host).toBe('r.example');
    expect(proof.domain).toBe('tmex/relay-enroll/v1');
    const rootKey = await rootKeyOf('pw');
    expect(
      verifyEd25519(
        decodeBase64url(body.proof.sig),
        decodeBase64url(body.proof.bytes),
        rootKey.publicKey
      )
    ).toBe(true);
    expect(decodeKeyLogRecord(decodeBase64url(appended[0].bytes)).type).toBe('set-relays');
  });

  test('根密码不对时一个请求都不发', async () => {
    const appended: Appended[] = [];
    let touched = 0;
    const relayApi = {
      proofMaterial: () => {
        touched += 1;
        return Promise.reject(new Error('should not be called'));
      },
    } as unknown as RelayTenantApi;
    const result = await enrollRelay(
      { api: authApi(appended), relayApi, mode: await modeOf('pw'), lock: alreadyLocked },
      { url: 'https://r.example', rootPassword: 'wrong' }
    );
    expect(result).toEqual({ ok: false, code: ROOT_PASSWORD_INVALID });
    expect(touched).toBe(0);
    expect(appended).toHaveLength(0);
  });

  test('中继口令错时把 code 带出来', async () => {
    const mode = await modeOf();
    const relayApi = {
      proofMaterial: () =>
        Promise.resolve({
          url: 'https://r.example',
          relayHost: 'r.example',
          ts: Date.now(),
          maxSkewMs: 300_000,
          rootPublicKey: mode.rootPublicKey,
          rootEpoch: 3,
        }),
      enroll: () =>
        Promise.reject(new RelayApiError('RELAY_PASSWORD_INVALID', 'bad password', 401)),
    } as unknown as RelayTenantApi;
    const result = await enrollRelay(
      { api: authApi([]), relayApi, mode, lock: alreadyLocked },
      { url: 'https://r.example', rootPassword: 'pw' }
    );
    expect(result).toEqual({ ok: false, code: 'RELAY_PASSWORD_INVALID' });
  });
});

describe('leaveRelay', () => {
  test('走 leave/prepare 并签一条 set-relays', async () => {
    const appended: Appended[] = [];
    let prepared = 0;
    const relayApi = {
      leavePrepare: () => {
        prepared += 1;
        return Promise.resolve({ payload: PAYLOAD, payloadHash: 'h' });
      },
    } as unknown as RelayTenantApi;
    const result = await leaveRelay(
      { api: authApi(appended), relayApi, mode: await modeOf(), lock: alreadyLocked },
      await rootSigner()
    );
    expect(result).toEqual({ ok: true });
    expect(prepared).toBe(1);
    expect(decodeKeyLogRecord(decodeBase64url(appended[0].bytes)).type).toBe('set-relays');
  });
});
